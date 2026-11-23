package com.dsda56180.qualitycenter.scanner

import com.dsda56180.qualitycenter.model.Issue
import com.dsda56180.qualitycenter.model.IssueSource
import com.dsda56180.qualitycenter.model.Severity
import com.dsda56180.qualitycenter.util.Exec
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.util.ArrayDeque
import kotlin.concurrent.thread

object TrivyScanner {

    data class TrivyOptions(
        val executable: String = "",
        /** 自定义扫描目标，留空则自动：优先 target 目录，其次项目根目录 */
        val scanTarget: String? = null,
        val dbRepository: String? = null,
        val javaDbRepository: String? = null,
        /** 未显式配置仓库时优先使用国内镜像，默认 true */
        val preferMirror: Boolean = true,
        /** 低于该等级的漏洞不显示，默认 low（全部显示） */
        val minSeverity: String = "low",
        /** 只显示有修复版本的漏洞，默认 true */
        val onlyFixed: Boolean = true
    )

    data class TrivyResult(
        val issues: MutableList<Issue>,
        val error: String? = null,
        val missing: Boolean = false,
        /** 实际使用的扫描模式，便于界面展示 */
        val mode: String? = null,
        /** 扫描的是否为真实构建产物；false 表示退回源码解析，依赖清单可能不完整 */
        val usedBuildArtifacts: Boolean? = null
    )

    /** 国内网络下官方 ghcr.io 常不可达，默认改用 daocloud 镜像 */
    private const val FALLBACK_DB = "ghcr.m.daocloud.io/aquasecurity/trivy-db"
    private const val FALLBACK_JAVA_DB = "ghcr.m.daocloud.io/aquasecurity/trivy-java-db"

    /** 漏洞库在这个时间内视为新鲜，直接跳过更新检查，避免联网阻塞 */
    private const val DB_FRESH_MS = 12L * 3600 * 1000

    /** 本进程内最近一次尝试更新漏洞库的时间：6 小时内不再重试，避免每次扫描都触发一次大文件下载 */
    @Volatile
    private var lastDbRefresh = 0L
    private const val DB_REFRESH_RETRY_MS = 6L * 3600 * 1000

    private val SEVERITY_RANK: Map<String, Int> = mapOf(
        "info" to 0,
        "low" to 1,
        "medium" to 2,
        "high" to 3,
        "critical" to 4
    )

    private val SEVERITY_RANK_RAW: Map<String, Int> = mapOf(
        "UNKNOWN" to 0,
        "LOW" to 1,
        "MEDIUM" to 2,
        "HIGH" to 3,
        "CRITICAL" to 4
    )

    private fun JsonObject.string(name: String): String? {
        val value = get(name) ?: return null
        if (value.isJsonNull || !value.isJsonPrimitive) {
            return null
        }
        return runCatching { value.asString }.getOrNull()
    }

    private fun JsonObject.number(name: String): Double? {
        val value = get(name) ?: return null
        if (value.isJsonNull || !value.isJsonPrimitive) {
            return null
        }
        return runCatching { value.asDouble }.getOrNull()
    }

    private fun JsonObject.stringList(name: String): List<String> {
        val value = get(name) ?: return emptyList()
        if (!value.isJsonArray) {
            return emptyList()
        }
        return value.asJsonArray.mapNotNull { element ->
            if (element.isJsonPrimitive) runCatching { element.asString }.getOrNull() else null
        }
    }

    /** 从 `trivy --version` 输出中解析某个库的本地下载时间 */
    private fun dbDownloadedAt(text: String, block: String): Long? {
        val start = text.indexOf(block)
        if (start < 0) {
            return null
        }
        val match = Regex("DownloadedAt:\\s*(\\d{4}-\\d{2}-\\d{2})\\s+(\\d{2}:\\d{2}:\\d{2})")
            .find(text.substring(start)) ?: return null
        val date = match.groupValues[1]
        val time = match.groupValues[2]
        return runCatching {
            LocalDateTime.parse("${date}T$time").toInstant(ZoneOffset.UTC).toEpochMilli()
        }.getOrNull()
    }

    private fun isFreshDb(text: String, block: String): Boolean {
        val timestamp = dbDownloadedAt(text, block) ?: return false
        return System.currentTimeMillis() - timestamp < DB_FRESH_MS
    }

    private fun toSeverity(severity: String?): Severity {
        return when (severity?.uppercase() ?: "") {
            "CRITICAL" -> Severity.CRITICAL
            "HIGH" -> Severity.HIGH
            "MEDIUM" -> Severity.MEDIUM
            "LOW" -> Severity.LOW
            else -> Severity.INFO
        }
    }

