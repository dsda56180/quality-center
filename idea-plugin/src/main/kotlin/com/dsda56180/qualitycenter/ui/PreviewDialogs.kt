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
import java.awt.Font
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.BoxLayout
import javax.swing.JCheckBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JMenuItem
import javax.swing.JPopupMenu
import javax.swing.JScrollPane
import javax.swing.JTable
import javax.swing.JTextArea
import javax.swing.table.AbstractTableModel
import javax.swing.table.TableColumn

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
    private class RenderData(
        val unified: List<DiffLine>,
        val left: List<DiffLine>,
        val right: List<DiffLine>,
        val added: Int,
        val removed: Int
    )

    private val rows = mutableListOf<Row>()
    private val fileDiffs: Map<String, List<String>> = parsePatch(info.patchText)
    private val monoFont: Font = JBUI.Fonts.create("JetBrains Mono", 12)
    private var selectedPath: String? = null
    private var baseBackground: Color? = null
    /** 渲染令牌：切文件时递增，丢弃过期的后台结果 */
    private var renderToken = 0
    /** 预处理结果缓存（key = 路径）：统一 / 并排共用同一份行数据，切模式零成本 */
    private val dataCache = LinkedHashMap<String, RenderData>()

    private val unifiedList = DiffRowList()
    private val leftList = DiffRowList()
    private val rightList = DiffRowList()
    private val pathLabel = JLabel(" ").apply {
        font = JBUI.Fonts.smallFont()
        foreground = MUTED_FOREGROUND
        border = JBUI.Borders.empty(2, 6, 2, 6)
    }
    private val diffCards = JPanel(CardLayout())
    private val modeSwitch = ModeSwitch(listOf("统一", "并排")) { index -> applyMode(index == 1) }

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
        listOf(unifiedList, leftList, rightList).forEach {
            it.font = monoFont
            it.background = root.background
        }

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
        val unifiedScroll = thinScrollPane(unifiedList)
        diffCards.add(unifiedScroll, CARD_UNIFIED)

        // 并排视图：左「修改前」、右「修改后」，固定行高保证两栏逐行对齐，滚动与选中联动
        val leftScroll = thinScrollPane(leftList)
        val rightScroll = thinScrollPane(rightList)
        linkScroll(leftScroll, rightScroll)
        linkSelection()
        installCopyMenu(unifiedList)
        installCopyMenu(leftList)
        installCopyMenu(rightList)
        val sidePanel = JPanel(java.awt.GridLayout(1, 2, JBUI.scale(4), 0))
        sidePanel.add(sideBlock("修改前", leftScroll))
        sidePanel.add(sideBlock("修改后", rightScroll))
        diffCards.add(sidePanel, CARD_SIDE_BY_SIDE)

        val modeBar = JPanel(BorderLayout(JBUI.scale(6), 0))
        val hint = JLabel("绿色为新增、红色为删除")
        hint.font = JBUI.Fonts.smallFont()
        hint.foreground = MUTED_FOREGROUND
        modeBar.add(hint, BorderLayout.WEST)
        modeBar.add(modeSwitch, BorderLayout.EAST)

        val diffBlock = JPanel(BorderLayout())
        diffBlock.add(pathLabel, BorderLayout.NORTH)
        diffBlock.add(diffCards, BorderLayout.CENTER)

        val split = Splitter(true)
        split.proportion = 0.34f
        split.setShowDividerControls(false)
        split.setShowDividerIcon(false)
        split.firstComponent = filesScroll
        split.secondComponent = diffBlock

        val center = JPanel(BorderLayout(0, JBUI.scale(2)))
        center.add(split, BorderLayout.CENTER)
        center.add(modeBar, BorderLayout.SOUTH)
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

    private fun applyMode(side: Boolean) {
        (diffCards.layout as CardLayout).show(diffCards, if (side) CARD_SIDE_BY_SIDE else CARD_UNIFIED)
        // 两种视图的数据在切文件时已一起准备好，切模式只需换卡片，不做任何重建
        if (unifiedList.model.size == 0) renderActive()
    }

    private fun showFile(path: String) {
        if (selectedPath == path) return
        selectedPath = path
        baseBackground?.let { bg ->
            rows.forEach { other ->
                other.panel.background = if (other.path == path) ROW_SELECTED_BACKGROUND else bg
                other.panel.repaint()
            }
        }
        renderActive()
    }

    private fun diffLines(path: String): List<String>? = fileDiffs.entries
        .firstOrNull { (key, _) -> key == path || key.endsWith("/$path") || path.endsWith("/$key") }
        ?.value

    /**
     * 切文件时在后台线程把「统一 / 并排」两套行数据一次性准备好（同一份模型，两边内容必然一致），
     * 回到 EDT 只把行列表塞给 JList。JList 是固定行高、只画可见行，不需要文档排版，
     * 因此不再出现"点了要等一下"的卡顿。
     */
    private fun renderActive() {
        val path = selectedPath ?: return
        val token = ++renderToken
        val cached = synchronized(dataCache) { dataCache[path] }
        if (cached != null) {
            applyRender(path, cached)
            return
        }
        val lines = diffLines(path)
        val app = com.intellij.openapi.application.ApplicationManager.getApplication()
        app.executeOnPooledThread {
            val data = try {
                buildRenderData(lines)
            } catch (_: Throwable) {
                buildRenderData(emptyList())
            }
            synchronized(dataCache) {
                if (dataCache.size >= 30) dataCache.keys.firstOrNull()?.let { dataCache.remove(it) }
                dataCache[path] = data
            }
            // 预览是模态对话框：后台线程直接 invokeLater 用的是 NON_MODAL 模态状态，会被挡在队列里，
            // 表现为面板一直空白，必须用 ModalityState.any()
            app.invokeLater({
                if (token != renderToken) return@invokeLater
                applyRender(path, data)
            }, com.intellij.openapi.application.ModalityState.any())
        }
    }

    private fun applyRender(path: String, data: RenderData) {
        pathLabel.text = "${path}    +${data.added} / -${data.removed}"
        val width = listWidth(data)
        unifiedList.showRows(data.unified, width)
        leftList.showRows(data.left, width)
        rightList.showRows(data.right, width)
    }

    /** 按最长一行估算列表宽度：只量一次字符宽度，避免 EDT 上逐行 stringWidth */
    private fun listWidth(data: RenderData): Int {
        var maxCols = 1
        data.unified.forEach { maxCols = maxOf(maxCols, it.text.length) }
        val charWidth = runCatching {
            val image = java.awt.image.BufferedImage(1, 1, java.awt.image.BufferedImage.TYPE_INT_ARGB)
            val g = image.createGraphics()
            g.font = monoFont
            val w = g.fontMetrics.charWidth('M')
            g.dispose()
            w
        }.getOrNull() ?: JBUI.scale(8)
        return maxCols * maxOf(charWidth, 1) + JBUI.scale(24)
    }

    /**
     * 一次生成三种视图的行数据：
     * - unified：全部补丁行，删除行 "-"、新增行 "+"
     * - left / right：按行配对，行数完全相同（缺失侧填空行），因此逐行严格对齐
     */
    private fun buildRenderData(lines: List<String>?): RenderData {
        val unified = ArrayList<DiffLine>()
        val left = ArrayList<DiffLine>()
        val right = ArrayList<DiffLine>()
        if (lines.isNullOrEmpty()) {
            val message = DiffLine("该文件在当前补丁中没有可显示的差异片段。", DiffKind.META)
            unified += message
            left += message
            right += DiffLine("", DiffKind.BLANK)
            return RenderData(unified, left, right, 0, 0)
        }

        var added = 0
        var removed = 0
        var truncated = false
        val removedBuf = ArrayList<String>()
        val addedBuf = ArrayList<String>()

        fun flush() {
            if (removedBuf.isEmpty() && addedBuf.isEmpty()) return
            removedBuf.forEach { unified += DiffLine("-" + it, DiffKind.DELETE) }
            addedBuf.forEach { unified += DiffLine("+" + it, DiffKind.ADD) }
            val count = maxOf(removedBuf.size, addedBuf.size)
            for (index in 0 until count) {
                val old = removedBuf.getOrNull(index)
                val new = addedBuf.getOrNull(index)
                left += if (old != null) DiffLine("-" + old, DiffKind.DELETE) else DiffLine("", DiffKind.BLANK)
                right += if (new != null) DiffLine("+" + new, DiffKind.ADD) else DiffLine("", DiffKind.BLANK)
            }
            removedBuf.clear()
            addedBuf.clear()
        }

        fun addContext(text: String) {
            flush()
            val rendered = DiffLine(" " + text, DiffKind.CONTEXT)
            unified += rendered
            left += rendered
            right += rendered
        }

        fun addBoth(text: String, kind: DiffKind) {
            flush()
            val rendered = DiffLine(text, kind)
            unified += rendered
            left += rendered
            right += rendered
        }

        for ((index, raw) in lines.withIndex()) {
            if (index >= MAX_DIFF_LINES) {
                truncated = true
                break
            }
            val line = prepare(raw)
            when {
                line.startsWith("diff ") || line.startsWith("index ") ||
                    line.startsWith("---") || line.startsWith("+++") -> Unit
                line.startsWith("@@") -> addBoth(line, DiffKind.HUNK)
                line.startsWith("\\") -> addBoth(line, DiffKind.META)
                line.startsWith("+") -> {
                    added++
                    addedBuf += clipLine(line.substring(1))
                }
                line.startsWith("-") -> {
                    removed++
                    removedBuf += clipLine(line.substring(1))
                }
                line.startsWith(" ") -> addContext(clipLine(line.substring(1)))
                else -> addContext(clipLine(line))
            }
        }
        flush()

        if (truncated) {
            addBoth("…… 内容过长，仅显示前 $MAX_DIFF_LINES 行", DiffKind.META)
        }
        return RenderData(unified, left, right, added, removed)
    }

    private fun prepare(line: String): String = line.replace("\t", "    ")

    private fun clipLine(line: String): String =
        if (line.length <= MAX_LINE_LENGTH) line else line.take(MAX_LINE_LENGTH) + " …"

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
            from.horizontalScrollBar.addAdjustmentListener { e ->
                if (guard) return@addAdjustmentListener
                guard = true
                try {
                    to.horizontalScrollBar.value = e.value
                } finally {
                    guard = false
                }
            }
        }
        sync(a, b)
        sync(b, a)
    }

    /** 并排模式下左右选中同一行，配色一致便于对照 */
    private fun linkSelection() {
        var guard = false
        listOf(leftList, rightList).forEach { source ->
            val target = if (source === leftList) rightList else leftList
            source.addListSelectionListener {
                if (guard || it.valueIsAdjusting) return@addListSelectionListener
                val index = source.selectedIndex
                if (index < 0 || index == target.selectedIndex) return@addListSelectionListener
                guard = true
                try {
                    if (index < target.model.size) target.selectedIndex = index
                } finally {
                    guard = false
                }
            }
        }
    }

    private fun installCopyMenu(list: DiffRowList) {
        val menu = JPopupMenu()
        val copyLine = JMenuItem("复制此行")
        copyLine.addActionListener {
            list.selectedValue?.let { copyToClipboard(it.text) }
        }
        val copyAll = JMenuItem("复制全部")
        copyAll.addActionListener {
            val builder = StringBuilder()
            val model = list.model
            for (index in 0 until model.size) {
                if (builder.isNotEmpty()) builder.append('\n')
                builder.append(model.getElementAt(index).text)
            }
            copyToClipboard(builder.toString())
        }
        menu.add(copyLine)
        menu.add(copyAll)
        list.componentPopupMenu = menu
        list.addMouseListener(object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) {
                if (e.isPopupTrigger) {
                    val index = list.locationToIndex(e.point)
                    if (index >= 0) list.selectedIndex = index
                }
            }
        })
    }

    private fun copyToClipboard(text: String) {
        runCatching {
            java.awt.Toolkit.getDefaultToolkit().systemClipboard
                .setContents(java.awt.datatransfer.StringSelection(text), null)
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
        const val MAX_DIFF_LINES = 1200
        const val MAX_LINE_LENGTH = 400
    }
}

