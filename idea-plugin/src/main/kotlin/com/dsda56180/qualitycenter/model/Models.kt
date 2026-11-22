package com.dsda56180.qualitycenter.model

/** 扫描来源 */
enum class IssueSource(val id: String, val label: String) {
    CHECKSTYLE("checkstyle", "代码质量"),
    GITLEAKS("gitleaks", "密钥泄露"),
    TRIVY("trivy", "依赖漏洞"),
    SPOTBUGS("spotbugs", "静态缺陷");

    companion object {
        fun from(id: String?): IssueSource? = entries.firstOrNull { it.id == id }
    }
}

/** 风险等级，顺序即排序顺序 */
enum class Severity(val id: String, val label: String) {
    CRITICAL("critical", "严重"),
    HIGH("high", "高危"),
    MEDIUM("medium", "中危"),
    LOW("low", "低危"),
    INFO("info", "提示");

    companion object {
        fun from(id: String?): Severity =
            entries.firstOrNull { it.id.equals(id, ignoreCase = true) } ?: INFO
    }
}

data class Issue(
    val source: IssueSource,
    val severity: Severity,
    val file: String? = null,
    val line: Int? = null,
    val column: Int? = null,
    val rule: String,
    val message: String,
    val packageName: String? = null,
    val installedVersion: String? = null,
    val fixedVersion: String? = null,
    val link: String? = null,
    val zhSummary: String? = null,
    val advice: String? = null,
    val title: String? = null,
    val description: String? = null,
    val cvss: Double? = null,
    val cvssVector: String? = null,
    val cwe: List<String> = emptyList(),
    val references: List<String> = emptyList(),
    val publishedAt: String? = null,
    val category: String? = null
) {
    /** 基线里用于判断同一条问题的唯一标识 */
    fun key(): String {
        val rel = file?.replace('\\', '/') ?: packageName ?: ""
        return listOf(source.id, rule, rel, line?.toString() ?: "", message).joinToString("|")
    }
}

data class ScanError(val source: IssueSource, val message: String)

data class SkippedSource(val source: IssueSource, val reason: String)

/** 基于扫描结果推导出的行动建议 */
data class Suggestion(
    val category: String,
    val title: String,
    val detail: String,
    val impact: Int
)

data class ScanResult(
    val startedAt: Long,
    val finishedAt: Long,
    val issues: MutableList<Issue> = mutableListOf(),
    val ignored: MutableList<Issue> = mutableListOf(),
    val errors: MutableList<ScanError> = mutableListOf(),
    val skipped: MutableList<SkippedSource> = mutableListOf(),
    var suggestions: MutableList<Suggestion> = mutableListOf(),
    var buildHint: String? = null
)

data class ScanProgress(
    val done: Int = 0,
    val total: Int = 0,
    val active: List<String> = emptyList()
)

/** 深度修复 / 依赖升级的阶段进度：每个阶段对应进度条上的一只猫 */
data class StageProgress(
    val label: String,
    val done: Int = 0,
    val total: Int = 1,
    val startedAt: Long = System.currentTimeMillis()
)
