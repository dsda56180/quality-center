package com.dsda56180.qualitycenter.suggest

import com.dsda56180.qualitycenter.model.Issue
import com.dsda56180.qualitycenter.model.IssueSource
import com.dsda56180.qualitycenter.model.ScanResult
import com.dsda56180.qualitycenter.model.Severity
import com.dsda56180.qualitycenter.model.Suggestion
import java.io.File

/** 从扫描结果推导可执行的修复建议（一个动作消掉一片问题的根因） */
object Suggestions {

    /** 框架层组件前缀：这些包大多由 Spring Boot BOM 统一管理，单独升级无效 */
    private val FRAMEWORK_PREFIXES = listOf(
        "spring-",
        "tomcat-embed",
        "jackson-",
        "snakeyaml",
        "logback-",
        "log4j",
        "netty-",
        "hibernate-"
    )

    /** 能由插件直接改写的规则，其余需要语义判断 */
    private val AUTO_FIXABLE_RULES = listOf(
        "UnusedImports",
        "RedundantImport",
        "ModifierOrder",
        "SimplifyBooleanExpression"
    )

    private fun readPom(root: File): String {
        val file = File(root, "pom.xml")
        return if (file.exists()) {
            runCatching { file.readText(Charsets.UTF_8) }.getOrDefault("")
        } else {
            ""
        }
    }

    fun detectSpringBootVersion(pom: String): String? {
        val patterns = listOf(
            Regex("<artifactId>\\s*spring-boot-starter-parent\\s*</artifactId>\\s*<version>\\s*([^<]+?)\\s*</version>"),
            Regex("<artifactId>\\s*spring-boot-dependencies\\s*</artifactId>\\s*<version>\\s*([^<]+?)\\s*</version>")
        )
        for (pattern in patterns) {
            val match = pattern.find(pom)
            if (match != null) {
                return match.groupValues[1].trim()
            }
        }
        return null
    }

    private fun majorMinor(version: String): Pair<Int, Int> {
        val match = Regex("^(\\d+)\\.(\\d+)").find(version) ?: return 0 to 0
        return (match.groupValues[1].toIntOrNull() ?: 0) to (match.groupValues[2].toIntOrNull() ?: 0)
    }

