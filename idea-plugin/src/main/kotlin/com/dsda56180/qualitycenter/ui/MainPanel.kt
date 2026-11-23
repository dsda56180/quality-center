package com.dsda56180.qualitycenter.ui

import com.dsda56180.qualitycenter.model.Issue
import com.dsda56180.qualitycenter.model.IssueSource
import com.dsda56180.qualitycenter.model.ScanResult
import com.dsda56180.qualitycenter.model.Severity
import com.dsda56180.qualitycenter.model.Suggestion
import com.dsda56180.qualitycenter.service.QualityCenterService
import com.dsda56180.qualitycenter.service.RULE_RECIPES
import com.intellij.ide.util.PropertiesComponent
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Cursor
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.Graphics
import java.awt.Insets
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.awt.event.MouseMotionAdapter
import java.text.SimpleDateFormat
import java.util.Date
import javax.swing.BorderFactory
import javax.swing.BoxLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JLabel
import javax.swing.JList
import com.intellij.ui.tabs.JBTabsFactory
import com.intellij.ui.tabs.TabInfo
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JSplitPane
import javax.swing.JTable
import javax.swing.JTextArea
import javax.swing.JToggleButton
import javax.swing.ListSelectionModel
import javax.swing.Timer
import javax.swing.event.ChangeEvent
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener
import javax.swing.event.ListSelectionEvent
import javax.swing.event.TableColumnModelEvent
import javax.swing.event.TableColumnModelListener
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
        progressPanel.parent?.revalidate()
        progressPanel.parent?.repaint()
    }.apply { isRepeats = false }
    private var wasBusy = false

    private val buildHintPanel = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(6), JBUI.scale(2)))
    private val buildHintLabel = JLabel()
    private val buildAndScanButton = JButton("构建并扫描")

    private val severityButtons = LinkedHashMap<Severity, JToggleButton>()
    private val statusLabel = JLabel("尚未扫描")
    private val searchField = JBTextField()
    private val sourceFilter = JComboBox<SourceFilterItem>()
    private val expandAllButton = JButton()
    private val collapseAllButton = JButton()

    /** 当前选中的来源筛选，null 表示全部 */
    private var selectedSource: IssueSource? = null
    /** 重建下拉框时会触发 action 事件，用该标记避免递归刷新 */
    private var suppressSourceEvents = false
    /** 被折叠起来的来源分组，默认全部展开 */
    private val collapsedSources = HashSet<IssueSource>()
    /** 当前（等级 + 搜索）过滤后的问题，用于折叠展开时就地重建列表 */
    private var currentIssues: List<Issue> = emptyList()

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

    // 官方 JBTabs：与 IDE 工具窗口一致的标签控件，替代裸 JTabbedPane
    private val tabs = JBTabsFactory.createTabs(service.project)
    private val errorsArea = JTextArea()

    private var selectedIssue: Issue? = null
    private var selectedIgnored: Issue? = null

    private val toolbar = JPanel()

    /** 上一次写入下拉框的文案，避免扫描进度刷新时反复重建模型 */
    private var lastSourceFilterLabels: List<String> = emptyList()

    /** 表格行：来源分组标题，或一条具体问题 */
    private sealed class ListRow {
        class Group(val source: IssueSource, val count: Int, val expanded: Boolean) : ListRow()
        class Entry(val issue: Issue) : ListRow()
    }

    private data class SourceFilterItem(val source: IssueSource?, val label: String) {
        override fun toString(): String = label
    }

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
        toolbar.layout = FlowLayout(FlowLayout.LEFT, JBUI.scale(2), JBUI.scale(2))
        toolbar.border = JBUI.Borders.empty(4, 6, 2, 6)
        // 与 IDEA 原生工具栏一致：图标按钮 + 悬停提示
        iconButton(scanButton, com.intellij.icons.AllIcons.Actions.Execute, "开始扫描")
        iconButton(deepFixButton, com.intellij.icons.AllIcons.Actions.Edit, "深度修复（OpenRewrite）")
        iconButton(upgradeButton, com.intellij.icons.AllIcons.Actions.Download, "按 CVE 升级依赖")
        iconButton(pauseButton, com.intellij.icons.AllIcons.Actions.Pause, "暂停扫描")
        iconButton(resumeButton, com.intellij.icons.AllIcons.Actions.Resume, "继续扫描")
        iconButton(stopButton, com.intellij.icons.AllIcons.Actions.Suspend, "终止扫描")
        iconButton(copyButton, com.intellij.icons.AllIcons.Actions.Copy, "复制 Markdown 报告")
        iconButton(exportButton, com.intellij.icons.AllIcons.ToolbarDecorator.Export, "导出报告文件")
        iconButton(settingsButton, com.intellij.icons.AllIcons.General.Settings, "质量中心设置")
        // 暂停 / 继续 / 终止 只在扫描过程中出现
        pauseButton.isVisible = false
        resumeButton.isVisible = false
        stopButton.isVisible = false
        listOf(
            scanButton, deepFixButton, upgradeButton,
            pauseButton, resumeButton, stopButton,
            copyButton, exportButton, settingsButton
        ).forEach { toolbar.add(it) }
    }

    private fun iconButton(button: JButton, icon: javax.swing.Icon, tooltip: String) {
        button.icon = icon
        button.text = ""
        button.toolTipText = tooltip
        button.isFocusable = false
        button.isContentAreaFilled = false
        button.isBorderPainted = false
        button.margin = java.awt.Insets(JBUI.scale(3), JBUI.scale(3), JBUI.scale(3), JBUI.scale(3))
        button.preferredSize = Dimension(JBUI.scale(30), JBUI.scale(28))
        button.isRolloverEnabled = true
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

        listOf(
            "问题" to buildIssueTab(),
            "建议" to buildSuggestionTab(),
            "已忽略" to buildIgnoredTab(),
            "错误 / 跳过" to buildErrorsTab()
        ).forEach { (title, component) ->
            tabs.addTab(TabInfo(component as JComponent).setText(title))
        }

        add(top, BorderLayout.PAGE_START)
        add(tabs.component, BorderLayout.CENTER)
    }

    private fun buildSummary(): JPanel {
        val wrapper = JPanel()
        wrapper.layout = BoxLayout(wrapper, BoxLayout.Y_AXIS)
        wrapper.border = JBUI.Borders.empty(2, 8, 4, 8)

        // 第一行：等级筛选按内容紧凑排列，统计信息弱化后放右侧
        val chipRow = JPanel(BorderLayout(JBUI.scale(8), 0))
        val chipGroup = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(6), 0))
        Severity.entries.forEach { severity ->
            val chip = JToggleButton("${severity.label} 0").apply {
                isSelected = true
                isContentAreaFilled = true
                isOpaque = true
                isFocusPainted = false
                isRolloverEnabled = true
                margin = java.awt.Insets(JBUI.scale(1), JBUI.scale(7), JBUI.scale(1), JBUI.scale(7))
                font = JBUI.Fonts.smallFont()
                toolTipText = "点击切换是否显示「${severity.label}」问题"
                addActionListener {
                    refreshSeverityChipStyles()
                    refreshIssueTable()
                }
            }
            severityButtons[severity] = chip
            chipGroup.add(chip)
        }
        refreshSeverityChipStyles()
        chipRow.add(chipGroup, BorderLayout.CENTER)
        statusLabel.font = JBUI.Fonts.smallFont()
        statusLabel.foreground = MUTED_FOREGROUND
        chipRow.add(statusLabel, BorderLayout.EAST)

        // 第二行：搜索框整行铺满，不再被等级标签挤窄
        searchField.toolTipText = "搜索文件 / 规则 / 说明"
        searchField.emptyText.text = "搜索文件 / 规则 / 说明"
        searchField.preferredSize = Dimension(0, JBUI.scale(28))
        searchField.document.addDocumentListener(object : DocumentListener {
            override fun insertUpdate(e: DocumentEvent) = refreshIssueTable()
            override fun removeUpdate(e: DocumentEvent) = refreshIssueTable()
            override fun changedUpdate(e: DocumentEvent) = refreshIssueTable()
        })
        val searchRow = JPanel(BorderLayout())
        searchRow.add(searchField, BorderLayout.CENTER)

        wrapper.add(chipRow)
        wrapper.add(searchRow)
        return wrapper
    }

    private fun buildIssueTab(): Component {
        val sourceRow = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(4), JBUI.scale(2)))
        sourceRow.add(JLabel("来源"))
        sourceFilter.toolTipText = "按来源筛选，括号内为当前筛选条件下的条数"
        sourceFilter.preferredSize = Dimension(JBUI.scale(136), JBUI.scale(26))
        sourceFilter.maximumRowCount = 8
        sourceRow.add(sourceFilter)
        iconButton(expandAllButton, com.intellij.icons.AllIcons.Actions.Expandall, "展开全部来源分组")
        iconButton(collapseAllButton, com.intellij.icons.AllIcons.Actions.Collapseall, "折叠全部来源分组")
        expandAllButton.isVisible = false
        collapseAllButton.isVisible = false
        sourceRow.add(expandAllButton)
        sourceRow.add(collapseAllButton)
        sourceFilter.addActionListener {
            if (suppressSourceEvents) return@addActionListener
            val next = (sourceFilter.selectedItem as? SourceFilterItem)?.source
            if (next != selectedSource) {
                selectedSource = next
                refreshIssueTable()
            }
        }

        configureTable(issueTable, issueModel, persistWidths = true)
        installColumnAutoFit(issueTable)
        issueTable.selectionModel.addListSelectionListener {
            if (!it.valueIsAdjusting) {
                selectedIssue = issueTable.selectedRow.takeIf { row -> row >= 0 }?.let(issueModel::rowAt)
                showIssueDetail(selectedIssue)
            }
        }
        issueTable.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                val row = issueTable.rowAtPoint(e.point)
                val column = issueTable.columnAtPoint(e.point)
                if (row < 0 || column < 0) return
                when (val item = issueModel.itemAt(issueTable.convertRowIndexToModel(row))) {
                    is ListRow.Group -> toggleGroup(item.source)
                    is ListRow.Entry -> {
                        // 单击任意一格即定位到对应代码行；没有代码位置的依赖漏洞只选中不跳转
                        if (item.issue.file != null) service.openIssue(item.issue)
                    }
                    null -> Unit
                }
            }
        })
        issueTable.addMouseMotionListener(object : MouseMotionAdapter() {
            override fun mouseMoved(e: MouseEvent) {
                val row = issueTable.rowAtPoint(e.point)
                val column = issueTable.columnAtPoint(e.point)
                val item = if (row >= 0 && column >= 0) {
                    issueModel.itemAt(issueTable.convertRowIndexToModel(row))
                } else {
                    null
                }
                issueTable.cursor = when {
                    item is ListRow.Group -> Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                    item is ListRow.Entry && item.issue.file != null ->
                        Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                    else -> Cursor.getDefaultCursor()
                }
            }
        })
        issueTable.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode != KeyEvent.VK_ENTER) return
                val row = issueTable.selectedRow
                if (row < 0) return
                when (val item = issueModel.itemAt(issueTable.convertRowIndexToModel(row))) {
                    is ListRow.Group -> toggleGroup(item.source)
                    is ListRow.Entry -> service.openIssue(item.issue)
                    null -> Unit
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
            text = DETAIL_PLACEHOLDER
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
        configureTable(ignoredTable, ignoredModel)
        ignoredTable.selectionModel.addListSelectionListener {
            if (!it.valueIsAdjusting) {
                selectedIgnored = ignoredTable.selectedRow.takeIf { row -> row >= 0 }?.let(ignoredModel::rowAt)
                restoreButton.isEnabled = selectedIgnored != null
            }
        }
        ignoredTable.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                val row = ignoredTable.rowAtPoint(e.point)
                val column = ignoredTable.columnAtPoint(e.point)
                if (row < 0 || column < 0) return
                val issue = ignoredModel.rowAt(ignoredTable.convertRowIndexToModel(row)) ?: return
                val clickLocation = column == LOCATION_COLUMN && issue.file != null
                if (clickLocation || e.clickCount >= 2) service.openIssue(issue)
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

    private fun configureTable(table: JTable, model: IssueTableModel, persistWidths: Boolean = false) {
        table.setShowGrid(false)
        table.rowHeight = JBUI.scale(24)
        table.tableHeader.reorderingAllowed = false
        table.autoCreateRowSorter = false
        // 关闭「自动压缩所有列」，列宽交给用户拖动 + 水平滚动条，避免内容被一起挤成省略号
        table.autoResizeMode = JTable.AUTO_RESIZE_OFF
        table.fillsViewportHeight = false

        setColumn(table, 0, 50, 44, 88)
        setColumn(table, 1, 72, 60, Int.MAX_VALUE)
        setColumn(table, 2, 120, 80, Int.MAX_VALUE)
        setColumn(table, 3, 170, 100, Int.MAX_VALUE)
        setColumn(table, 4, 200, 120, Int.MAX_VALUE)

        val renderer = IssueTableRenderer(model)
        for (column in 0 until table.columnCount) {
            table.columnModel.getColumn(column).cellRenderer = renderer
        }
        if (persistWidths) {
            restoreColumnWidths(table)
            table.columnModel.addColumnModelListener(object : TableColumnModelListener {
                override fun columnAdded(e: TableColumnModelEvent) = Unit
                override fun columnRemoved(e: TableColumnModelEvent) = Unit
                override fun columnMoved(e: TableColumnModelEvent) = Unit
                override fun columnSelectionChanged(e: ListSelectionEvent) = Unit
                override fun columnMarginChanged(e: ChangeEvent) = persistColumnWidths(table)
            })
        }
    }

    private fun setColumn(table: JTable, index: Int, width: Int, min: Int, max: Int) {
        table.columnModel.getColumn(index).apply {
            preferredWidth = JBUI.scale(width)
            minWidth = JBUI.scale(min)
            if (max != Int.MAX_VALUE) maxWidth = JBUI.scale(max)
        }
    }

    /** 记住用户拖出来的列宽，下次打开工具窗口沿用 */
    private fun restoreColumnWidths(table: JTable) {
        val saved = PropertiesComponent.getInstance(service.project)
            .getValue(COLUMN_WIDTHS_KEY)
            ?.split(',')
            ?.mapNotNull { it.trim().toIntOrNull() }
            ?: return
        if (saved.size != table.columnCount) return
        saved.forEachIndexed { index, width ->
            val column = table.columnModel.getColumn(index)
            column.preferredWidth = width.coerceIn(column.minWidth, column.maxWidth)
        }
    }

    private fun persistColumnWidths(table: JTable) {
        val widths = (0 until table.columnCount)
            .joinToString(",") { table.columnModel.getColumn(it).width.toString() }
        PropertiesComponent.getInstance(service.project).setValue(COLUMN_WIDTHS_KEY, widths)
    }

    /** 双击表头分隔线把该列自适应到内容宽度，省得手动拖拽慢慢试 */
    private fun installColumnAutoFit(table: JTable) {
        table.tableHeader.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount != 2) return
                val header = table.tableHeader
                val boundary = (0 until table.columnCount)
                    .map { index -> Pair(index, header.getHeaderRect(index)) }
                    .firstOrNull { pair ->
                        Math.abs(e.x - (pair.second.x + pair.second.width)) <= JBUI.scale(5)
                    }
                    ?.first
                    ?: return
                autoFitColumn(table, boundary)
            }
        })
    }

    private fun autoFitColumn(table: JTable, index: Int) {
        val metrics = table.getFontMetrics(table.font)
        var width = 0
        for (row in 0 until table.rowCount) {
            val text = table.getValueAt(row, index)?.toString() ?: continue
            width = maxOf(width, metrics.stringWidth(text))
        }
        if (width <= 0) return
        val column = table.columnModel.getColumn(index)
        column.preferredWidth = (width + JBUI.scale(20))
            .coerceIn(column.minWidth, minOf(column.maxWidth, JBUI.scale(640)))
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
        expandAllButton.addActionListener { setAllGroupsCollapsed(false) }
        collapseAllButton.addActionListener { setAllGroupsCollapsed(true) }

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

    /** 单击来源分组行：展开 / 折叠该来源下的问题 */
    private fun toggleGroup(source: IssueSource) {
        if (!collapsedSources.remove(source)) {
            collapsedSources.add(source)
        }
        rebuildIssueRows()
        updateSummaryTabs()
    }

    private fun setAllGroupsCollapsed(collapsed: Boolean) {
        val sources = visibleSources()
        if (collapsed) {
            collapsedSources.addAll(sources)
        } else {
            collapsedSources.removeAll(sources.toSet())
        }
        rebuildIssueRows()
    }

    private fun visibleSources(): List<IssueSource> {
        val selected = selectedSource
        return SOURCE_ORDER.filter { source ->
            currentIssues.any { it.source == source } && (selected == null || selected == source)
        }
    }

    private fun rebuildIssueRows() {
        val rows = mutableListOf<ListRow>()
        visibleSources().forEach { source ->
            val group = currentIssues.filter { it.source == source }
            val collapsed = collapsedSources.contains(source)
            rows += ListRow.Group(source, group.size, !collapsed)
            if (!collapsed) {
                group.forEach { rows += ListRow.Entry(it) }
            }
        }
        issueModel.setRows(rows)
    }

    /** 下拉框与分组标题同步显示各来源条数（受等级与搜索条件影响） */
    private fun updateSourceFilter(counts: Map<IssueSource, Int>, total: Int) {
        if (sourceFilter.isPopupVisible) return
        val items = buildList {
            add(SourceFilterItem(null, "全部 ($total)"))
            SOURCE_ORDER.forEach { source ->
                add(SourceFilterItem(source, "${source.label} (${counts[source] ?: 0})"))
            }
        }
        val labels = items.map { it.label }
        val current = sourceFilter.selectedItem as? SourceFilterItem
        if (labels == lastSourceFilterLabels && current?.source == selectedSource) {
            return
        }
        lastSourceFilterLabels = labels
        val target = items.firstOrNull { it.source == selectedSource } ?: items.first()
        suppressSourceEvents = true
        try {
            sourceFilter.model = DefaultComboBoxModel(items.toTypedArray())
            sourceFilter.selectedItem = target
        } finally {
            suppressSourceEvents = false
        }
    }

    private fun updateSummaryTabs() {
        val hasGroups = visibleSources().isNotEmpty()
        expandAllButton.isVisible = hasGroups
        collapseAllButton.isVisible = hasGroups
        expandAllButton.parent?.revalidate()
    }

    /** 等级标签选中时用等级色胶囊，取消筛选后变灰，避免所有标签看起来一样 */
    private fun refreshSeverityChipStyles() {
        severityButtons.forEach { (severity, chip) ->
            val selected = chip.isSelected
            chip.foreground = if (selected) severityForeground(severity) else MUTED_FOREGROUND
            chip.background = if (selected) severityBackground(severity) else CHIP_OFF_BACKGROUND
            chip.border = RoundedBorder(
                if (selected) severityForeground(severity) else MUTED_FOREGROUND,
                JBUI.scale(12),
                JBUI.scale(1)
            )
        }
    }

    private fun showIssueDetail(issue: Issue?) {
        if (issue == null) {
            issueDetail.text = DETAIL_PLACEHOLDER
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
        val hasRoot = service.root != null
        scanButton.isEnabled = !busy && hasRoot
        scanButton.toolTipText = if (state.result != null) "重新扫描项目" else "开始扫描"
        pauseButton.isVisible = state.scanning && !state.paused
        resumeButton.isVisible = state.scanning && state.paused
        stopButton.isVisible = state.scanning
        pauseButton.isEnabled = state.scanning && !state.paused
        resumeButton.isEnabled = state.scanning && state.paused
        stopButton.isEnabled = state.scanning
        toolbar.revalidate()
        toolbar.repaint()
        deepFixButton.isEnabled = !busy && hasRoot
        upgradeButton.isEnabled = !busy && hasRoot
        copyButton.isEnabled = hasRoot
        exportButton.isEnabled = hasRoot

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
        } else {
            // 空闲态不保留进度条：隐藏后立刻让父容器重新布局，避免留下一块空白
            catBar.stop()
            if (progressPanel.isVisible) {
                progressPanel.isVisible = false
                progressPanel.parent?.revalidate()
                progressPanel.parent?.repaint()
            }
        }
        wasBusy = busy

        val result = state.result
        val buildHint = result?.buildHint
        buildHintPanel.isVisible = !buildHint.isNullOrBlank()
        buildHintLabel.text = buildHint ?: ""
        buildHintLabel.toolTipText = buildHint

        updateSummary(result)
        if (!hasRoot) {
            statusLabel.text = "请先打开 Maven 项目"
        }
        refreshIssueTable()
        refreshIgnoredTable(result)
        refreshSuggestions(result)
        refreshErrors(result)
        updateSummaryTabs()
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
            currentIssues = emptyList()
            issueModel.setRows(emptyList())
            updateSourceFilter(emptyMap(), 0)
            return
        }
        val query = searchField.text.trim().lowercase()
        val enabledSeverities = severityButtons.filterValues { it.isSelected }.keys
        val base = result.issues.filter { issue ->
            issue.severity in enabledSeverities && matchesQuery(issue, query)
        }
        val counts = IssueSource.entries.associateWith { source -> base.count { it.source == source } }
        // 选中的来源被筛没了就回退到「全部」，避免下拉框显示与列表不一致
        if (selectedSource != null && (counts[selectedSource] ?: 0) == 0 && base.isNotEmpty()) {
            selectedSource = null
        }
        updateSourceFilter(counts, base.size)
        currentIssues = selectedSource?.let { source -> base.filter { it.source == source } } ?: base
        rebuildIssueRows()
    }

    private fun matchesQuery(issue: Issue, query: String): Boolean {
        if (query.isEmpty()) return true
        val hay = (issue.file ?: "") + " " + issue.rule + " " + issue.message + " " + (issue.zhSummary ?: "")
        return hay.lowercase().contains(query)
    }

    private fun refreshIgnoredTable(result: ScanResult?) {
        ignoredModel.setRows((result?.ignored ?: emptyList()).map { ListRow.Entry(it) })
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
        private val rows = mutableListOf<ListRow>()
        private val columns = arrayOf("级别", "来源", "规则", "位置", "说明")

        fun setRows(newRows: List<ListRow>) {
            rows.clear()
            rows.addAll(newRows)
            fireTableDataChanged()
        }

        fun itemAt(index: Int): ListRow? = rows.getOrNull(index)

        /** 分组标题行返回 null，只有具体问题行才有 Issue */
        fun rowAt(index: Int): Issue? = (rows.getOrNull(index) as? ListRow.Entry)?.issue

        override fun getRowCount(): Int = rows.size
        override fun getColumnCount(): Int = columns.size
        override fun getColumnName(column: Int): String = columns[column]

        override fun getValueAt(rowIndex: Int, columnIndex: Int): Any =
            when (val item = rows[rowIndex]) {
                is ListRow.Group -> when (columnIndex) {
                    0 -> if (item.expanded) "▾" else "▸"
                    1 -> item.source.label
                    COUNT_COLUMN -> "${item.count} 项"
                    else -> ""
                }
                is ListRow.Entry -> {
                    val issue = item.issue
                    val dir = service.root?.path ?: ""
                    when (columnIndex) {
                        0 -> issue.severity.label
                        1 -> issue.source.label
                        2 -> issue.rule
                        LOCATION_COLUMN -> {
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
    }

    /** 分组标题行加粗独占一行，问题行按等级着色的可选单元格渲染 */
    private class IssueTableRenderer(private val model: IssueTableModel) : DefaultTableCellRenderer() {
        override fun getTableCellRendererComponent(
            table: JTable, value: Any?, isSelected: Boolean, hasFocus: Boolean, row: Int, column: Int
        ): Component {
            val component = super.getTableCellRendererComponent(table, value, isSelected, hasFocus, row, column)
            val label = component as? JLabel
            label?.toolTipText = null
            when (val item = model.itemAt(table.convertRowIndexToModel(row))) {
                is ListRow.Group -> {
                    if (!isSelected) {
                        component.background = GROUP_BACKGROUND
                        component.foreground = if (column == COUNT_COLUMN) MUTED_FOREGROUND else table.foreground
                    }
                    component.font = component.font.deriveFont(Font.BOLD)
                    label?.toolTipText = "单击展开或折叠「${item.source.label}」"
                }
                is ListRow.Entry -> {
                    if (!isSelected) {
                        component.background = when {
                            column == 0 -> severityBackground(item.issue.severity)
                            row % 2 == 1 -> ROW_ALT_BACKGROUND
                            else -> table.background
                        }
                        component.foreground = when (column) {
                            0 -> severityForeground(item.issue.severity)
                            LOCATION_COLUMN -> LINK_FOREGROUND
                            else -> table.foreground
                        }
                    }
                    component.font = component.font.deriveFont(if (column == 0) Font.BOLD else Font.PLAIN)
                    label?.toolTipText = when (column) {
                        2 -> value?.toString()
                        LOCATION_COLUMN -> value?.toString()?.takeIf { it.isNotBlank() }?.let { "$it（单击跳转）" }
                        else -> null
                    }
                }
                null -> {
                    if (!isSelected) {
                        component.background = table.background
                        component.foreground = table.foreground
                    }
                    component.font = component.font.deriveFont(Font.PLAIN)
                }
            }
            return component
        }
    }
}

private const val COUNT_COLUMN = 2
private const val LOCATION_COLUMN = 3
private const val COLUMN_WIDTHS_KEY = "quality.center.issue.columnWidths"
private const val DETAIL_PLACEHOLDER = "选中一条问题查看完整说明。\n提示：单击任意一行可直接跳转到对应代码。"

/** 与 VS Code 版一致的分组顺序 */
private val SOURCE_ORDER = listOf(
    IssueSource.CHECKSTYLE,
    IssueSource.GITLEAKS,
    IssueSource.SPOTBUGS,
    IssueSource.TRIVY
)

private val GROUP_BACKGROUND = JBColor(Color(0xE8EDF3), Color(0x34373C))
private val MUTED_FOREGROUND = JBColor(Color(0x6B7280), Color(0x9AA1A9))
private val LINK_FOREGROUND = JBColor(Color(0x2C6BE0), Color(0x7FA8FF))
private val CHIP_OFF_BACKGROUND = JBColor(Color(0xECEEF2), Color(0x3C3F44))
private val ROW_ALT_BACKGROUND = JBColor(Color(0xF7F9FC), Color(0x2B2D31))

private fun severityForeground(severity: Severity): Color = when (severity) {
    Severity.CRITICAL -> JBColor(Color(224, 62, 62), Color(255, 122, 122))
    Severity.HIGH -> JBColor(Color(232, 100, 40), Color(255, 160, 96))
    Severity.MEDIUM -> JBColor(Color(196, 148, 20), Color(226, 190, 84))
    Severity.LOW -> JBColor(Color(46, 128, 210), Color(110, 178, 255))
    Severity.INFO -> JBColor(Color(120, 132, 145), Color(140, 150, 160))
}

/** 级别单元格的浅底色，让不同等级的行在缩窄的列里也能一眼区分 */
private fun severityBackground(severity: Severity): Color = when (severity) {
    Severity.CRITICAL -> JBColor(Color(0xFBE7E7), Color(0x4A2727))
    Severity.HIGH -> JBColor(Color(0xFDEEE4), Color(0x4A3325))
    Severity.MEDIUM -> JBColor(Color(0xFBF4DB), Color(0x453A1F))
    Severity.LOW -> JBColor(Color(0xE8F1FB), Color(0x22384A))
    Severity.INFO -> JBColor(Color(0xEFF1F4), Color(0x2F3337))
}

/** 圆角边框：让等级胶囊、分组小标签更接近 VS Code 的 chip 观感 */
private class RoundedBorder(
    private val color: Color,
    private val radius: Int,
    private val thickness: Int
) : javax.swing.border.AbstractBorder() {
    override fun paintBorder(c: Component, g: Graphics, x: Int, y: Int, width: Int, height: Int) {
        g.color = color
        g.drawRoundRect(x, y, width - 1, height - 1, radius, radius)
    }

    override fun getBorderInsets(c: Component): Insets =
        Insets(thickness, thickness, thickness, thickness)
}
