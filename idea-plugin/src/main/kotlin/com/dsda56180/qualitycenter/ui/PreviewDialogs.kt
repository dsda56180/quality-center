package com.dsda56180.qualitycenter.ui

import com.dsda56180.qualitycenter.upgrade.SkippedUpgrade
import com.dsda56180.qualitycenter.upgrade.UpgradeCandidate
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Splitter
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Cursor
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.BoxLayout
import javax.swing.JCheckBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JTable
import javax.swing.JTextArea
import javax.swing.JTextPane
import javax.swing.table.AbstractTableModel
import javax.swing.table.TableColumn
import javax.swing.text.SimpleAttributeSet
import javax.swing.text.StyleConstants

data class DeepFixPreviewInfo(
    val label: String?,
    val projectText: String,
    val recipes: List<String>,
    val advice: List<String>,
    val dirtyCount: Int,
    val selectable: Boolean,
    val patchText: String?,
    val files: List<String>
)

data class UpgradeDecision(
    val packages: List<String>,
    val versions: Map<String, String>
)

/** 深度修复预览：列出将改动的文件（可勾选）与补丁片段 */
fun showDeepFixPreview(project: Project, info: DeepFixPreviewInfo): List<String>? {
    if (info.files.isEmpty()) {
        return emptyList()
    }
    if (!info.selectable) {
        return info.files
    }
    val dialog = DeepFixPreviewDialog(project, info)
    return if (dialog.showAndGet()) dialog.selectedFiles() else null
}

private class DeepFixPreviewDialog(
    project: Project,
    private val info: DeepFixPreviewInfo
) : DialogWrapper(project, true) {

    private class Row(val path: String, val box: JCheckBox, val panel: JPanel)

    private val rows = mutableListOf<Row>()
    private val diffPane = JTextPane()
    private val diffStyles = DiffStyles()
    private val fileDiffs: Map<String, List<String>> = parsePatch(info.patchText)
    private var selectedPath: String? = null

    init {
        title = info.label?.let { "深度修复预览：$it" } ?: "深度修复预览"
        init()
        setOKButtonText("应用改动")
    }

    fun selectedFiles(): List<String> = rows.filter { it.box.isSelected }.map { it.path }

    override fun createCenterPanel(): JComponent {
        val root = JPanel(BorderLayout(0, JBUI.scale(8)))
        root.preferredSize = Dimension(JBUI.scale(980), JBUI.scale(680))

        val summary = JTextArea().apply {
            isEditable = false
            lineWrap = true
            wrapStyleWord = true
            font = JBUI.Fonts.label()
            background = root.background
            text = buildString {
                appendLine("项目：${info.projectText}")
                appendLine("配方：${info.recipes.joinToString("、")}")
                if (info.dirtyCount > 0) {
                    appendLine("检测到 ${info.dirtyCount} 处未提交改动，执行前会先完整备份。")
                }
                if (info.advice.isNotEmpty()) {
                    appendLine("推荐（未启用）：${info.advice.joinToString("；")}")
                }
                appendLine("共 ${info.files.size} 个文件将被修改：单击文件名查看该文件的 diff，勾选框控制是否应用。")
            }
        }
        root.add(summary, BorderLayout.NORTH)

        val filesPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(2, 4)
            isOpaque = true
            background = root.background
        }
        val baseBackground = root.background
        info.files.forEach { file ->
            val checkBox = JCheckBox("", true).apply { isOpaque = false }
            val label = JLabel(file).apply {
                font = JBUI.Fonts.smallFont()
                cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                toolTipText = file
            }
            val rowPanel = JPanel(BorderLayout(JBUI.scale(4), 0)).apply {
                isOpaque = true
                background = baseBackground
                border = JBUI.Borders.empty(2, 2)
                add(checkBox, BorderLayout.WEST)
                add(label, BorderLayout.CENTER)
            }
            val row = Row(file, checkBox, rowPanel)
            rows += row
            val onClick = object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) = selectRow(row, baseBackground)
            }
            label.addMouseListener(onClick)
            rowPanel.addMouseListener(onClick)
            filesPanel.add(rowPanel)
        }

        val filesScroll = thinScrollPane(filesPanel).apply {
            preferredSize = Dimension(JBUI.scale(980), JBUI.scale(220))
        }

        diffPane.apply {
            isEditable = false
            font = JBUI.Fonts.create("JetBrains Mono", 12)
            background = root.background
            border = JBUI.Borders.empty(4, 6)
        }
        val diffScroll = thinScrollPane(diffPane).apply {
            preferredSize = Dimension(JBUI.scale(980), JBUI.scale(300))
        }

        val split = Splitter(true)
        split.proportion = 0.38f
        split.setShowDividerControls(false)
        split.setShowDividerIcon(false)
        split.firstComponent = filesScroll
        split.secondComponent = diffScroll

        val hint = JLabel("单击文件可查看该文件的代码变更，绿色为新增、红色为删除")
        hint.font = JBUI.Fonts.smallFont()
        hint.foreground = MUTED_FOREGROUND

        val center = JPanel(BorderLayout(0, JBUI.scale(4)))
        center.add(split, BorderLayout.CENTER)
        center.add(hint, BorderLayout.SOUTH)
        root.add(center, BorderLayout.CENTER)

        info.files.firstOrNull()?.let { selectRow(rows.first(), baseBackground) }
        return root
    }

    private fun selectRow(row: Row, baseBackground: java.awt.Color) {
        if (selectedPath == row.path) return
        selectedPath = row.path
        rows.forEach { other ->
            other.panel.background = if (other.path == row.path) ROW_SELECTED_BACKGROUND else baseBackground
            other.panel.repaint()
        }
        renderDiff(row.path)
    }

    private fun renderDiff(path: String) {
        val doc = diffPane.styledDocument
        doc.remove(0, doc.length)
        val lines = fileDiffs.entries
            .firstOrNull { (key, _) ->
                key == path || key.endsWith("/$path") || path.endsWith("/$key")
            }?.value
        if (lines.isNullOrEmpty()) {
            insert(doc, "该文件在当前补丁中没有可显示的差异片段。\n", diffStyles.meta)
            diffPane.caretPosition = 0
            return
        }
        val added = lines.count { it.startsWith("+") && !it.startsWith("+++") }
        val removed = lines.count { it.startsWith("-") && !it.startsWith("---") }
        insert(doc, "$path   +$added / -$removed\n\n", diffStyles.header)
        lines.forEach { line ->
            val style = when {
                line.startsWith("@@") -> diffStyles.hunk
                line.startsWith("diff ") || line.startsWith("index ") ||
                    line.startsWith("---") || line.startsWith("+++") -> diffStyles.meta
                line.startsWith("+") -> diffStyles.add
                line.startsWith("-") -> diffStyles.del
                else -> diffStyles.normal
            }
            insert(doc, line + "\n", style)
        }
        diffPane.caretPosition = 0
    }

    private fun insert(doc: javax.swing.text.StyledDocument, text: String, style: javax.swing.text.AttributeSet) {
        try {
            doc.insertString(doc.length, text, style)
        } catch (_: javax.swing.text.BadLocationException) {
        }
    }

    override fun doValidate(): ValidationInfo? {
        if (rows.none { it.box.isSelected }) {
            return ValidationInfo("请至少选择一个要应用改动的文件", null)
        }
        return null
    }
}

