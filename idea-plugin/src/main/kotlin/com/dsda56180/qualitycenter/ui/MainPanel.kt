package com.dsda56180.qualitycenter.ui

import com.dsda56180.qualitycenter.model.Issue
import com.dsda56180.qualitycenter.model.IssueSource
import com.dsda56180.qualitycenter.model.ScanResult
import com.dsda56180.qualitycenter.model.Severity
import com.dsda56180.qualitycenter.model.Suggestion
import com.dsda56180.qualitycenter.service.QualityCenterService
import com.dsda56180.qualitycenter.service.RULE_RECIPES
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.GridLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.text.SimpleDateFormat
import java.util.Date
import javax.swing.BorderFactory
import javax.swing.BoxLayout
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JSplitPane
import javax.swing.JTabbedPane
import javax.swing.JTable
import javax.swing.JTextArea
import javax.swing.JToggleButton
import javax.swing.ListSelectionModel
import javax.swing.Timer
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener
import javax.swing.table.AbstractTableModel
import javax.swing.table.DefaultTableCellRenderer

/** 质量中心主面板：工具栏、猫咪进度条、等级/来源筛选、问题列表、建议与错误页 */
class MainPanel(private val service: QualityCenterService) : JPanel(BorderLayout()), Runnable {

    private val scanButton = JButton("重新扫描")
    private val pauseButton = JButton("暂停")
    private val resumeButton = JButton("继续")
    private val stopButton = JButton("终止")
    private val deepFixButton = JButton("深度修复")
    private val upgradeButton = JButton("升级依赖")
    private val copyButton = JButton("复制 Markdown")
    private val exportButton = JButton("导出报告")
    private val settingsButton = JButton("设置")

    private val catBar = CatProgressBar()
    private val catTip = JLabel(" ")
    private val progressPanel = JPanel(BorderLayout(0, JBUI.scale(2)))
    private val hideTimer = Timer(700) {
        progressPanel.isVisible = false
        catBar.stop()
    }.apply { isRepeats = false }
    private var wasBusy = false