    private fun compareVersions(a: String, b: String): Int {
        val pa = a.split(".", "-").map { it.toIntOrNull() ?: 0 }
        val pb = b.split(".", "-").map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val diff = (pa.getOrNull(i) ?: 0) - (pb.getOrNull(i) ?: 0)
            if (diff != 0) {
                return diff
            }
        }
        return 0
    }

    private fun highestFixed(versions: List<String>): String {
        val parsed = versions
            .flatMap { it.split(",") }
            .map { it.trim() }
            .filter { it.isNotEmpty() }
        if (parsed.isEmpty()) {
            return ""
        }
        return parsed.sortedWith(Comparator<String> { a, b -> compareVersions(a, b) }).last()
    }

    /** 依赖包名形如 groupId:artifactId，框架前缀只对 artifactId 生效 */
    private fun artifactOf(packageName: String): String {
        val index = packageName.lastIndexOf(':')
        return if (index >= 0) packageName.substring(index + 1) else packageName
    }

    private fun isFrameworkPackage(packageName: String): Boolean {
        val artifact = artifactOf(packageName)
        return FRAMEWORK_PREFIXES.any { artifact.startsWith(it) }
    }

    /**
     * 选择升级目标版本：优先同一主次版本号（如 9.0.41 → 9.0.x 最新），
     * 避免跨大版本升级带来的破坏性变更；无同线版本时退到同主版本，最后才取全局最高。
     */
    fun pickFixedVersion(installed: String, fixedValues: List<String>): String {
        val all = LinkedHashSet(
            fixedValues
                .flatMap { it.split(",") }
                .map { it.trim() }
                .filter { it.isNotEmpty() }
        ).toList()
        if (all.isEmpty()) {
            return ""
        }
        val (installedMajor, installedMinor) = majorMinor(installed)
        val sameLine = all.filter { value ->
            val (major, minor) = majorMinor(value)
            major == installedMajor && minor == installedMinor
        }
        if (sameLine.isNotEmpty()) {
            return highestFixed(sameLine)
        }
        val sameMajor = all.filter { majorMinor(it).first == installedMajor }
        if (sameMajor.isNotEmpty()) {
            return highestFixed(sameMajor)
        }
        return highestFixed(all)
    }

    private fun cveSummary(issues: List<Issue>, limit: Int = 3): String {
        return issues.take(limit).map { it.rule }.joinToString("、")
    }

    fun buildSuggestions(root: File, result: ScanResult): MutableList<Suggestion> {
        val suggestions = mutableListOf<Suggestion>()
        val cves = result.issues.filter { it.source == IssueSource.TRIVY }

        if (cves.isNotEmpty()) {
            val bootVersion = detectSpringBootVersion(readPom(root))
            val frameworkCves = if (bootVersion != null) {
                cves.filter { isFrameworkPackage(it.packageName ?: "") }
            } else {
                emptyList()
            }

            if (bootVersion != null) {
                val (major, minor) = majorMinor(bootVersion)
                if (major == 2 && minor < 7) {
                    suggestions.add(
                        Suggestion(
                            category = "framework",
                            title = "升级 Spring Boot $bootVersion → 2.7.18",
                            detail = "当前 Spring Boot 版本已停止维护，内置的 Spring Framework / Tomcat / Jackson / Logback 均存在已知漏洞，" +
                                "仅框架层就命中 ${frameworkCves.size} 条，单独升级子依赖无效（版本被 BOM 锁定）。" +
                                "2.7.18 是最后一个支持 Java 8 的版本，升级后大部分框架层漏洞可一次消除。" +
                                "升级前需跑通单元测试，并检查是否引入 springfox 等已停更组件。",
                            impact = if (frameworkCves.isNotEmpty()) frameworkCves.size else cves.size
                        )
                    )
                } else if (major == 3) {
                    suggestions.add(
                        Suggestion(
                            category = "framework",
                            title = "Spring Boot $bootVersion 建议升级到 3.2.x / 3.3.x 最新补丁",
                            detail = "Spring Boot 3 的小版本补丁会同步升级 Spring Framework、Tomcat、Jackson 等内置组件版本。" +
                                "当前框架层命中 ${frameworkCves.size} 条漏洞，升级补丁版本可在不改动业务代码的前提下消除。",
                            impact = frameworkCves.size
                        )
                    )
                }
            }

            val byPackage = LinkedHashMap<String, MutableList<Issue>>()
            for (issue in cves) {
                val key = issue.packageName?.takeIf { it.isNotEmpty() } ?: issue.rule
                byPackage.getOrPut(key) { mutableListOf() }.add(issue)
            }

            val ranked = byPackage.entries
                .filter { it.value.size >= 2 }
                .sortedByDescending { it.value.size }
                .take(4)

            for ((packageName, items) in ranked) {
                val isFramework = isFrameworkPackage(packageName)
                if (isFramework && bootVersion != null) {
                    // 已由上面的框架升级建议覆盖，避免重复
                    continue
                }
                val installed = items.first().installedVersion ?: ""
                val fixed = pickFixedVersion(installed, items.map { it.fixedVersion ?: "" })
                if (fixed.isEmpty()) {
                    continue
                }
                suggestions.add(
                    Suggestion(
                        category = "dependency",
                        title = "升级依赖 $packageName $installed → $fixed",
                        detail = "该组件命中 ${items.size} 条漏洞（${cveSummary(items)}）。" +
                            "建议优先升到同一版本线内的 $fixed，避免跨大版本引入破坏性变更；" +
                            "若是传递依赖，在 <dependencyManagement> 中显式声明该版本覆盖即可。" +
                            "升级后用 mvn dependency:tree 确认实际生效版本。",
                        impact = items.size
                    )
                )
            }

            if (suggestions.isEmpty()) {
                suggestions.add(
                    Suggestion(
                        category = "manual",
                        title = "${cves.size} 条依赖漏洞需要人工评估",
                        detail = "漏洞分散在多个组件且无统一升级入口，建议先处理「严重 / 高危」条目，" +
                            "逐条复制给 AI 或参考漏洞链接评估实际影响面（是否使用了受影响的 API）。",
                        impact = cves.size
                    )
                )
            } else {
                val covered = suggestions.sumOf { it.impact }
                val residual = cves.size - covered
                if (residual > 0) {
                    suggestions.add(
                        Suggestion(
                            category = "manual",
                            title = "剩余 $residual 条依赖漏洞需单独评估",
                            detail = "这些漏洞分散在低频组件中，无法用一次升级统一解决。" +
                                "建议按「严重 / 高危」优先逐条复制给 AI，确认项目是否真正调用受影响的 API 后再决定是否升级。",
                            impact = residual
                        )
                    )
                }
            }
        }

        val leaks = result.issues.filter { it.source == IssueSource.GITLEAKS }
        if (leaks.isNotEmpty()) {
            suggestions.add(
                Suggestion(
                    category = "secret",
                    title = "处理 ${leaks.size} 处硬编码密钥",
                    detail = "先把密钥值轮换（已进入版本库即视为泄露），再迁移到环境变量或配置中心，" +
                        "代码中只保留占位符。迁移完成前不要把密钥原值提交进任何分支。",
                    impact = leaks.size
                )
            )
        }

        val semantic = result.issues.filter {
            it.source == IssueSource.CHECKSTYLE && !AUTO_FIXABLE_RULES.contains(it.rule)
        }
        if (semantic.isNotEmpty()) {
            suggestions.add(
                Suggestion(
                    category = "manual",
                    title = "${semantic.size} 项代码质量问题需要语义判断",
                    detail = "主要包括 ${cveSummary(semantic)}，改动虽小但要看上下文。" +
                        "在面板中逐条点「复制」，把问题连同位置粘贴给 AI 处理，或人工确认后手动修改。",
                    impact = semantic.size
                )
            )
        }

        val defects = result.issues.filter { it.source == IssueSource.SPOTBUGS }
        if (defects.isNotEmpty()) {
            val security = defects.filter { it.category == "SECURITY" }
            val high = defects.filter { it.severity == Severity.CRITICAL || it.severity == Severity.HIGH }
            suggestions.add(
                Suggestion(
                    category = "manual",
                    title = "处理 ${defects.size} 项字节码级静态缺陷",
                    detail = (if (security.isNotEmpty()) {
                        "其中 ${security.size} 项被 FindSecBugs 判定为安全风险（${cveSummary(security)}）。"
                    } else {
                        ""
                    }) +
                        (if (high.isNotEmpty()) "高危及以上 ${high.size} 项，建议优先处理。" else "") +
                        "这类问题需要看调用上下文，可在「静态缺陷」页逐条复制给 AI 修复，修复后重新编译再扫描确认。",
                    impact = defects.size
                )
            )
        }

        return suggestions.sortedByDescending { it.impact }.toMutableList()
    }
}