/** diff 逐行着色：新增绿、删除红、hunk 蓝、文件头灰 */
private class DiffStyles {
    private val font = JBUI.Fonts.create("JetBrains Mono", 12)

    val normal = style(JBColor(Color(0x24292F), Color(0xD4D9DF)))
    val add = style(JBColor(Color(0x1B7F3B), Color(0x6EDC93)))
    val del = style(JBColor(Color(0xB4261C), Color(0xFF8078)))
    val hunk = style(JBColor(Color(0x2C6BE0), Color(0x7FA8FF)))
    val meta = style(MUTED_FOREGROUND)
    val header = style(JBColor(Color(0x1F2A33), Color(0xE6E9EC)), bold = true)

    private fun style(fg: Color, bold: Boolean = false): SimpleAttributeSet = SimpleAttributeSet().apply {
        StyleConstants.setForeground(this, fg)
        StyleConstants.setFontFamily(this, font.family)
        StyleConstants.setFontSize(this, font.size)
        StyleConstants.setBold(this, bold)
    }
}

/** 把 git diff 按文件切开，便于逐个文件预览 */
private fun parsePatch(patch: String?): Map<String, List<String>> {
    if (patch.isNullOrBlank()) return emptyMap()
    val result = LinkedHashMap<String, MutableList<String>>()
    var current: MutableList<String>? = null
    patch.lineSequence().forEach { line ->
        if (line.startsWith("diff --git ")) {
            val path = line.split(" ").lastOrNull()?.removePrefix("b/") ?: line
            current = result.getOrPut(path) { mutableListOf() }
            current?.add(line)
        } else {
            current?.add(line)
        }
    }
    return result
}

private val ROW_SELECTED_BACKGROUND = JBColor(Color(0xE8F0FE), Color(0x2E3540))

/** 依赖升级预览：勾选依赖、可改目标版本，确认后写入 pom */
fun showUpgradePreview(
    project: Project,
    entries: List<UpgradeCandidate>,
    skipped: List<SkippedUpgrade>,
    projectText: String
): UpgradeDecision? {
    val dialog = UpgradePreviewDialog(project, entries, skipped, projectText)
    return if (dialog.showAndGet()) dialog.decision() else null
}

