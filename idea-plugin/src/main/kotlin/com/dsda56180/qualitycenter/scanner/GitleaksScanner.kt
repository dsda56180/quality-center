package com.dsda56180.qualitycenter.scanner

import com.dsda56180.qualitycenter.model.Issue
import com.dsda56180.qualitycenter.model.IssueSource
import com.dsda56180.qualitycenter.model.Severity
import com.dsda56180.qualitycenter.util.Exec
import com.dsda56180.qualitycenter.zh.Localize
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File

object GitleaksScanner {

    data class GitleaksResult(
        val issues: MutableList<Issue>,
        val error: String? = null,
        val missing: Boolean = false
    )

    private fun JsonObject.string(name: String): String? {
        val value = get(name) ?: return null
        if (value.isJsonNull || !value.isJsonPrimitive) {
            return null
        }
        return runCatching { value.asString }.getOrNull()
    }

    private fun JsonObject.int(name: String): Int? {
        val value = get(name) ?: return null
        if (value.isJsonNull || !value.isJsonPrimitive) {
            return null
        }
        return runCatching { value.asInt }.getOrNull()
    }

    fun scan(root: File, executable: String, reportFile: File, configFile: File? = null): GitleaksResult {
        val exe = Exec.resolveBinary("gitleaks", executable) ?: return GitleaksResult(mutableListOf(), missing = true)

        val version = Exec.run(exe, listOf("--version"), root, 20_000)
        if (version.code != 0) {
            return GitleaksResult(mutableListOf(), missing = true)
        }

        try {
            reportFile.parentFile?.mkdirs()
            if (reportFile.exists()) {
                reportFile.delete()
            }
        } catch (_: Exception) {
            // 忽略，交由下方判断
        }

        val args = mutableListOf(
            "detect",
            "--no-git",
            "--source",
            root.path,
            "--redact",
            "--report-format",
            "json",
            "--report-path",
            reportFile.path
        )
        if (configFile != null && configFile.exists()) {
            args.add("--config")
            args.add(configFile.path)
        }

        val result = Exec.run(exe, args, root, 300_000)

        // gitleaks: 0 无问题，1 发现问题，其它为运行错误
        if (result.code != 0 && result.code != 1) {
            val detail = result.stderr
                .split(Regex("\\r?\\n"))
                .filter { it.isNotEmpty() }
                .takeLast(3)
                .joinToString("\n")
            return GitleaksResult(mutableListOf(), error = detail.ifEmpty { "gitleaks 退出码 ${result.code}" })
        }

        if (!reportFile.exists()) {
            return GitleaksResult(mutableListOf())
        }

        val findings = try {
            val raw = reportFile.readText(Charsets.UTF_8).trim()
            if (raw.isEmpty()) {
                emptyList()
            } else {
                JsonParser.parseString(raw).asJsonArray.map { it.asJsonObject }
            }
        } catch (e: Exception) {
            return GitleaksResult(mutableListOf(), error = "解析 gitleaks 报告失败：${e.message}")
        }

        val issues = findings.map { finding ->
            val rel = finding.string("File") ?: ""
            Localize.localizeGitleaks(
                Issue(
                    source = IssueSource.GITLEAKS,
                    severity = Severity.HIGH,
                    file = if (rel.isNotEmpty()) root.resolve(rel).absoluteFile.normalize().path else null,
                    line = (finding.int("StartLine") ?: 0).takeIf { it != 0 } ?: 1,
                    column = (finding.int("StartColumn") ?: 0).takeIf { it != 0 } ?: 1,
                    rule = finding.string("RuleID") ?: "secret",
                    message = finding.string("Description") ?: "检测到疑似硬编码凭证"
                )
            )
        }.toMutableList()

        return GitleaksResult(issues)
    }
}
