package com.dsda56180.qualitycenter.ui

import com.dsda56180.qualitycenter.model.IssueSource
import com.dsda56180.qualitycenter.model.Severity
import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import java.awt.Color
import java.awt.Cursor
import java.awt.Dimension
import java.awt.Font
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.JComponent

/**
 * 等级筛选：自绘一排紧凑胶囊。
 *
 * 之前用 JToggleButton，按钮 UI 自带的内边距会把高度撑到 30px 以上，放进 BorderLayout 后
 * 还会被拉伸；五个等级一起放不下时又会把后面两个裁掉。这里整条自绘：高度由字体度量决定
 * （19px），宽度不够时只压缩左右内边距，绝不裁掉任何一个等级。
 */
internal class SeverityChipStrip(private val onToggle: (Severity) -> Unit) : JComponent() {

    private val chipFont: Font = JBUI.Fonts.smallFont().deriveFont(Font.BOLD)
    private val padX = JBUI.scale(8)
    private val minPadX = JBUI.scale(3)
    private val gap = JBUI.scale(6)
    private val stripHeight = JBUI.scale(19)

    private var counts: Map<Severity, Int> = emptyMap()
    private var enabled: Set<Severity> = Severity.entries.toSet()
    private var hovered: Severity? = null

    init {
        isOpaque = false
        isFocusable = false
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        toolTipText = " "
        addMouseListener(object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) {
                severityAt(e.x, e.y)?.let(onToggle)
            }

            override fun mouseExited(e: MouseEvent) {
                if (hovered != null) {
                    hovered = null
                    repaint()
                }
            }
        })
        addMouseMotionListener(object : MouseAdapter() {
            override fun mouseMoved(e: MouseEvent) {
                val severity = severityAt(e.x, e.y)
                if (severity != hovered) {
                    hovered = severity
                    repaint()
                }
            }
        })
    }

    fun update(newCounts: Map<Severity, Int>, newEnabled: Set<Severity>) {
        counts = newCounts
        if (newEnabled != enabled) enabled = newEnabled
        revalidate()
        repaint()
    }

    override fun getPreferredSize(): Dimension {
        val width = measure(Int.MAX_VALUE).lastOrNull()?.let { it.first + it.second } ?: 0
        return Dimension(width, stripHeight)
    }

    override fun getMinimumSize(): Dimension = Dimension(JBUI.scale(40), stripHeight)

    override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, stripHeight)

    override fun getToolTipText(e: MouseEvent): String? =
        severityAt(e.x, e.y)?.let { severity ->
            val action = if (severity in enabled) "隐藏" else "显示"
            "$action「${severity.label}」问题"
        }

    override fun paintComponent(g: Graphics) {
        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g2.font = chipFont
            val metrics = g2.fontMetrics
            val baseline = (stripHeight - metrics.height) / 2 + metrics.ascent
            Severity.entries.forEachIndexed { index, severity ->
                val (x, width) = measure(width)[index]
                val arc = stripHeight
                val on = severity in enabled
                if (on) {
                    g2.color = severityBackground(severity)
                    g2.fillRoundRect(x, 0, width - 1, stripHeight - 1, arc, arc)
                    g2.color = if (severity == hovered) severityForeground(severity).darker() else severityForeground(severity)
                    g2.drawRoundRect(x, 0, width - 1, stripHeight - 1, arc, arc)
                } else {
                    g2.color = CHIP_OFF_BACKGROUND
                    g2.fillRoundRect(x, 0, width - 1, stripHeight - 1, arc, arc)
                }
                g2.color = if (on) severityForeground(severity) else MUTED_FOREGROUND
                val text = chipText(severity)
                val textX = x + (width - metrics.stringWidth(text)) / 2
                g2.drawString(text, textX, baseline)
            }
        } finally {
            g2.dispose()
        }
    }

    private fun chipText(severity: Severity): String = "${severity.label} ${counts[severity] ?: 0}"

    /** 每个胶囊的 (起点, 宽度)；宽度不够时只压缩内边距，保证五个等级都完整可见 */
    private fun measure(available: Int): List<Pair<Int, Int>> {
        val fm = getFontMetrics(chipFont)
        val texts = Severity.entries.map { chipText(it) }
        val textTotal = texts.sumOf { fm.stringWidth(it) }
        val count = Severity.entries.size
        val remaining = available - textTotal - gap * (count - 1)
        val pad = if (remaining <= 0) minPadX else (remaining / (count * 2)).coerceIn(minPadX, padX)
        var x = 0
        return texts.map { text ->
            val width = fm.stringWidth(text) + pad * 2
            val rect = x to width
            x += width + gap
            rect
        }
    }

    private fun severityAt(x: Int, y: Int): Severity? {
        if (y < 0 || y > stripHeight) return null
        val rects = measure(width)
        Severity.entries.forEachIndexed { index, severity ->
            val (start, rectWidth) = rects[index]
            if (x >= start && x < start + rectWidth) return severity
        }
        return null
    }
}

/**
 * 来源筛选：仿新版 IDEA 工具窗口的标签条，选中项加粗并带主题色下划线。
 *
 * 用 JBTabs 当筛选器时，工具窗口一窄就出现溢出菜单和上下箭头，标签被挤走；
 * 选中空来源还会因为内容区占位而串到别的列表。改成自绘标签条后，五个来源始终完整可见，
 * 选中状态与列表内容只由 selectedSource 单点驱动。
 */
internal class SourceTabStrip(private val onSelect: (IssueSource?) -> Unit) : JComponent() {

    private val measureFont = JBUI.Fonts.label().deriveFont(Font.BOLD)
    private val normalFont = JBUI.Fonts.label()
    private val selectedFont = measureFont
    private val countFont = JBUI.Fonts.smallFont()
    private val padX = JBUI.scale(9)
    private val minPadX = JBUI.scale(3)
    private val gap = JBUI.scale(2)
    private val stripHeight = JBUI.scale(27)

