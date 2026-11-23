package com.dsda56180.qualitycenter.scanner

import com.dsda56180.qualitycenter.model.Issue
import com.dsda56180.qualitycenter.model.IssueSource
import com.dsda56180.qualitycenter.model.Severity
import com.dsda56180.qualitycenter.util.Exec
import com.dsda56180.qualitycenter.util.Maven
import com.dsda56180.qualitycenter.zh.Localize
import java.io.File
import java.util.ArrayDeque

object SpotbugsScanner {

    /** SpotBugs 4.7.x 是最后一个可在 JDK 8 运行的分析器版本 */
    private const val PLUGIN = "com.github.spotbugs:spotbugs-maven-plugin:4.7.3.0"
    private const val FINDSECBUGS = "com.h3xstream.findsecbugs:findsecbugs-plugin:1.12.0"

    data class SpotbugsResult(
        val issues: MutableList<Issue>,
        val error: String? = null,
        /** 没有编译产物，需要先构建 */
        val needsBuild: Boolean = false,
        val reportFile: String? = null
    )

    private fun decodeEntities(text: String): String {
        return text
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace(Regex("&#(\\d+);")) { m ->
                m.groupValues[1].toIntOrNull()?.toChar()?.toString() ?: m.value
            }
            .replace("&amp;", "&")
    }

    /** SpotBugs 报告里单双引号混用，需要两种都支持 */
    private fun parseAttributes(text: String): Map<String, String> {
        val attrs = mutableMapOf<String, String>()
        for (match in Regex("([\\w:-]+)=['\"]([^'\"]*)['\"]").findAll(text)) {
            attrs[match.groupValues[1]] = decodeEntities(match.groupValues[2])
        }
        return attrs
    }

    private fun pickTag(body: String, tag: String): String {
        val match = Regex("<$tag>([\\s\\S]*?)</$tag>").find(body)
        return if (match != null) decodeEntities(match.groupValues[1]).trim() else ""
    }

    /** SpotBugs priority：1 最高。安全类问题升一级，因为影响面通常更大 */
    private fun toSeverity(category: String, priority: String): Severity {
        val level = (priority.toIntOrNull() ?: 0).takeIf { it != 0 } ?: 3
        val base = when {
            level <= 1 -> Severity.HIGH
            level == 2 -> Severity.MEDIUM
            else -> Severity.LOW
        }
        if (category == "SECURITY") {
            return when (base) {
                Severity.HIGH -> Severity.CRITICAL
                Severity.MEDIUM -> Severity.HIGH
                else -> Severity.MEDIUM
            }
        }
        return base
    }

    /** 检查是否有可分析的字节码，避免在未构建的项目上白跑一次 Maven */
    private fun hasClasses(dir: File): Boolean {
        val stack = ArrayDeque<Pair<File, Int>>()
        stack.add(dir to 0)
        while (stack.isNotEmpty()) {
            val current = stack.pollLast() ?: break
            val entries = current.first.listFiles() ?: continue
            for (entry in entries) {
                if (entry.isFile && entry.name.endsWith(".class")) {
                    return true
                }
                if (entry.isDirectory && current.second < 8) {
                    stack.add(entry to current.second + 1)
                }
            }
        }
        return false
    }

    private fun resolveSourceFile(root: File, srcDirs: List<String>, sourcepath: String): String? {
        if (sourcepath.isEmpty()) {
            return null
        }
        val candidates = if (File(sourcepath).isAbsolute) {
            listOf(File(sourcepath))
        } else {
            srcDirs.map { File(it, sourcepath) } +
                File(root, "src${File.separator}main${File.separator}java${File.separator}$sourcepath")
        }
        return candidates.firstOrNull { it.exists() }?.path
    }

