package com.dsda56180.qualitycenter.scanner

import com.dsda56180.qualitycenter.model.Issue
import com.dsda56180.qualitycenter.model.IssueSource
import com.dsda56180.qualitycenter.model.Severity
import com.dsda56180.qualitycenter.util.Exec
import com.dsda56180.qualitycenter.util.Maven
import com.dsda56180.qualitycenter.zh.Localize
import java.io.File

object CheckstyleScanner {

    data class CheckstyleResult(val issues: MutableList<Issue>, val error: String? = null)

    private const val PLUGIN = "org.apache.maven.plugins:maven-checkstyle-plugin:3.1.2:checkstyle"

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

    private fun parseAttributes(text: String): Map<String, String> {
        val attrs = mutableMapOf<String, String>()
        for (match in Regex("([\\w:-]+)=\"([^\"]*)\"").findAll(text)) {
            attrs[match.groupValues[1]] = decodeEntities(match.groupValues[2])
        }
        return attrs
    }

    private fun toSeverity(severity: String?): Severity {
        return when (severity?.lowercase() ?: "") {
            "error" -> Severity.HIGH
            "warning" -> Severity.MEDIUM
            "info" -> Severity.LOW
            else -> Severity.MEDIUM
        }
    }

    private fun ruleName(source: String): String {
        if (source.isEmpty()) {
            return "Checkstyle"
        }
        val last = source.split(".").lastOrNull() ?: source
        return last.replace(Regex("Check$"), "")
    }

    /**
     * 按规则类型映射真实风险等级。
     * checkstyle 配置里的 error/warning 只代表规则严格程度，不代表风险高低，
     * 因此对常见规则给出语义化等级，未收录的规则回退到配置映射。
     */
    private val RULE_SEVERITY: Map<String, Severity> = mapOf(
        // 卫生类
        "UnusedImports" to Severity.LOW,
        "RedundantImport" to Severity.LOW,
        "ModifierOrder" to Severity.LOW,
        "EmptyStatement" to Severity.LOW,
        "OneTopLevelClass" to Severity.LOW,
        // 可读性/健壮性
        "SimplifyBooleanExpression" to Severity.MEDIUM,
        "DefaultComesLast" to Severity.MEDIUM,
        // 真实缺陷
        "StringLiteralEquality" to Severity.MEDIUM,
        "EqualsHashCode" to Severity.HIGH,
        "IllegalImport" to Severity.HIGH
    )

    /**
     * 解析规则文件：显式配置 > 项目内常见位置 > 扩展内置默认规则。
     * 内置兜底保证没有任何配置的 Java 项目也能立即出结果，不会因缺规则文件被跳过。
     */
    fun resolveConfig(root: File, configured: String, bundled: File?): File? {
        val candidates = if (configured.isNotEmpty()) {
            listOf(if (File(configured).isAbsolute) File(configured) else File(root, configured))
        } else {
            listOf(
                File(root, ".githooks${File.separator}checkstyle-config.xml"),
                File(root, "checkstyle.xml"),
                File(root, "config${File.separator}checkstyle${File.separator}checkstyle.xml"),
                File(root, "src${File.separator}main${File.separator}resources${File.separator}checkstyle.xml")
            )
        }
        val found = candidates.firstOrNull { it.exists() }
        if (found != null) {
            return found
        }
        return bundled?.takeIf { it.exists() }
    }

    fun scan(root: File, configPath: File, outputFile: File): CheckstyleResult {
        try {
            outputFile.parentFile?.mkdirs()
            if (outputFile.exists()) {
                outputFile.delete()
            }
        } catch (_: Exception) {
            // 输出目录不可写时交给下方报错处理
        }

        val result = Exec.run(
            "mvn",
            listOf(
                "-B",
                "-q"
            ) + Maven.mirrorArgs() + listOf(
                PLUGIN,
                "-Dcheckstyle.config.location=${configPath.path}",
                "-Dcheckstyle.output.file=${outputFile.path}",
                "-Dcheckstyle.consoleOutput=false",
                "-Dcheckstyle.includeTestSourceDirectory=false",
                "-Dcheckstyle.violationSeverity=warning"
            ),
            root,
            300_000,
            mapOf("MAVEN_OPTS" to "-Dfile.encoding=UTF-8")
        )

        if (!outputFile.exists()) {
            val detail = (if (result.stderr.isNotEmpty()) result.stderr else result.stdout)
                .split(Regex("\\r?\\n"))
                .filter { it.isNotEmpty() }
                .takeLast(5)
                .joinToString("\n")
            return CheckstyleResult(
                mutableListOf(),
                detail.ifEmpty { "Checkstyle 未生成报告（退出码 ${result.code}）" }
            )
        }

        val xml = try {
            outputFile.readText(Charsets.UTF_8)
        } catch (e: Exception) {
            return CheckstyleResult(mutableListOf(), e.message ?: "读取 Checkstyle 报告失败")
        }

        val issues = mutableListOf<Issue>()
        for (fileMatch in Regex("<file\\s+name=\"([^\"]*)\">([\\s\\S]*?)</file>").findAll(xml)) {
            val fileName = decodeEntities(fileMatch.groupValues[1])
            val body = fileMatch.groupValues[2]
            for (errorMatch in Regex("<error\\s+([^>]*?)/>").findAll(body)) {
                val attrs = parseAttributes(errorMatch.groupValues[1])
                val rule = ruleName(attrs["source"] ?: "")
                val file = if (File(fileName).isAbsolute) {
                    fileName
                } else {
                    File(root, fileName).path
                }
                val line = (attrs["line"]?.toIntOrNull() ?: 0).takeIf { it != 0 } ?: 1
                val column = (attrs["column"]?.toIntOrNull() ?: 0).takeIf { it != 0 } ?: 1
                issues.add(
                    Localize.localizeCheckstyle(
                        Issue(
                            source = IssueSource.CHECKSTYLE,
                            severity = RULE_SEVERITY[rule] ?: toSeverity(attrs["severity"]),
                            file = file,
                            line = line,
                            column = column,
                            rule = rule,
                            message = (attrs["message"] ?: "").trim()
                        )
                    )
                )
            }
        }

        return CheckstyleResult(issues)
    }
}