    private fun pickCvss(vuln: JsonObject): Pair<Double?, String?> {
        val cvss = vuln.getAsJsonObject("CVSS") ?: return null to null
        val v3 = cvss.entrySet().mapNotNull { entry ->
            val obj = entry.value.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
            val score = obj.number("V3Score") ?: return@mapNotNull null
            score to obj.string("V3Vector")
        }.sortedByDescending { it.first }
        if (v3.isNotEmpty()) {
            return v3.first().first to v3.first().second
        }
        val v2 = cvss.entrySet().mapNotNull { entry ->
            val obj = entry.value.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
            val score = obj.number("V2Score") ?: return@mapNotNull null
            score to obj.string("V2Vector")
        }
        return if (v2.isNotEmpty()) v2.first().first to v2.first().second else null to null
    }

    /** 把 CVSS 向量翻译成中文，避免整段描述都是英文 */
    private fun describeVector(vector: String?): String {
        if (vector.isNullOrEmpty()) {
            return ""
        }
        val parts = mutableMapOf<String, String>()
        for (segment in vector.split("/")) {
            val pieces = segment.split(":")
            if (pieces.size >= 2) {
                parts[pieces[0]] = pieces[1]
            }
        }
        val attack = mapOf(
            "N" to "可远程网络攻击",
            "A" to "需同一局域网",
            "L" to "需本地访问",
            "P" to "需物理接触"
        )[parts["AV"] ?: ""]
        val privilege = mapOf(
            "N" to "无需认证",
            "L" to "需普通账号权限",
            "H" to "需管理员权限"
        )[parts["PR"] ?: ""]
        val interaction = mapOf(
            "N" to "无需用户交互",
            "R" to "需用户交互"
        )[parts["UI"] ?: ""]
        val impacts = mutableListOf<String>()
        if ((parts["C"] ?: "N") != "N") {
            impacts.add("机密性")
        }
        if ((parts["I"] ?: "N") != "N") {
            impacts.add("完整性")
        }
        if ((parts["A"] ?: "N") != "N") {
            impacts.add("可用性")
        }
        val impact = if (impacts.isNotEmpty()) "影响${impacts.joinToString("/")}" else null
        return listOfNotNull(attack, privilege, interaction, impact).joinToString("，")
    }

    private fun buildZhSummary(vuln: JsonObject, severity: Severity, score: Double?, vector: String?): String {
        val parts = mutableListOf<String>()
        parts.add("${vuln.string("PkgName") ?: ""} ${vuln.string("InstalledVersion") ?: ""} 命中${severity.label}漏洞")
        if (score != null) {
            parts.add("CVSS $score")
        }
        val described = describeVector(vector)
        if (described.isNotEmpty()) {
            parts.add(described)
        }
        return "${parts.joinToString("，")}。"
    }

    private fun buildAdvice(vuln: JsonObject): String {
        val fixed = vuln.string("FixedVersion") ?: ""
        if (fixed.isEmpty()) {
            return "官方暂未发布修复版本。建议确认项目是否真正使用受影响功能，" +
                "采取隔离、访问控制或关闭相关端点等缓解措施，并持续关注上游更新。"
        }
        return "升级到 $fixed。若是传递依赖，可在 <dependencyManagement> 中显式声明该版本覆盖；" +
            "若受框架 BOM 锁定，需整体升级框架版本。无法立即升级时，请确认是否启用受影响功能，" +
            "必要时关闭相关端点或限制访问来源。"
    }

    private fun truncate(text: String?, limit: Int): String {
        val value = (text ?: "").replace(Regex("\\s+"), " ").trim()
        return if (value.length > limit) "${value.substring(0, limit)}…" else value
    }

    /** 判断目录是否是真实的构建产物（含 jar/pom），避免只残留 site、cachefile 的空 target 被误用 */
    private fun hasBuildArtifacts(dir: File): Boolean {
        return try {
            val stack = ArrayDeque<Pair<File, Int>>()
            stack.add(dir to 0)
            while (stack.isNotEmpty()) {
                val current = stack.pollLast() ?: break
                val entries = current.first.listFiles() ?: continue
                for (entry in entries) {
                    if (entry.isFile && Regex("\\.(jar|pom)$", RegexOption.IGNORE_CASE).containsMatchIn(entry.name)) {
                        return true
                    }
                    if (entry.isDirectory && current.second < 2) {
                        stack.add(entry to current.second + 1)
                    }
                }
            }
            false
        } catch (_: Exception) {
            false
        }
    }

    private class ScanTarget(val target: File, val mode: String)

