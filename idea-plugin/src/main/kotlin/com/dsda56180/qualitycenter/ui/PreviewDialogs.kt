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
import java.awt.CardLayout
import java.awt.Color
import java.awt.Cursor
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.BoxLayout
import javax.swing.ButtonGroup
import javax.swing.JCheckBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JTable
import javax.swing.JTextArea
import javax.swing.JTextPane
import javax.swing.JToggleButton
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
    private val fileDiffs: Map<String, List<String>> = parsePatch(info.patchText)
    private val styles = DiffStyles()
    private var selectedPath: String? = null
    private var baseBackground: Color? = null

    private val unifiedPane = DiffTextPane()
    private val leftPane = DiffTextPane()
    private val rightPane = DiffTextPane()
    private val diffCards = JPanel(CardLayout())
    private val unifiedButton = JToggleButton("统一")
    private val sideButton = JToggleButton("并排")

    init {
        title = info.label?.let { "深度修复预览：$it" } ?: "深度修复预览"
        init()
        setOKButtonText("应用改动")
    }

    fun selectedFiles(): List<String> = rows.filter { it.box.isSelected }.map { it.path }

    override fun createCenterPanel(): JComponent {
        val root = JPanel(BorderLayout(0, JBUI.scale(6)))
        root.preferredSize = Dimension(JBUI.scale(1040), JBUI.scale(720))
        baseBackground = root.background
        listOf(unifiedPane, leftPane, rightPane).forEach { it.background = root.background }

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
                appendLine("共 ${info.files.size} 个文件将被修改：单击文件查看该文件的代码变更，勾选框控制是否应用。")
            }
        }
        root.add(summary, BorderLayout.NORTH)

        val filesPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(2, 4)
            isOpaque = true
            background = root.background
        }
        root.background.let { bg ->
            info.files.forEach { file ->
                val checkBox = JCheckBox("", true).apply {
                    isOpaque = false
                    addItemListener { showFile(file) }
                }
                val label = JLabel(file).apply {
                    font = JBUI.Fonts.smallFont()
                    cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                    toolTipText = file
                }
                val rowPanel = JPanel(BorderLayout(JBUI.scale(4), 0)).apply {
                    isOpaque = true
                    background = bg
                    border = JBUI.Borders.empty(2, 2)
                    add(checkBox, BorderLayout.WEST)
                    add(label, BorderLayout.CENTER)
                }
                val row = Row(file, checkBox, rowPanel)
                rows += row
                val onClick = object : MouseAdapter() {
                    override fun mouseClicked(e: MouseEvent) = showFile(file)
                }
                label.addMouseListener(onClick)
                rowPanel.addMouseListener(onClick)
                filesPanel.add(rowPanel)
            }
        }

        val filesScroll = thinScrollPane(filesPanel).apply {
            preferredSize = Dimension(JBUI.scale(1040), JBUI.scale(200))
        }

        // 统一视图：单栏 +/- 着色
        val unifiedScroll = thinScrollPane(unifiedPane)
        diffCards.add(unifiedScroll, CARD_UNIFIED)

        // 并排视图：左「修改前」、右「修改后」，滚动联动
        val leftScroll = thinScrollPane(leftPane)
        val rightScroll = thinScrollPane(rightPane)
        linkScroll(leftScroll, rightScroll)
        val sidePanel = JPanel(java.awt.GridLayout(1, 2, JBUI.scale(4), 0))
        sidePanel.add(sideBlock("修改前", leftScroll))
        sidePanel.add(sideBlock("修改后", rightScroll))
        diffCards.add(sidePanel, CARD_SIDE_BY_SIDE)

        val modeBar = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(4), 0))
        val modeHint = JLabel("对比方式").apply {
            font = JBUI.Fonts.smallFont()
            foreground = MUTED_FOREGROUND
        }
        val group = ButtonGroup()
        listOf(unifiedButton, sideButton).forEach { button ->
            button.font = JBUI.Fonts.smallFont()
            button.isFocusable = false
            button.isContentAreaFilled = false
            button.isBorderPainted = false
            button.border = JBUI.Borders.empty(2, 8)
            button.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            group.add(button)
            modeBar.add(button)
        }
        unifiedButton.isSelected = true
        unifiedButton.addActionListener { showMode(CARD_UNIFIED) }
        sideButton.addActionListener { showMode(CARD_SIDE_BY_SIDE) }
        modeBar.add(modeHint)

        val diffBlock = JPanel(BorderLayout())
        diffBlock.add(modeBar, BorderLayout.NORTH)
        diffBlock.add(diffCards, BorderLayout.CENTER)

        val split = Splitter(true)
        split.proportion = 0.32f
        split.setShowDividerControls(false)
        split.setShowDividerIcon(false)
        split.firstComponent = filesScroll
        split.secondComponent = diffBlock

        val hint = JLabel("绿色为新增、红色为删除；「并排」可左右对照，「统一」单栏查看 +/-")
        hint.font = JBUI.Fonts.smallFont()
        hint.foreground = MUTED_FOREGROUND

        val center = JPanel(BorderLayout(0, JBUI.scale(4)))
        center.add(split, BorderLayout.CENTER)
        center.add(hint, BorderLayout.SOUTH)
        root.add(center, BorderLayout.CENTER)

        info.files.firstOrNull()?.let { showFile(it) }
        return root
    }

    private fun sideBlock(title: String, scroll: JScrollPane): JComponent {
        val panel = JPanel(BorderLayout())
        val head = JLabel(title).apply {
            font = JBUI.Fonts.smallFont()
            foreground = MUTED_FOREGROUND
            border = JBUI.Borders.empty(2, 6)
        }
        panel.add(head, BorderLayout.NORTH)
        panel.add(scroll, BorderLayout.CENTER)
        return panel
    }

    private fun showMode(card: String) {
        (diffCards.layout as CardLayout).show(diffCards, card)
        val side = card == CARD_SIDE_BY_SIDE
        if (sideButton.isSelected != side) sideButton.isSelected = side
        if (unifiedButton.isSelected != !side) unifiedButton.isSelected = !side
        renderActive()
    }

    private fun sideBySide(): Boolean = sideButton.isSelected

    private fun showFile(path: String) {
        if (selectedPath == path) return
        selectedPath = path
        val bg = baseBackground ?: return
        rows.forEach { other ->
            other.panel.background = if (other.path == path) ROW_SELECTED_BACKGROUND else bg
            other.panel.repaint()
        }
        renderActive()
    }

    private fun renderActive() {
        val path = selectedPath ?: return
        val lines = diffLines(path)
        if (sideBySide()) renderSideBySide(path, lines) else renderUnified(path, lines)
    }

    private fun diffLines(path: String): List<String>? = fileDiffs.entries
        .firstOrNull { (key, _) -> key == path || key.endsWith("/$path") || path.endsWith("/$key") }
        ?.value

    private fun renderUnified(path: String, lines: List<String>?) {
        val doc = unifiedPane.styledDocument
        doc.remove(0, doc.length)
        if (lines.isNullOrEmpty()) {
            insert(doc, "该文件在当前补丁中没有可显示的差异片段。\n", styles.meta)
            unifiedPane.caretPosition = 0
            return
        }
        val added = lines.count { it.startsWith("+") && !it.startsWith("+++") }
        val removed = lines.count { it.startsWith("-") && !it.startsWith("---") }
        val shown = lines.take(MAX_DIFF_LINES)
        insert(doc, "$path   +$added / -$removed\n\n", styles.header)
        shown.forEach { line ->
            val style = when {
                line.startsWith("@@") -> styles.hunk
                line.startsWith("diff ") || line.startsWith("index ") ||
                    line.startsWith("---") || line.startsWith("+++") -> styles.meta
                line.startsWith("+") -> styles.add
                line.startsWith("-") -> styles.del
                else -> styles.normal
            }
            insert(doc, line + "\n", style)
        }
        if (lines.size > MAX_DIFF_LINES) {
            insert(doc, "…… 还有 ${lines.size - MAX_DIFF_LINES} 行未显示\n", styles.meta)
        }
        unifiedPane.caretPosition = 0
    }

    private fun renderSideBySide(path: String, lines: List<String>?) {
        val leftDoc = leftPane.styledDocument
        val rightDoc = rightPane.styledDocument
        leftDoc.remove(0, leftDoc.length)
        rightDoc.remove(0, rightDoc.length)
        if (lines.isNullOrEmpty()) {
            insert(leftDoc, "该文件在当前补丁中没有可显示的差异片段。\n", styles.meta)
            return
        }
        val diffRows = buildDiffRows(lines).take(MAX_DIFF_ROWS)
        diffRows.forEach { row ->
            val left = row.left
            val right = row.right
            val leftStyle = when {
                left == null -> styles.blank
                right == null -> styles.removedLine
                else -> styles.normal
            }
            val rightStyle = when {
                right == null -> styles.blank
                left == null -> styles.addedLine
                else -> styles.normal
            }
            insert(leftDoc, (left ?: "") + "\n", leftStyle)
            insert(rightDoc, (right ?: "") + "\n", rightStyle)
        }
        if (diffRows.size >= MAX_DIFF_ROWS) {
            insert(leftDoc, "…… 内容过长，已截断\n", styles.meta)
            insert(rightDoc, "…… 内容过长，已截断\n", styles.meta)
        }
        leftPane.caretPosition = 0
        rightPane.caretPosition = 0
    }

    private fun linkScroll(a: JScrollPane, b: JScrollPane) {
        var guard = false
        fun sync(from: JScrollPane, to: JScrollPane) {
            from.verticalScrollBar.addAdjustmentListener { e ->
                if (guard) return@addAdjustmentListener
                guard = true
                try {
                    to.verticalScrollBar.value = e.value
                } finally {
                    guard = false
                }
            }
        }
        sync(a, b)
        sync(b, a)
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

    private companion object {
        const val CARD_UNIFIED = "unified"
        const val CARD_SIDE_BY_SIDE = "sideBySide"
        const val MAX_DIFF_LINES = 1500
        const val MAX_DIFF_ROWS = 1200
    }
}