    fun scan(root: File): SpotbugsResult {
        val classesDir = File(root, "target${File.separator}classes")
        if (!classesDir.exists() || !hasClasses(classesDir)) {
            return SpotbugsResult(mutableListOf(), needsBuild = true)
        }

        val reportFile = File(root, "target${File.separator}spotbugsXml.xml")
        try {
            if (reportFile.exists()) {
                reportFile.delete()
            }
        } catch (_: Exception) {
            // 删除失败不影响后续执行，插件会覆盖写入
        }

        val result = Exec.run(
            "mvn",
            listOf(
                "-B",
                "-q"
            ) + Maven.mirrorArgs() + listOf(
                "$PLUGIN:spotbugs",
                "-Dspotbugs.effort=Max",
                "-Dspotbugs.threshold=Low",
                "-Dspotbugs.plugins=$FINDSECBUGS",
                "-Dspotbugs.failOnError=false",
                "-Dspotbugs.consoleOutput=false",
                "-Dspotbugs.xmlOutput=true"
            ),
            root,
            240_000,
            mapOf("MAVEN_OPTS" to "-Dfile.encoding=UTF-8")
        )

        if (!reportFile.exists()) {
            val detail = (if (result.stderr.isNotEmpty()) result.stderr else result.stdout)
                .split(Regex("\\r?\\n"))
                .filter { it.isNotEmpty() }
                .takeLast(5)
                .joinToString("\n")
            return SpotbugsResult(
                mutableListOf(),
                error = detail.ifEmpty { "SpotBugs 未生成报告（退出码 ${result.code}）" }
            )
        }

        val xml = try {
            reportFile.readText(Charsets.UTF_8)
        } catch (e: Exception) {
            return SpotbugsResult(mutableListOf(), error = e.message ?: "读取 SpotBugs 报告失败")
        }

        val srcDirs = Regex("<SrcDir>([^<]*)</SrcDir>").findAll(xml)
            .map { decodeEntities(it.groupValues[1]) }
            .toList()

        val issues = mutableListOf<Issue>()
        val seen = mutableSetOf<String>()
        for (bugMatch in Regex("<BugInstance\\b([^>]*)>([\\s\\S]*?)</BugInstance>").findAll(xml)) {
            val attrs = parseAttributes(bugMatch.groupValues[1])
            val body = bugMatch.groupValues[2]
            val type = (attrs["type"] ?: "").ifEmpty { "SpotBugs" }
            val category = attrs["category"] ?: ""
            val longMessage = pickTag(body, "LongMessage")
            val shortMessage = pickTag(body, "ShortMessage")

            // 一个 BugInstance 可能带多个 SourceLine：类声明范围、方法范围、精确行。
            // 优先取 primary='true' 的精确行，避免跳到类声明处。
            val sourceLines = Regex("<SourceLine\\b[^>]*sourcepath=['\"]([^'\"]+)['\"][^>]*>")
                .findAll(body)
                .toList()
            val primary = sourceLines.firstOrNull { Regex("primary=['\"]true['\"]").containsMatchIn(it.value) }
            val precise = sourceLines.filter { Regex("start=['\"]\\d+['\"]").containsMatchIn(it.value) }
            val picked = primary ?: precise.lastOrNull() ?: sourceLines.firstOrNull()
            val sourcepath = picked?.groupValues?.get(1)?.let(::decodeEntities) ?: ""
            val startMatch = picked?.let { Regex("start=['\"](\\d+)['\"]").find(it.value) }
            val line = startMatch?.groupValues?.get(1)?.toIntOrNull() ?: 1

            val key = "$type|$sourcepath|$line|${if (longMessage.isNotEmpty()) longMessage else shortMessage}"
            if (seen.contains(key)) {
                continue
            }
            seen.add(key)

            issues.add(
                Localize.localizeSpotbugs(
                    Issue(
                        source = IssueSource.SPOTBUGS,
                        severity = toSeverity(category, attrs["priority"] ?: "3"),
                        file = resolveSourceFile(root, srcDirs, sourcepath),
                        line = line,
                        column = 1,
                        rule = type,
                        message = if (longMessage.isNotEmpty()) longMessage else if (shortMessage.isNotEmpty()) shortMessage else type,
                        title = if (shortMessage.isNotEmpty()) shortMessage else type,
                        category = category,
                        cwe = (attrs["cweid"] ?: "").takeIf { it.isNotEmpty() }?.let { listOf("CWE-$it") } ?: emptyList()
                    )
                )
            )
        }

        return SpotbugsResult(issues, reportFile = reportFile.path)
    }
}
