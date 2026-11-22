package com.dsda56180.qualitycenter.report

import com.dsda56180.qualitycenter.model.IssueSource
import com.dsda56180.qualitycenter.model.ScanResult
import com.dsda56180.qualitycenter.model.Severity
import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import java.io.File
import java.time.Instant

object AgentExport {

    data class AgentExportResult(val dir: String, val jsonPath: String, val markdownPath: String)

    private val gson = GsonBuilder().setPrettyPrinting().create()

    private fun relative(root: File, file: String?): String {
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

    private fun summarize(result: ScanResult): JsonObject {
        val summary = JsonObject()
        summary.addProperty("total", result.issues.size)
        for (severity in Severity.entries) {
            summary.addProperty(severity.id, result.issues.count { it.severity == severity })
        }
        for (source in listOf(IssueSource.CHECKSTYLE, IssueSource.GITLEAKS, IssueSource.TRIVY, IssueSource.SPOTBUGS)) {
            summary.addProperty(source.id, result.issues.count { it.source == source })
        }
        return summary
    }

    /**
     * 把扫描结果写成 AI agent 可直接读取的结构化文件：
     *   .quality-center/issues.json  —— 机器可读，含完整字段
     *   .quality-center/report.md    —— 人可读
     */
    fun exportForAgent(root: File, result: ScanResult): AgentExportResult {
        val dir = File(root, ".quality-center")
        dir.mkdirs()

        val issuesArray = JsonArray()
        result.issues.forEachIndexed { index, issue ->
            val obj = JsonObject()
            obj.addProperty("id", index + 1)
            obj.addProperty("source", issue.source.id)
            obj.addProperty("sourceLabel", issue.source.label)
            obj.addProperty("severity", issue.severity.id)
            obj.addProperty("severityLabel", issue.severity.label)
            obj.addProperty("file", relative(root, issue.file))
            obj.addProperty("line", issue.line ?: 0)
            obj.addProperty("column", issue.column ?: 0)
            obj.addProperty("rule", issue.rule)
            obj.addProperty("message", issue.message)
            obj.addProperty("package", issue.packageName ?: "")
            obj.addProperty("installedVersion", issue.installedVersion ?: "")
            obj.addProperty("fixedVersion", issue.fixedVersion ?: "")
            obj.addProperty("link", issue.link ?: "")
            obj.addProperty("zhSummary", issue.zhSummary ?: "")
            obj.addProperty("advice", issue.advice ?: "")
            obj.addProperty("title", issue.title ?: "")
            obj.addProperty("cvss", issue.cvss ?: 0.0)
            obj.add("cwe", JsonArray().apply { issue.cwe.orEmpty().forEach { add(it) } })
            obj.addProperty("publishedAt", issue.publishedAt ?: "")
            obj.addProperty("category", issue.category ?: "")
            issuesArray.add(obj)
        }

        val suggestionsArray = JsonArray()
        result.suggestions.forEach { item ->
            suggestionsArray.add(
                JsonObject().apply {
                    addProperty("category", item.category)
                    addProperty("title", item.title)
                    addProperty("detail", item.detail)
                    addProperty("impact", item.impact)
                }
            )
        }

        val errorsArray = JsonArray()
        result.errors.forEach { error ->
            errorsArray.add(
                JsonObject().apply {
                    addProperty("source", error.source.id)
                    addProperty("message", error.message)
                }
            )
        }

        val skippedArray = JsonArray()
        result.skipped.forEach { item ->
            skippedArray.add(
                JsonObject().apply {
                    addProperty("source", item.source.id)
                    addProperty("reason", item.reason)
                }
            )
        }

        val payload = JsonObject().apply {
            addProperty("generatedAt", Instant.ofEpochMilli(result.finishedAt).toString())
            addProperty("projectRoot", root.path)
            add("summary", summarize(result))
            add("suggestions", suggestionsArray)
            addProperty("buildHint", result.buildHint ?: "")
            add("errors", errorsArray)
            add("skipped", skippedArray)
            add("issues", issuesArray)
        }

        val jsonPath = File(dir, "issues.json")
        val markdownPath = File(dir, "report.md")
        jsonPath.writeText(gson.toJson(payload), Charsets.UTF_8)
        markdownPath.writeText(Report.toMarkdown(result, root), Charsets.UTF_8)

        return AgentExportResult(dir.path, jsonPath.path, markdownPath.path)
    }
}
