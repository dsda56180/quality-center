package com.dsda56180.qualitycenter.report

import com.dsda56180.qualitycenter.model.Issue
import com.dsda56180.qualitycenter.model.IssueSource
import com.dsda56180.qualitycenter.model.ScanResult
import com.dsda56180.qualitycenter.model.Severity
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** 把扫描结果渲染成 Markdown 报告 */
object Report {

    private val TIME_FORMAT: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyy/M/d HH:mm:ss").withZone(ZoneId.systemDefault())

    private fun rel(root: File, file: String?): String {
        if (file.isNullOrEmpty()) {
            return ""
        }
        return try {
            val base = root.toPath().toAbsolutePath().normalize()
            val target = File(file).toPath().toAbsolutePath().normalize()
            base.relativize(target).toString().replace('\\', '/')
        } catch (_: Exception) {
            file.replace('\\', '/')
        }
    }

    private fun counts(issues: List<Issue>): String {
        val parts = Severity.entries.mapNotNull { severity ->
            val total = issues.count { it.severity == severity }
            if (total > 0) "${severity.label} $total" else null
        }
        return if (parts.isNotEmpty()) parts.joinToString(" / ") else "无问题"
    }

    fun toMarkdown(result: ScanResult, root: File): String {
        val lines = mutableListOf<String>()
        lines.add("# 代码质量与安全报告")
        lines.add("")
        lines.add("- 项目：`${root.path}`")
        lines.add("- 扫描时间：${TIME_FORMAT.format(Instant.ofEpochMilli(result.finishedAt))}")
        lines.add("- 问题总数：${result.issues.size}（${counts(result.issues)}）")
        lines.add("")

        if (result.errors.isNotEmpty()) {
            lines.add("## 扫描异常")
            for (error in result.errors) {
                lines.add("- [${error.source.label}] ${error.message.replace(Regex("\\r?\\n"), " ")}")
            }
            lines.add("")
        }

        if (result.suggestions.isNotEmpty()) {
            lines.add("## 修复建议")
            lines.add("")
            result.suggestions.forEachIndexed { index, item ->
                lines.add("### ${index + 1}. ${item.title}")
                lines.add("")
                lines.add("影响 ${item.impact} 项。${item.detail}")
                lines.add("")
            }
        }

        val trivy = result.issues.filter { it.source == IssueSource.TRIVY }
        if (trivy.isNotEmpty()) {
            lines.add("## 依赖漏洞（CVE）")
            lines.add("")
            lines.add("| 严重度 | 组件 | 当前版本 | 修复版本 | 漏洞编号 | 说明 |")
            lines.add("| --- | --- | --- | --- | --- | --- |")
            for (issue in trivy) {
                val note = (issue.zhSummary?.takeIf { it.isNotEmpty() } ?: issue.message).replace("|", "\\|")
                lines.add(
                    "| ${issue.severity.label} | ${issue.packageName ?: ""} | " +
                        "${issue.installedVersion ?: ""} | ${issue.fixedVersion?.takeIf { it.isNotEmpty() } ?: "暂无"} | " +
                        "${issue.rule} | $note |"
                )
            }
            lines.add("")
        }

        for (source in listOf(IssueSource.GITLEAKS, IssueSource.CHECKSTYLE, IssueSource.SPOTBUGS)) {
            val group = result.issues.filter { it.source == source }
            if (group.isEmpty()) {
                continue
            }
            lines.add("## ${source.label}")
            lines.add("")
            val byFile = LinkedHashMap<String, MutableList<Issue>>()
            for (issue in group) {
                val key = rel(root, issue.file).ifEmpty { "(未知文件)" }
                byFile.getOrPut(key) { mutableListOf() }.add(issue)
            }
            for ((file, items) in byFile) {
                lines.add("### $file")
                for (issue in items) {
                    val location = issue.line?.takeIf { it != 0 }?.let { "第 $it 行" } ?: ""
                    val text = issue.zhSummary?.takeIf { it.isNotEmpty() } ?: issue.message
                    lines.add("- $location（${issue.rule}）：$text")
                    issue.advice?.takeIf { it.isNotEmpty() }?.let {
                        lines.add("  - 修复建议：$it")
                    }
                }
                lines.add("")
            }
        }

        if (result.skipped.isNotEmpty()) {
            lines.add("## 已跳过的检查")
            for (item in result.skipped) {
                lines.add("- ${item.source.label}：${item.reason}")
            }
            lines.add("")
        }

        return lines.joinToString("\n")
    }
}