    private fun pickTarget(root: File, configured: String?): ScanTarget {
        if (!configured.isNullOrEmpty()) {
            val target = if (File(configured).isAbsolute) File(configured) else File(root, configured)
            val usable = target.exists() && target.isDirectory && hasBuildArtifacts(target)
            return if (usable) ScanTarget(target, "rootfs") else ScanTarget(root, "fs")
        }
        val buildDir = File(root, "target")
        if (buildDir.exists() && hasBuildArtifacts(buildDir)) {
            return ScanTarget(buildDir, "rootfs")
        }
        return ScanTarget(root, "fs")
    }

    private fun invoke(
        exe: String,
        mode: String,
        target: File,
        root: File,
        dbRepository: String?,
        javaDbRepository: String?,
        skipVuln: Boolean,
        skipJava: Boolean
    ): Exec.Result {
        val args = mutableListOf(mode, "--format", "json", "--quiet", "--scanners", "vuln", "--timeout", "4m")
        // 本地漏洞库还新鲜时不要检查更新：连不上 ghcr.io 会让扫描阻塞数分钟
        if (skipVuln) {
            args.add("--skip-db-update")
        }
        if (skipJava) {
            args.add("--skip-java-db-update")
        }
        if (!dbRepository.isNullOrEmpty()) {
            args.add("--db-repository")
            args.add(dbRepository)
        }
        if (!javaDbRepository.isNullOrEmpty()) {
            args.add("--java-db-repository")
            args.add(javaDbRepository)
        }
        if (mode == "fs") {
            args.add("--skip-dirs")
            args.add(".git")
            args.add("--skip-dirs")
            args.add("node_modules")
            // 源码模式下 trivy 会联网向 Maven 中央仓库解析 pom 依赖，公共网络下极易触发 429 限流。
            // 加 --offline-scan 后只用本地缓存与本地文件，不再发起任何 API 请求。
            args.add("--offline-scan")
        }
        args.add(target.path)
        // cwd 设为项目根目录：trivy 自动加载根目录的 .trivyignore 忽略清单
        return Exec.run(exe, args, root, 300_000)
    }

    /**
     * 后台更新漏洞库（不阻塞扫描）。国内镜像本身可达，但漏洞库体积很大（解压后约 1.8GB），
     * 下载通常需要数分钟，只能放到扫描结束后在后台做。
     */
    private fun refreshDb(exe: String, root: File, repository: String?, flag: String) {
        val args = mutableListOf("rootfs", flag, "--quiet")
        if (!repository.isNullOrEmpty()) {
            args.add(if (flag == "--download-db-only") "--db-repository" else "--java-db-repository")
            args.add(repository)
        }
        Exec.run(exe, args, root, 10L * 60_000)
    }

