package com.dsda56180.qualitycenter.fix

import com.dsda56180.qualitycenter.model.Issue
import java.io.File

val MODIFIER_ORDER: List<String> = listOf(
    "public",
    "protected",
    "private",
    "abstract",
    "static",
    "final",
    "transient",
    "volatile",
    "synchronized",
    "native",
    "strictfp",
    "default"
)

private val MODIFIER_LINE = Regex(
    "^(\\s*)((?:(?:${MODIFIER_ORDER.joinToString("|")})\\b\\s*)+)([\\s\\S]*)$"
)

/**
 * 按 JLS 建议顺序重排行首修饰符。
 * 无法安全判断（未匹配、单个修饰符、顺序已正确）时返回 null。
 */
fun reorderModifiers(line: String): String? {
    val match = MODIFIER_LINE.matchEntire(line) ?: return null
    val indent = match.groupValues[1]
    val modifierText = match.groupValues[2]
    val rest = match.groupValues[3]
    val modifiers = modifierText.trim().split(Regex("\\s+"))
    if (modifiers.size < 2) {
        return null
    }
    if (modifiers.any { MODIFIER_ORDER.indexOf(it) < 0 }) {
        return null
    }
    val sorted = modifiers.sortedBy { MODIFIER_ORDER.indexOf(it) }
    if (sorted.joinToString(" ") == modifiers.joinToString(" ")) {
        return null
    }
    val tail = rest.trimStart()
    return if (tail.isNotEmpty()) {
        "$indent${sorted.joinToString(" ")} $tail"
    } else {
        "$indent${sorted.joinToString(" ")}"
    }
}

private val IDENT = "[A-Za-z_${'$'}][\\w${'$'}]*(?:\\.[A-Za-z_${'$'}][\\w${'$'}]*)*"

private val FALSE_EQ_LEFT = Regex("\\bfalse\\s*==\\s*(!?)($IDENT)")
private val TRUE_EQ_LEFT = Regex("\\btrue\\s*==\\s*(!?)($IDENT)")
private val FALSE_NE_LEFT = Regex("\\bfalse\\s*!=\\s*(!?)($IDENT)")
private val TRUE_NE_LEFT = Regex("\\btrue\\s*!=\\s*(!?)($IDENT)")
private val EQ_FALSE_RIGHT = Regex("($IDENT)\\s*==\\s*false\\b")
private val EQ_TRUE_RIGHT = Regex("($IDENT)\\s*==\\s*true\\b")
private val NE_FALSE_RIGHT = Regex("($IDENT)\\s*!=\\s*false\\b")
private val NE_TRUE_RIGHT = Regex("($IDENT)\\s*!=\\s*true\\b")
private val DOUBLE_NEGATION = Regex("!!(?=[A-Za-z_${'$'}(])")

/**
 * 把布尔字面量比较改写为等价表达式：
 *   false == x / x == false / true != x / x != true  →  !x
 *   true  == x / x == true  / false != x / x != false →  x
 * 只处理单行内、不含字符串与注释的语句，其余交给人工或 AI。
 */
fun simplifyBooleanLine(line: String): String? {
    if (line.any { it == '"' || it == '\'' || it == '`' } || line.contains("//") || line.contains("/*")) {
        return null
    }

    var out = line
    // 字面量在左
    out = FALSE_EQ_LEFT.replace(out) { m ->
        val ident = m.groupValues[2]
        if (m.groupValues[1].isNotEmpty()) ident else "!$ident"
    }
    out = TRUE_EQ_LEFT.replace(out) { m ->
        val ident = m.groupValues[2]
        if (m.groupValues[1].isNotEmpty()) "!$ident" else ident
    }
    out = FALSE_NE_LEFT.replace(out) { m ->
        val ident = m.groupValues[2]
        if (m.groupValues[1].isNotEmpty()) "!$ident" else ident
    }
    out = TRUE_NE_LEFT.replace(out) { m ->
        val ident = m.groupValues[2]
        if (m.groupValues[1].isNotEmpty()) ident else "!$ident"
    }
    // 字面量在右
    out = EQ_FALSE_RIGHT.replace(out) { m -> "!${m.groupValues[1]}" }
    out = EQ_TRUE_RIGHT.replace(out) { m -> m.groupValues[1] }
    out = NE_FALSE_RIGHT.replace(out) { m -> m.groupValues[1] }
    out = NE_TRUE_RIGHT.replace(out) { m -> "!${m.groupValues[1]}" }
    // 双否定合并：!!flag → flag
    out = DOUBLE_NEGATION.replace(out, "")

    return if (out == line) null else out
}