/** diff 行的类型：决定前景色与底色 */
private enum class DiffKind { CONTEXT, DELETE, ADD, HUNK, META, BLANK }

private class DiffLine(val text: String, val kind: DiffKind)

private fun diffForeground(kind: DiffKind): Color = when (kind) {
    DiffKind.ADD -> JBColor(Color(0x1B7F3B), Color(0x6EDC93))
    DiffKind.DELETE -> JBColor(Color(0xB4261C), Color(0xFF8078))
    DiffKind.HUNK -> JBColor(Color(0x2C6BE0), Color(0x7FA8FF))
    DiffKind.META, DiffKind.BLANK -> MUTED_FOREGROUND
    else -> JBColor(Color(0x24292F), Color(0xD4D9DF))
}

private fun diffBackground(kind: DiffKind, base: Color): Color = when (kind) {
    DiffKind.ADD -> JBColor(Color(0xE8F5EC), Color(0x2C4235))
    DiffKind.DELETE -> JBColor(Color(0xFBE7E7), Color(0x4A2727))
    DiffKind.BLANK -> JBColor(Color(0xF4F5F7), Color(0x2A2C30))
    DiffKind.HUNK -> JBColor(Color(0xEFF4FD), Color(0x252C38))
    else -> base
}

private class DiffListModel(private val data: List<DiffLine>) : javax.swing.AbstractListModel<DiffLine>() {
    override fun getSize(): Int = data.size
    override fun getElementAt(index: Int): DiffLine = data[index]
}