    fun scan(root: File, options: TrivyOptions): TrivyResult {
        val exe = Exec.resolveBinary("trivy", options.executable) ?: return TrivyResult(mutableListOf(), missing = true)

        val version = Exec.run(exe, listOf("--version"), root, 30_000)
        if (version.code != 0) {
            return TrivyResult(mutableListOf(), missing = true)
        }

        // 本地库 12 小时内下载过就直接跳过更新检查，避免 ghcr.io 不可达时长时间等待
        val versionText = "${version.stdout}\n${version.stderr}"
        val staleVuln = !isFreshDb(versionText, "Vulnerability DB")
        val staleJava = !isFreshDb(versionText, "Java DB")

        val picked = pickTarget(root, options.scanTarget)
        val target = picked.target
        val mode = picked.mode
        val useMirror = options.preferMirror
        val dbRepository = options.dbRepository?.takeIf { it.isNotEmpty() } ?: if (useMirror) FALLBACK_DB else null
        val javaDbRepository = options.javaDbRepository?.takeIf { it.isNotEmpty() } ?: if (useMirror) FALLBACK_JAVA_DB else null

        // 扫描阶段一律离线使用本地库，绝不等待数据库下载
        val result = invoke(exe, mode, target, root, dbRepository, javaDbRepository, true, true)

        // 扫描结束后再在后台更新过期库，下次扫描自动使用新数据
        val now = System.currentTimeMillis()
        if ((staleVuln || staleJava) && now - lastDbRefresh > DB_REFRESH_RETRY_MS) {
            lastDbRefresh = now
            if (staleVuln) {
                thread(isDaemon = true, name = "quality-center-trivy-db") {
                    refreshDb(exe, root, dbRepository, "--download-db-only")
                }
            }
            if (staleJava) {
                thread(isDaemon = true, name = "quality-center-trivy-java-db") {
                    refreshDb(exe, root, javaDbRepository, "--download-java-db-only")
                }
            }
        }

        val combinedOutput = "${result.stderr}\n${result.stdout}"
        val throttled = Regex("429|too many requests", RegexOption.IGNORE_CASE).containsMatchIn(combinedOutput)
        if (result.code != 0) {
            if (throttled) {
                return TrivyResult(
                    mutableListOf(),
                    mode = mode,
                    usedBuildArtifacts = mode == "rootfs",
                    error = "依赖仓库限流（HTTP 429），已停止联网解析。请先在项目根目录执行 mvn package 生成 target 目录后重新扫描，" +
                        "或等待约 30 分钟解除封禁；期间代码质量与密钥检查不受影响。"
                )
            }
            val detail = result.stderr
                .split(Regex("\\r?\\n"))
                .filter { it.isNotEmpty() }
                .takeLast(4)
                .joinToString("\n")
            val networkIssue = Regex("download|connect|timeout|deadline|no such host", RegexOption.IGNORE_CASE)
                .containsMatchIn(combinedOutput)
            val hint = when {
                networkIssue ->
                    "\n提示：漏洞库下载/更新失败，通常是网络无法访问 ghcr.io。可保持 trivy.preferMirror 开启，" +
                        "或在终端执行 trivy --download-db-only --db-repository ghcr.m.daocloud.io/aquasecurity/trivy-db 预热本地库。"
                mode == "fs" ->
                    "\n提示：先在项目里执行 mvn package 生成 target 目录，可避免联网解析依赖。"
                else -> ""
            }
            return TrivyResult(
                mutableListOf(),
                error = (detail.ifEmpty { "trivy 退出码 ${result.code}" }) + hint,
                mode = mode,
                usedBuildArtifacts = mode == "rootfs"
            )
        }

        val report = try {
            JsonParser.parseString(result.stdout).asJsonObject
        } catch (e: Exception) {
            return TrivyResult(
                mutableListOf(),
                error = "解析 trivy 输出失败：${e.message}",
                mode = mode,
                usedBuildArtifacts = mode == "rootfs"
            )
        }

        val issues = mutableListOf<Issue>()
        val seen = mutableSetOf<String>()
        val minRank = SEVERITY_RANK[options.minSeverity.lowercase()] ?: 1
        val onlyFixed = options.onlyFixed

        val results = report.getAsJsonArray("Results")
        results?.forEach { sectionElement ->
            val section = sectionElement.takeIf { it.isJsonObject }?.asJsonObject ?: return@forEach
            val sectionTarget = section.string("Target") ?: ""
            val vulnerabilities = section.getAsJsonArray("Vulnerabilities") ?: return@forEach
            for (vulnElement in vulnerabilities) {
                val vuln = vulnElement.takeIf { it.isJsonObject }?.asJsonObject ?: continue
                val rawRank = SEVERITY_RANK_RAW[(vuln.string("Severity") ?: "").uppercase()] ?: 0
                if (rawRank < minRank) {
                    continue
                }
                val fixed = vuln.string("FixedVersion") ?: ""
                if (onlyFixed && fixed.isEmpty()) {
                    continue
                }
                // 按 CVE + 组件去重（同一组件可能出现在多个路径）
                val key = "${vuln.string("VulnerabilityID")}|${vuln.string("PkgName")}|${vuln.string("InstalledVersion")}"
                if (seen.contains(key)) {
                    continue
                }
                seen.add(key)

                val candidate = if (sectionTarget.isNotEmpty()) target.resolve(sectionTarget) else null
                val hasFile = candidate != null && candidate.exists() && candidate.isFile
                val severity = toSeverity(vuln.string("Severity"))
                val (score, vector) = pickCvss(vuln)
                val title = vuln.string("Title")?.takeIf { it.isNotEmpty() } ?: vuln.string("Description")
                issues.add(
                    Issue(
                        source = IssueSource.TRIVY,
                        severity = severity,
                        file = if (hasFile) candidate?.path else null,
                        rule = vuln.string("VulnerabilityID")?.takeIf { it.isNotEmpty() } ?: "CVE",
                        message = truncate(title, 200).ifEmpty {
                            vuln.string("VulnerabilityID")?.takeIf { it.isNotEmpty() } ?: "CVE"
                        },
                        packageName = vuln.string("PkgName"),
                        installedVersion = vuln.string("InstalledVersion"),
                        fixedVersion = fixed,
                        link = vuln.string("PrimaryURL"),
                        zhSummary = buildZhSummary(vuln, severity, score, vector),
                        advice = buildAdvice(vuln),
                        title = truncate(vuln.string("Title"), 300),
                        description = truncate(vuln.string("Description"), 800),
                        cvss = score,
                        cvssVector = vector,
                        cwe = vuln.stringList("CweIDs").take(5),
                        references = vuln.stringList("References").take(3),
                        publishedAt = vuln.string("PublishedDate")
                    )
                )
            }
        }

        return TrivyResult(
            issues = issues,
            mode = if (mode == "rootfs") "target 目录（已构建产物）" else "项目根目录（源码解析）",
            usedBuildArtifacts = mode == "rootfs"
        )
    }
}
