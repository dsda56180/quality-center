package com.dsda56180.qualitycenter.baseline

import com.dsda56180.qualitycenter.model.Issue
import com.dsda56180.qualitycenter.model.IssueSource
import com.google.gson.GsonBuilder
import java.io.File
import java.security.MessageDigest
import java.time.Instant

/** 本地基线：把已确认忽略的问题写入 .quality-center/baseline.json，后续扫描不再展示 */
object Baseline {

    data class BaselineEntry(
        val source: String? = null,
        val rule: String? = null,
        val file: String? = null,
        val message: String? = null,
        val createdAt: String? = null
    )

    private data class BaselineFile(
        val version: Int = 1,
        val ignored: MutableMap<String, BaselineEntry> = mutableMapOf()
    )

    data class BaselineSplit(
        val active: MutableList<Issue>,
        val ignored: MutableList<Issue>
    )

    private val gson = GsonBuilder().setPrettyPrinting().create()

    private fun baselinePath(root: File): File =
        File(File(root, ".quality-center"), "baseline.json")

    /** 稳定的问题指纹：不包含行号，代码移动后仍能匹配 */
    fun issueKey(issue: Issue): String {
        if (issue.source == IssueSource.TRIVY) {
            return listOf("trivy", issue.rule, issue.packageName ?: "", issue.installedVersion ?: "").joinToString("|")
        }
        val fingerprint = if (issue.source == IssueSource.GITLEAKS) {
            val digest = MessageDigest.getInstance("SHA-1").digest(issue.message.toByteArray(Charsets.UTF_8))
            digest.joinToString("") { "%02x".format(it) }.take(16)
        } else {
            issue.message.replace(Regex("\\s+"), " ").trim()
        }
        return listOf(issue.source.id, issue.rule, issue.file ?: "", fingerprint).joinToString("|")
    }

    private fun loadBaseline(root: File): BaselineFile {
        return try {
            val raw = baselinePath(root).readText(Charsets.UTF_8)
            val parsed = gson.fromJson(raw, BaselineFile::class.java)
            if (parsed != null && parsed.ignored != null) {
                BaselineFile(parsed.version, parsed.ignored)
            } else {
                BaselineFile()
            }
        } catch (_: Exception) {
            // 文件不存在或损坏时从空基线开始
            BaselineFile()
        }
    }

    private fun saveBaseline(root: File, data: BaselineFile) {
        val file = baselinePath(root)
        file.parentFile?.mkdirs()
        file.writeText(gson.toJson(data), Charsets.UTF_8)
    }

    fun splitByBaseline(root: File, issues: List<Issue>): BaselineSplit {
        val data = loadBaseline(root)
        val active = mutableListOf<Issue>()
        val ignored = mutableListOf<Issue>()
        for (issue in issues) {
            if (data.ignored.containsKey(issueKey(issue))) {
                ignored.add(issue)
            } else {
                active.add(issue)
            }
        }
        return BaselineSplit(active, ignored)
    }

    fun addToBaseline(root: File, issue: Issue) {
        val data = loadBaseline(root)
        data.ignored[issueKey(issue)] = BaselineEntry(
            source = issue.source.id,
            rule = issue.rule,
            file = issue.file,
            message = issue.message,
            createdAt = Instant.now().toString()
        )
        saveBaseline(root, data)
    }

    fun removeFromBaseline(root: File, issue: Issue) {
        val data = loadBaseline(root)
        val key = issueKey(issue)
        if (!data.ignored.containsKey(key)) {
            return
        }
        data.ignored.remove(key)
        saveBaseline(root, data)
    }
}