/**
 * 固定行高的差异列表：一行一个调色块、永不换行、只绘制可见行。
 * 改用文本面板时每换一次文档都要在 EDT 上对上千个段落整体排版（点击卡顿的根源），
 * 而且按宽折行会让左右两栏断行位置不同、逐行错位（"统一和并排内容不一致"的根源）。
 */
private class DiffRowList : javax.swing.JList<DiffLine>() {

    private var preferredWidth = JBUI.scale(200)

    init {
        fixedCellHeight = JBUI.scale(19)
        selectionMode = javax.swing.ListSelectionModel.SINGLE_SELECTION
        isOpaque = true
        cellRenderer = DiffCellRenderer()
    }

    fun showRows(data: List<DiffLine>, width: Int) {
        preferredWidth = width
        model = DiffListModel(data)
        clearSelection()
        revalidate()
        repaint()
        scrollRectToVisible(java.awt.Rectangle(0, 0, 1, 1))
    }

    override fun getPreferredSize(): Dimension =
        Dimension(preferredWidth, maxOf(model.size, 1) * fixedCellHeight + JBUI.scale(6))

    override fun getScrollableTracksViewportWidth(): Boolean = false

    override fun getScrollableUnitIncrement(visibleRect: java.awt.Rectangle, orientation: Int, direction: Int): Int =
        fixedCellHeight
}