    private var counts: Map<IssueSource, Int> = emptyMap()
    private var total: Int = 0
    private var selectedSource: IssueSource? = null
    private var hoveredIndex: Int = -1

    private val items: List<IssueSource?> = buildList {
        add(null)
        addAll(SOURCE_ORDER)
    }

    init {
        isOpaque = false
        isFocusable = false
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        toolTipText = " "
        addMouseListener(object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) {
                val index = tabAt(e.x, e.y) ?: return
                val source = items[index]
                if (source != selectedSource) {
                    selectedSource = source
                    repaint()
                    onSelect(source)
                }
            }

            override fun mouseExited(e: MouseEvent) {
                if (hoveredIndex != -1) {
                    hoveredIndex = -1
                    repaint()
                }
            }
        })
        addMouseMotionListener(object : MouseAdapter() {
            override fun mouseMoved(e: MouseEvent) {
                val index = tabAt(e.x, e.y) ?: -1
                if (index != hoveredIndex) {
                    hoveredIndex = index
                    repaint()
                }
            }
        })
    }

    fun update(newCounts: Map<IssueSource, Int>, newTotal: Int, source: IssueSource?) {
        counts = newCounts
        total = newTotal
        if (source != selectedSource) selectedSource = source
        revalidate()
        repaint()
    }

    override fun getPreferredSize(): Dimension = Dimension(0, stripHeight)

    override fun getMinimumSize(): Dimension = Dimension(0, stripHeight)

    override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, stripHeight)

    override fun getToolTipText(e: MouseEvent): String? {
        val index = tabAt(e.x, e.y) ?: return null
        val source = items[index]
        val count = if (source == null) total else counts[source] ?: 0
        val name = if (source == null) "全部来源" else source.label
        return "只看$name（$count 项）"
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g2.color = TAB_SEPARATOR
            g2.fillRect(0, height - 1, width, 1)

            items.forEachIndexed { index, source ->
                val (x, tabWidth) = measure(width)[index]
                val isSelected = source == selectedSource
                if (index == hoveredIndex && !isSelected) {
                    g2.color = TAB_HOVER_BACKGROUND
                    g2.fillRoundRect(x, JBUI.scale(2), tabWidth - 1, height - JBUI.scale(4), JBUI.scale(8), JBUI.scale(8))
                }
                val font = if (isSelected) selectedFont else normalFont
                val titleMetrics = g2.getFontMetrics(font)
                val baseline = (height - titleMetrics.height) / 2 + titleMetrics.ascent
                val pad = padFor(width)
                g2.color = if (isSelected) TAB_SELECTED_FOREGROUND else TAB_FOREGROUND
                g2.font = font
                g2.drawString(title(source), x + pad, baseline)
                g2.font = countFont
                g2.color = if (isSelected) TAB_ACCENT else MUTED_FOREGROUND
                val countText = count(source).toString()
                g2.drawString(
                    countText,
                    x + pad + titleMetrics.stringWidth(title(source)) + JBUI.scale(5),
                    baseline - JBUI.scale(1)
                )
                if (isSelected) {
                    g2.color = TAB_ACCENT
                    g2.fillRoundRect(
                        x + JBUI.scale(4), height - JBUI.scale(3),
                        tabWidth - JBUI.scale(8), JBUI.scale(2), JBUI.scale(2), JBUI.scale(2)
                    )
                }
            }
        } finally {
            g2.dispose()
        }
    }

    private fun title(source: IssueSource?): String = if (source == null) "全部" else source.label

    private fun count(source: IssueSource?): Int = if (source == null) total else counts[source] ?: 0

    private fun textWidth(fm: java.awt.FontMetrics, index: Int): Int {
        val source = items[index]
        return fm.stringWidth(title(source)) + JBUI.scale(5) +
            getFontMetrics(countFont).stringWidth(count(source).toString())
    }

    /** 标签左右内边距：宽度不够时优先压缩它，而不是裁掉后面的标签 */
    private fun padFor(available: Int): Int {
        val textTotal = items.indices.sumOf { textWidth(getFontMetrics(measureFont), it) }
        val remaining = available - textTotal - gap * (items.size - 1)
        return if (remaining <= 0) minPadX else (remaining / (items.size * 2)).coerceIn(minPadX, padX)
    }

    /** 每个标签的 (起点, 宽度) */
    private fun measure(available: Int): List<Pair<Int, Int>> {
        val fm = getFontMetrics(measureFont)
        val pad = padFor(available)
        var x = 0
        return items.indices.map { index ->
            val width = textWidth(fm, index) + pad * 2
            val rect = x to width
            x += width + gap
            rect
        }
    }

    private fun tabAt(x: Int, y: Int): Int? {
        if (y < 0 || y > stripHeight) return null
        val rects = measure(width)
        items.indices.forEach { index ->
            val (start, rectWidth) = rects[index]
            if (x >= start && x < start + rectWidth) return index
        }
        return null
    }
}

internal val TAB_FOREGROUND: Color = JBColor(Color(0x4A5560), Color(0xA9AFB6))
internal val TAB_SELECTED_FOREGROUND: Color = JBColor(Color(0x1F2A33), Color(0xE6E9EC))
internal val TAB_ACCENT: Color = JBColor(Color(0x2C6BE0), Color(0x7FA8FF))
internal val TAB_SEPARATOR: Color = JBColor(Color(0xD8DDE3), Color(0x393C41))
internal val TAB_HOVER_BACKGROUND: Color = JBColor(Color(0xEEF2F7), Color(0x35383D))