private class UpgradePreviewDialog(
    project: Project,
    private val entries: List<UpgradeCandidate>,
    private val skipped: List<SkippedUpgrade>,
    private val projectText: String
) : DialogWrapper(project, true) {

    private val model = UpgradeTableModel(entries.map { UpgradeRow(it, true, it.to) })
    private val table = JTable(model)

    init {
        title = "依赖升级预览"
        init()
        setOKButtonText("升级所选依赖")
    }

    fun decision(): UpgradeDecision {
        val packages = mutableListOf<String>()
        val versions = mutableMapOf<String, String>()
        model.rows.forEach { row ->
            if (row.checked) {
                packages += row.candidate.packageName
                if (row.target.isNotBlank() && row.target != row.candidate.to) {
                    versions[row.candidate.packageName] = row.target.trim()
                }
            }
        }
        return UpgradeDecision(packages, versions)
    }

    override fun createCenterPanel(): JComponent {
        val root = JPanel(BorderLayout(0, JBUI.scale(8)))
        root.preferredSize = Dimension(JBUI.scale(980), JBUI.scale(480))

        val header = JLabel(
            "<html>项目：$projectText &nbsp;·&nbsp; 共 ${entries.size} 个可升级依赖" +
                if (skipped.isEmpty()) "" else "，${skipped.size} 个跳过" + "</html>"
        )
        root.add(header, BorderLayout.NORTH)

        table.setShowGrid(false)
        table.rowHeight = JBUI.scale(26)
        table.tableHeader.reorderingAllowed = false
        table.columnModel.getColumn(0).apply {
            preferredWidth = JBUI.scale(44)
            maxWidth = JBUI.scale(44)
        }
        setColumnWidth(1, 260)
        setColumnWidth(2, 110)
        setColumnWidth(3, 130)
        setColumnWidth(4, 150)
        setColumnWidth(5, 70)
        table.columnModel.getColumn(1).cellRenderer = javax.swing.table.DefaultTableCellRenderer()
        root.add(JBScrollPane(table), BorderLayout.CENTER)

        val skippedText = if (skipped.isEmpty()) "" else buildString {
            append("未列入升级：")
            append(skipped.take(4).joinToString("；") { "${it.packageName}（${it.reason}）" })
            if (skipped.size > 4) append(" 等")
        }
        if (skippedText.isNotEmpty()) {
            val footer = JPanel(FlowLayout(FlowLayout.LEFT)).apply { add(JLabel(skippedText)) }
            root.add(footer, BorderLayout.SOUTH)
        }
        return root
    }

    private fun setColumnWidth(index: Int, width: Int) {
        val column: TableColumn = table.columnModel.getColumn(index)
        column.preferredWidth = JBUI.scale(width)
    }

    override fun doValidate(): ValidationInfo? {
        if (model.rows.none { it.checked }) {
            return ValidationInfo("请至少选择一个要升级的依赖", null)
        }
        if (model.rows.any { it.checked && it.target.isBlank() }) {
            return ValidationInfo("目标版本不能为空", null)
        }
        return null
    }
}

private data class UpgradeRow(
    val candidate: UpgradeCandidate,
    var checked: Boolean,
    var target: String
)

private class UpgradeTableModel(val rows: List<UpgradeRow>) : AbstractTableModel() {
    private val columns = arrayOf("选择", "依赖", "当前版本", "目标版本", "来源", "CVE", "说明")

    override fun getRowCount(): Int = rows.size
    override fun getColumnCount(): Int = columns.size
    override fun getColumnName(column: Int): String = columns[column]
    override fun getColumnClass(columnIndex: Int): Class<*> = if (columnIndex == 0) Boolean::class.javaObjectType else String::class.java
    override fun isCellEditable(rowIndex: Int, columnIndex: Int): Boolean = columnIndex == 0 || columnIndex == 3

    override fun getValueAt(rowIndex: Int, columnIndex: Int): Any {
        val row = rows[rowIndex]
        return when (columnIndex) {
            0 -> row.checked
            1 -> row.candidate.packageName
            2 -> row.candidate.from
            3 -> row.target
            4 -> row.candidate.source
            5 -> row.candidate.cveCount.toString()
            else -> listOfNotNull(
                row.candidate.mode.name.lowercase(),
                row.candidate.note,
                row.candidate.conflicts?.takeIf { it.isNotEmpty() }?.joinToString("；")?.let { "冲突：$it" }
            ).joinToString(" · ")
        }
    }

    override fun setValueAt(value: Any?, rowIndex: Int, columnIndex: Int) {
        val row = rows[rowIndex]
        if (columnIndex == 0) {
            row.checked = value as? Boolean ?: false
        } else if (columnIndex == 3) {
            row.target = value?.toString() ?: row.target
        }
        fireTableCellUpdated(rowIndex, columnIndex)
    }
}