private class DiffCellRenderer : javax.swing.ListCellRenderer<DiffLine> {
    private val panel = JPanel(BorderLayout())
    private val label = JLabel()

    init {
        panel.isOpaque = true
        panel.border = JBUI.Borders.empty(0, 6, 0, 6)
        label.isOpaque = false
        panel.add(label, BorderLayout.CENTER)
    }

    override fun getListCellRendererComponent(
        list: javax.swing.JList<out DiffLine>,
        value: DiffLine?,
        index: Int,
        isSelected: Boolean,
        cellHasFocus: Boolean
    ): java.awt.Component {
        val kind = value?.kind ?: DiffKind.CONTEXT
        panel.background = if (isSelected) ROW_SELECTED_BACKGROUND else diffBackground(kind, list.background)
        label.font = list.font
        label.foreground = diffForeground(kind)
        label.text = value?.text ?: ""
        return panel
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
private val SEGMENT_SELECTED_BACKGROUND = JBColor(Color(0xE3EBFA), Color(0x2F3A4E))

/**
 * 紧凑的分段切换（统一 / 并排）：整条自绘、18px 高。
 * 不用 JToggleButton，避免按钮 UI 的内边距把高度撑到 24px 以上、白白占掉一行工具栏。
 */
private class ModeSwitch(
    private val options: List<String>,
    initialIndex: Int = 0,
    private val onSelect: (Int) -> Unit
) : JComponent() {

    private val font = JBUI.Fonts.smallFont().deriveFont(Font.BOLD)
    private val padX = JBUI.scale(7)
    private val stripHeight = JBUI.scale(18)
    private var hovered = -1

    var selectedIndex: Int = initialIndex
        private set

    init {
        isOpaque = false
        isFocusable = false
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        toolTipText = " "
        addMouseListener(object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) {
                indexAt(e.x)?.let { select(it) }
            }

            override fun mouseExited(e: MouseEvent) {
                if (hovered != -1) {
                    hovered = -1
                    repaint()
                }
            }
        })
        addMouseMotionListener(object : MouseAdapter() {
            override fun mouseMoved(e: MouseEvent) {
                val index = indexAt(e.x) ?: -1
                if (index != hovered) {
                    hovered = index
                    repaint()
                }
            }
        })
    }

    private fun select(index: Int) {
        if (index == selectedIndex) return
        selectedIndex = index
        repaint()
        onSelect(index)
    }

    override fun getPreferredSize(): Dimension = Dimension(widths().sum(), stripHeight)

    override fun getMinimumSize(): Dimension = preferredSize

    override fun getMaximumSize(): Dimension = Dimension(preferredSize.width, stripHeight)

    private fun widths(): List<Int> {
        val fm = getFontMetrics(font)
        return options.map { fm.stringWidth(it) + padX * 2 }
    }

    private fun indexAt(x: Int): Int? {
        var start = 0
        widths().forEachIndexed { index, width ->
            if (x >= start && x < start + width) return index
            start += width
        }
        return null
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g2.font = font
            val fm = g2.fontMetrics
            var x = 0
            widths().forEachIndexed { index, width ->
                val selected = index == selectedIndex
                if (selected) {
                    g2.color = SEGMENT_SELECTED_BACKGROUND
                    g2.fillRoundRect(x, 0, width - 1, stripHeight - 1, stripHeight, stripHeight)
                } else if (index == hovered) {
                    g2.color = TAB_HOVER_BACKGROUND
                    g2.fillRoundRect(x, 0, width - 1, stripHeight - 1, stripHeight, stripHeight)
                }
                g2.color = if (selected) TAB_ACCENT else MUTED_FOREGROUND
                val baseline = (stripHeight - fm.height) / 2 + fm.ascent
                g2.drawString(options[index], x + padX, baseline)
                x += width
            }
        } finally {
            g2.dispose()
        }
    }
}

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