    private val buildHintPanel = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(6), JBUI.scale(2)))
    private val buildHintLabel = JLabel()
    private val buildAndScanButton = JButton("构建并扫描")

    private val severityButtons = LinkedHashMap<Severity, JToggleButton>()
    private val statusLabel = JLabel("尚未扫描")
    private val searchField = JBTextField()
    private val sourceFilter = JComboBox(arrayOf("全部", "代码质量", "密钥泄露", "依赖漏洞", "静态缺陷"))

    private val issueModel = IssueTableModel(service)
    private val issueTable = JTable(issueModel)
    private val ignoredModel = IssueTableModel(service)
    private val ignoredTable = JTable(ignoredModel)

    private val suggestionModel = DefaultListModel<Suggestion>()
    private val suggestionList = JList(suggestionModel)
    private val suggestionDetail = JTextArea()

    private val issueDetail = JTextArea()
    private val detailButtons = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(6), 0))
    private val copyIssueButton = JButton("复制")
    private val ignoreButton = JButton("忽略")
    private val restoreButton = JButton("恢复")
    private val ruleFixButton = JButton("单规则修复")
    private val openButton = JButton("打开文件")

    private val tabs = JTabbedPane()
    private val errorsArea = JTextArea()

    private var selectedIssue: Issue? = null
    private var selectedIgnored: Issue? = null

    private val toolbar = JPanel(GridLayout(0, 3, JBUI.scale(4), JBUI.scale(4)))

    init {
        buildToolbar()
        buildProgress()
        buildCenter()
        wireActions()
    }

    override fun addNotify() {
        super.addNotify()
        service.addListener(this)
        run()
    }

    override fun removeNotify() {
        service.removeListener(this)
        hideTimer.stop()
        catBar.stop()
        super.removeNotify()
    }

    // ------------------------------------------------------------ 布局

    private fun buildToolbar() {
        toolbar.border = JBUI.Borders.empty(4, 8, 2, 8)
        // 三列网格，窄侧边栏下也能完整显示全部操作
        listOf(
            scanButton, deepFixButton, upgradeButton,
            pauseButton, resumeButton, stopButton,
            copyButton, exportButton, settingsButton
        ).forEach { toolbar.add(it) }
    }

    private fun buildProgress() {
        progressPanel.isVisible = false
        val stage = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(4, 8, 0, 8)
            add(catBar, BorderLayout.CENTER)
        }
        progressPanel.add(stage, BorderLayout.CENTER)
        progressPanel.add(JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(8), 0)).apply {
            add(catTip)
        }, BorderLayout.SOUTH)

        buildHintPanel.isVisible = false
        buildHintPanel.add(buildHintLabel)
        buildHintPanel.add(buildAndScanButton)
    }

    private fun buildCenter() {
        val top = JPanel()
        top.layout = BoxLayout(top, BoxLayout.Y_AXIS)
        top.add(toolbar)
        top.add(progressPanel)
        top.add(buildHintPanel)
        top.add(buildSummary())

        tabs.addTab("问题", buildIssueTab())
        tabs.addTab("建议", buildSuggestionTab())
        tabs.addTab("已忽略", buildIgnoredTab())
        tabs.addTab("错误 / 跳过", buildErrorsTab())

        add(top, BorderLayout.PAGE_START)
        add(tabs, BorderLayout.CENTER)
    }

    private fun buildSummary(): JPanel {
        val wrapper = JPanel()
        wrapper.layout = BoxLayout(wrapper, BoxLayout.Y_AXIS)
        wrapper.border = JBUI.Borders.empty(2, 8, 4, 8)

        val firstRow = JPanel(BorderLayout(JBUI.scale(8), 0))
        val chips = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(4), 0))
        Severity.entries.forEach { severity ->
            val chip = JToggleButton("${severity.label} 0").apply {
                isSelected = true
                font = font.deriveFont(font.size2D - 1f)
                addActionListener { refreshIssueTable() }
            }
            severityButtons[severity] = chip
            chips.add(chip)
        }
        firstRow.add(chips, BorderLayout.CENTER)
        firstRow.add(statusLabel, BorderLayout.EAST)

        val secondRow = JPanel(BorderLayout())
        searchField.toolTipText = "搜索文件 / 规则 / 说明"
        searchField.preferredSize = Dimension(JBUI.scale(220), JBUI.scale(26))
        searchField.document.addDocumentListener(object : DocumentListener {
            override fun insertUpdate(e: DocumentEvent) = refreshIssueTable()
            override fun removeUpdate(e: DocumentEvent) = refreshIssueTable()
            override fun changedUpdate(e: DocumentEvent) = refreshIssueTable()
        })
        secondRow.add(searchField, BorderLayout.CENTER)

        wrapper.add(firstRow)
        wrapper.add(secondRow)
        return wrapper
    }

    private fun buildIssueTab(): Component {
        val sourceRow = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(6), JBUI.scale(2)))
        sourceRow.add(JLabel("来源"))
        sourceRow.add(sourceFilter)
        sourceFilter.addActionListener { refreshIssueTable() }

        configureTable(issueTable)
        issueTable.selectionModel.addListSelectionListener {
            if (!it.valueIsAdjusting) {
                selectedIssue = issueTable.selectedRow.takeIf { row -> row >= 0 }?.let(issueModel::rowAt)
                showIssueDetail(selectedIssue)
            }
        }
        issueTable.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 2) {
                    selectedIssue?.let(service::openIssue)
                }
            }
        })

        val container = JPanel(BorderLayout())
        container.add(sourceRow, BorderLayout.NORTH)
        container.add(JBScrollPane(issueTable), BorderLayout.CENTER)

        val detail = buildDetailPanel()
        val split = JSplitPane(JSplitPane.VERTICAL_SPLIT, container, detail)
        split.resizeWeight = 0.68
        split.border = BorderFactory.createEmptyBorder()
        return split
    }

    private fun buildDetailPanel(): Component {
        issueDetail.apply {
            isEditable = false
            lineWrap = true
            wrapStyleWord = true
            border = JBUI.Borders.empty(6, 8)
            font = JBUI.Fonts.label()
        }
        detailButtons.add(copyIssueButton)
        detailButtons.add(ignoreButton)
        detailButtons.add(ruleFixButton)
        detailButtons.add(openButton)

        val panel = JPanel(BorderLayout())
        panel.add(JBScrollPane(issueDetail), BorderLayout.CENTER)
        panel.add(detailButtons, BorderLayout.SOUTH)
        panel.minimumSize = Dimension(0, JBUI.scale(120))
        return panel
    }

    private fun buildSuggestionTab(): Component {
        suggestionList.selectionMode = ListSelectionModel.SINGLE_SELECTION
        suggestionList.selectionModel.addListSelectionListener {
            val suggestion = suggestionList.selectedValue ?: return@addListSelectionListener
            suggestionDetail.text = buildString {
                appendLine(suggestion.title)
                appendLine("类别：${suggestion.category} · 可覆盖 ${suggestion.impact} 项")
                appendLine()
                appendLine(suggestion.detail)
            }
            suggestionDetail.caretPosition = 0
        }
        suggestionDetail.apply {
            isEditable = false
            lineWrap = true
            wrapStyleWord = true
            font = JBUI.Fonts.label()
            border = JBUI.Borders.empty(6, 8)
        }
        val copySuggestion = JButton("复制建议").apply {
            addActionListener {
                val index = suggestionList.selectedIndex
                if (index >= 0) service.copySuggestion(index + 1)
            }
        }
        val split = JSplitPane(JSplitPane.VERTICAL_SPLIT, JBScrollPane(suggestionList), JBScrollPane(suggestionDetail))
        split.resizeWeight = 0.4
        split.border = BorderFactory.createEmptyBorder()
        val panel = JPanel(BorderLayout())
        panel.add(split, BorderLayout.CENTER)
        panel.add(JPanel(FlowLayout(FlowLayout.LEFT)).apply { add(copySuggestion) }, BorderLayout.SOUTH)
        return panel
    }

    private fun buildIgnoredTab(): Component {
        configureTable(ignoredTable)
        ignoredTable.selectionModel.addListSelectionListener {
            if (!it.valueIsAdjusting) {
                selectedIgnored = ignoredTable.selectedRow.takeIf { row -> row >= 0 }?.let(ignoredModel::rowAt)
                restoreButton.isEnabled = selectedIgnored != null
            }
        }
        ignoredTable.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 2) {
                    selectedIgnored?.let(service::openIssue)
                }
            }
        })
        val panel = JPanel(BorderLayout())
        panel.add(JBScrollPane(ignoredTable), BorderLayout.CENTER)
        val actions = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(6), JBUI.scale(4)))
        actions.add(restoreButton)
        panel.add(actions, BorderLayout.SOUTH)
        return panel
    }

    private fun buildErrorsTab(): Component {
        errorsArea.apply {
            isEditable = false
            lineWrap = true
            wrapStyleWord = true
            font = JBUI.Fonts.label()
            border = JBUI.Borders.empty(8)
        }
        return JBScrollPane(errorsArea)
    }

    private fun configureTable(table: JTable) {
        table.setShowGrid(false)
        table.rowHeight = JBUI.scale(24)
        table.tableHeader.reorderingAllowed = false
        table.autoCreateRowSorter = false
        table.columnModel.getColumn(0).apply {
            preferredWidth = JBUI.scale(58)
            maxWidth = JBUI.scale(70)
        }
        table.columnModel.getColumn(1).apply {
            preferredWidth = JBUI.scale(80)
            maxWidth = JBUI.scale(100)
        }
        table.columnModel.getColumn(2).preferredWidth = JBUI.scale(180)
        table.columnModel.getColumn(3).preferredWidth = JBUI.scale(220)
        table.columnModel.getColumn(4).preferredWidth = JBUI.scale(520)
        table.columnModel.getColumn(0).cellRenderer = SeverityCellRenderer()
    }

    // ------------------------------------------------------------ 行为

    private fun wireActions() {
        scanButton.addActionListener { service.scan() }
        pauseButton.addActionListener { service.pause() }
        resumeButton.addActionListener { service.resume() }
        stopButton.addActionListener { service.cancel() }
        deepFixButton.addActionListener { service.deepFix() }
        upgradeButton.addActionListener { service.upgradeDependencies() }
        copyButton.addActionListener { service.copyMarkdown() }
        exportButton.addActionListener { service.exportReport() }
        settingsButton.addActionListener { SettingsDialog(service.project, service).openAndSave() }
        buildAndScanButton.addActionListener { service.buildAndScan() }

        copyIssueButton.addActionListener {
            val index = currentIssueIndex()
            if (index > 0) service.copyIssue(index)
        }
        ignoreButton.addActionListener {
            val index = currentIssueIndex()
            if (index > 0) service.ignore(index)
        }
        restoreButton.addActionListener {
            val index = ignoredTable.selectedRow + 1
            if (index > 0) service.unignore(index)
        }
        ruleFixButton.addActionListener {
            val index = currentIssueIndex()
            val issue = selectedIssue
            if (index > 0 && issue != null && RULE_RECIPES.containsKey(issue.rule)) service.deepFixRule(index)
        }
        openButton.addActionListener {
            val issue = selectedIssue ?: selectedIgnored
            issue?.let(service::openIssue)
        }
    }

    private fun currentIssueIndex(): Int {
        val row = issueTable.selectedRow
        if (row < 0) return 0
        val issue = issueModel.rowAt(row) ?: return 0
        return service.state.result?.issues?.indexOf(issue)?.plus(1) ?: 0
    }

    private fun showIssueDetail(issue: Issue?) {
        if (issue == null) {
            issueDetail.text = ""
            copyIssueButton.isEnabled = false
            ignoreButton.isEnabled = false
            ruleFixButton.isEnabled = false
            openButton.isEnabled = false
            return
        }
        copyIssueButton.isEnabled = true
        ignoreButton.isEnabled = true
        ruleFixButton.isEnabled = issue.source == IssueSource.CHECKSTYLE &&
            RULE_RECIPES.containsKey(issue.rule)
        openButton.isEnabled = issue.file != null

        val dir = service.root?.path ?: ""
        val rel = issue.file?.let { file ->
            if (dir.isNotEmpty() && file.startsWith(dir)) file.substring(dir.length).trimStart('\\', '/')
            else file
        } ?: ""
        issueDetail.text = buildString {
            appendLine("${issue.severity.label} · ${issue.source.label} · ${issue.rule}")
            if (rel.isNotEmpty()) appendLine("位置：$rel${issue.line?.let { ":$it" } ?: ""}")
            if (!issue.packageName.isNullOrBlank()) {
                appendLine("依赖：${issue.packageName} ${issue.installedVersion ?: ""} → ${issue.fixedVersion ?: "暂无修复版本"}")
            }
            appendLine()
            appendLine(issue.zhSummary ?: issue.message)
            issue.advice?.takeIf { it.isNotBlank() }?.let {
                appendLine()
                appendLine("修复建议：$it")
            }
            issue.description?.takeIf { it.isNotBlank() }?.let {
                appendLine()
                appendLine(it)
            }
            issue.link?.takeIf { it.isNotBlank() }?.let {
                appendLine()
                appendLine("链接：$it")
            }
        }
        issueDetail.caretPosition = 0
    }

    // ------------------------------------------------------------ 刷新

    override fun run() {
        val state = service.state
        val busy = state.scanning || state.stage != null
        scanButton.isEnabled = !busy
        pauseButton.isEnabled = state.scanning && !state.paused
        resumeButton.isEnabled = state.scanning && state.paused
        stopButton.isEnabled = state.scanning
        deepFixButton.isEnabled = !busy
        upgradeButton.isEnabled = !busy

        if (busy) {
            hideTimer.stop()
            progressPanel.isVisible = true
            catBar.start()
            catBar.update(state.progress, state.stage, state.paused)
            catTip.text = when {
                state.stage != null -> "深度修复：${state.stage.label}"
                state.paused -> "已暂停，点击「继续」恢复扫描…"
                else -> "猫咪正在奔跑检查代码"
            }
        } else if (wasBusy) {
            catBar.markCompleted()
            hideTimer.restart()
        }
        wasBusy = busy

        val result = state.result
        val buildHint = result?.buildHint
        buildHintPanel.isVisible = !buildHint.isNullOrBlank()
        buildHintLabel.text = buildHint ?: ""
        buildHintLabel.toolTipText = buildHint

        updateSummary(result)
        refreshIssueTable()
        refreshIgnoredTable(result)
        refreshSuggestions(result)
        refreshErrors(result)
        progressPanel.revalidate()
        progressPanel.repaint()
    }

    private fun updateSummary(result: ScanResult?) {
        val issues = result?.issues ?: emptyList()
        Severity.entries.forEach { severity ->
            val count = issues.count { it.severity == severity }
            severityButtons[severity]?.text = "${severity.label} $count"
        }
        statusLabel.text = if (result == null) {
            "尚未扫描"
        } else {
            val time = SimpleDateFormat("HH:mm:ss").format(Date(result.finishedAt))
            "共 ${issues.size} 项 · $time"
        }
    }

    private fun refreshIssueTable() {
        val result = service.state.result
        if (result == null) {
            issueModel.setRows(emptyList())
            return
        }
        val source = when (sourceFilter.selectedIndex) {
            1 -> IssueSource.CHECKSTYLE
            2 -> IssueSource.GITLEAKS
            3 -> IssueSource.TRIVY
            4 -> IssueSource.SPOTBUGS
            else -> null
        }
        val query = searchField.text.trim().lowercase()
        val enabledSeverities = severityButtons.filterValues { it.isSelected }.keys
        val rows = result.issues.filter { issue ->
            (source == null || issue.source == source) &&
                issue.severity in enabledSeverities &&
                (query.isEmpty() || (
                    (issue.file ?: "") + " " + issue.rule + " " + issue.message + " " +
                        (issue.zhSummary ?: "")
                    ).lowercase().contains(query))
        }
        issueModel.setRows(rows)
    }

    private fun refreshIgnoredTable(result: ScanResult?) {
        ignoredModel.setRows(result?.ignored ?: emptyList())
    }

    private fun refreshSuggestions(result: ScanResult?) {
        suggestionModel.clear()
        result?.suggestions?.forEach(suggestionModel::addElement)
        if (suggestionModel.isEmpty) {
            suggestionDetail.text = if (result == null) "扫描完成后展示可执行的修复建议。" else "暂无可推导的修复建议。"
        }
    }

    private fun refreshErrors(result: ScanResult?) {
        errorsArea.text = buildString {
            if (result == null) {
                append("尚未扫描。")
                return@buildString
            }
            if (result.errors.isNotEmpty()) {
                appendLine("== 扫描错误 ==")
                result.errors.forEach { appendLine("· ${it.source.label}：${it.message}") }
                appendLine()
            }
            if (result.skipped.isNotEmpty()) {
                appendLine("== 已跳过 ==")
                result.skipped.forEach { appendLine("· ${it.source.label}：${it.reason}") }
                appendLine()
            }
            result.buildHint?.takeIf { it.isNotBlank() }?.let {
                appendLine("== 提示 ==")
                appendLine(it)
            }
            if (result.errors.isEmpty() && result.skipped.isEmpty() && result.buildHint.isNullOrBlank()) {
                append("本次扫描没有错误或被跳过的检查。")
            }
        }
    }

    // ------------------------------------------------------------ 表格模型

    private class IssueTableModel(private val service: QualityCenterService) : AbstractTableModel() {
        private val rows = mutableListOf<Issue>()
        private val columns = arrayOf("级别", "来源", "规则", "位置", "说明")

        fun setRows(issues: List<Issue>) {
            rows.clear()
            rows.addAll(issues)
            fireTableDataChanged()
        }

        fun rowAt(index: Int): Issue? = rows.getOrNull(index)

        override fun getRowCount(): Int = rows.size
        override fun getColumnCount(): Int = columns.size
        override fun getColumnName(column: Int): String = columns[column]

        override fun getValueAt(rowIndex: Int, columnIndex: Int): Any {
            val issue = rows[rowIndex]
            val dir = service.root?.path ?: ""
            return when (columnIndex) {
                0 -> issue.severity.label
                1 -> issue.source.label
                2 -> issue.rule
                3 -> {
                    val file = issue.file
                    val rel = if (file != null && dir.isNotEmpty() && file.startsWith(dir)) {
                        file.substring(dir.length).trimStart('\\', '/')
                    } else file ?: ""
                    if (rel.isEmpty()) "" else rel + (issue.line?.let { ":$it" } ?: "")
                }
                else -> issue.zhSummary ?: issue.message
            }
        }
    }

    private class SeverityCellRenderer : DefaultTableCellRenderer() {
        override fun getTableCellRendererComponent(
            table: JTable, value: Any?, isSelected: Boolean, hasFocus: Boolean, row: Int, column: Int
        ): Component {
            val component = super.getTableCellRendererComponent(table, value, isSelected, hasFocus, row, column)
            if (!isSelected) {
                component.foreground = when (value?.toString()) {
                    Severity.CRITICAL.label -> Color(224, 62, 62)
                    Severity.HIGH.label -> Color(232, 100, 40)
                    Severity.MEDIUM.label -> Color(206, 160, 30)
                    Severity.LOW.label -> Color(70, 150, 220)
                    else -> Color(140, 150, 160)
                }
                component.font = component.font.deriveFont(Font.BOLD)
            }
            return component
        }
    }
}