/** 不换行的等宽文本面板：避免长行折行导致大补丁渲染卡顿 */
private class DiffTextPane : JTextPane() {
    init {
        isEditable = false
        isOpaque = true
        font = JBUI.Fonts.create("JetBrains Mono", 12)
        border = JBUI.Borders.empty(4, 6)
        margin = java.awt.Insets(0, 0, 0, 0)
    }

    override fun getScrollableTracksViewportWidth(): Boolean = false
}

/** 并排视图的一行：左为修改前、右为修改后，null 表示该侧为空行（占位对齐） */
private class DiffRow(val left: String?, val right: String?)

/** 把 unified diff 切成左右可对齐的行组：连续 - 与连续 + 配对，上下文行两侧相同 */
private fun buildDiffRows(lines: List<String>): List<DiffRow> {
    val rows = mutableListOf<DiffRow>()
    val removed = mutableListOf<String>()
    val added = mutableListOf<String>()

    fun flush() {
        val count = maxOf(removed.size, added.size)
        for (index in 0 until count) {
            rows += DiffRow(removed.getOrNull(index), added.getOrNull(index))
        }
        removed.clear()
        added.clear()
    }

    lines.forEach { line ->
        when {
            line.startsWith("+") && !line.startsWith("+++") -> added += line.substring(1)
            line.startsWith("-") && !line.startsWith("---") -> removed += line.substring(1)
            line.startsWith("diff ") || line.startsWith("index ") ||
                line.startsWith("---") || line.startsWith("+++") ||
                line.startsWith("@@") || line.startsWith("\\") -> flush()
            line.startsWith(" ") -> {
                flush()
                val text = line.substring(1)
                rows += DiffRow(text, text)
            }
            line.isEmpty() -> {
                flush()
                rows += DiffRow("", "")
            }
            else -> {
                flush()
                rows += DiffRow(line, line)
            }
        }
    }
    flush()
    return rows
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
    val removedLine = style(JBColor(Color(0xB4261C), Color(0xFF8078)), background = JBColor(Color(0xFBE7E7), Color(0x4A2727)))
    val addedLine = style(JBColor(Color(0x1B7F3B), Color(0x6EDC93)), background = JBColor(Color(0xE8F5EC), Color(0x2C4235)))
    val blank = style(JBColor(Color(0x9AA1A9), Color(0x4B5058)), background = JBColor(Color(0xF4F5F7), Color(0x2A2C30)))

    private fun style(
        fg: Color,
        bold: Boolean = false,
        background: Color? = null
    ): SimpleAttributeSet = SimpleAttributeSet().apply {
        StyleConstants.setForeground(this, fg)
        StyleConstants.setFontFamily(this, font.family)
        StyleConstants.setFontSize(this, font.size)
        StyleConstants.setBold(this, bold)
        if (background != null) StyleConstants.setBackground(this, background)
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