/** 可确定性修复的规则：删导入、调整修饰符顺序、简化布尔字面量比较 */
val FIXABLE_RULES: Set<String> = setOf(
    "UnusedImports",
    "RedundantImport",
    "ModifierOrder",
    "SimplifyBooleanExpression"
)

data class FixOutcome(
    val applied: Int,
    val skipped: Int,
    val files: Int
)

fun isFixable(issue: Issue): Boolean =
    FIXABLE_RULES.contains(issue.rule) && !issue.file.isNullOrEmpty() && (issue.line ?: 0) > 0

private data class LineEdit(
    val start: Int,
    val end: Int,
    val replacement: String
)

private fun lineStarts(text: String): List<Int> {
    val starts = mutableListOf(0)
    for (index in text.indices) {
        if (text[index] == '\n') {
            starts.add(index + 1)
        }
    }
    return starts
}

/**
 * 批量应用确定性修复。
 * 同一文件中按行去重，避免重复删除导致编辑区间重叠。
 */
fun applyAutoFixes(issues: List<Issue>): FixOutcome {
    val targets = issues.filter(::isFixable)
    val byFile = LinkedHashMap<String, MutableList<Issue>>()
    for (issue in targets) {
        val file = issue.file ?: continue
        byFile.getOrPut(file) { mutableListOf() }.add(issue)
    }

    var applied = 0
    var skipped = 0
    var files = 0

    for ((path, list) in byFile) {
        val file = File(path)
        val raw = try {
            file.readText()
        } catch (e: Exception) {
            skipped += list.size
            continue
        }

        val starts = lineStarts(raw)
        val lineCount = starts.size
        val edits = mutableListOf<LineEdit>()
        val touchedLines = mutableSetOf<Int>()

        for (issue in list) {
            val line = (issue.line ?: 0) - 1
            if (line < 0 || line >= lineCount || touchedLines.contains(line)) {
                skipped += 1
                continue
            }
            val start = starts[line]
            val lineEnd = if (line + 1 < lineCount) starts[line + 1] else raw.length
            var textEnd = lineEnd
            if (textEnd > start && raw[textEnd - 1] == '\n') {
                textEnd -= 1
            }
            if (textEnd > start && raw[textEnd - 1] == '\r') {
                textEnd -= 1
            }
            val text = raw.substring(start, textEnd)

            if (issue.rule == "ModifierOrder") {
                val fixed = reorderModifiers(text)
                if (fixed == null) {
                    skipped += 1
                    continue
                }
                edits.add(LineEdit(start, textEnd, fixed))
            } else if (issue.rule == "SimplifyBooleanExpression") {
                val fixed = simplifyBooleanLine(text)
                if (fixed == null) {
                    skipped += 1
                    continue
                }
                edits.add(LineEdit(start, textEnd, fixed))
            } else {
                // 删除整行导入（含换行）
                edits.add(LineEdit(start, lineEnd, ""))
            }

            touchedLines.add(line)
            applied += 1
        }

        if (edits.isEmpty()) {
            continue
        }

        var newText = raw
        for (edit in edits.sortedByDescending { it.start }) {
            newText = newText.substring(0, edit.start) + edit.replacement + newText.substring(edit.end)
        }
        val ok = runCatching { file.writeText(newText) }.isSuccess
        if (!ok) {
            applied -= edits.size
            skipped += edits.size
            continue
        }
        files += 1
    }

    return FixOutcome(applied, skipped, files)
}
