package com.dsda56180.qualitycenter.ui

import com.intellij.ui.JBColor
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.Color
import java.awt.Dimension
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.Rectangle
import java.awt.RenderingHints
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JScrollBar
import javax.swing.JScrollPane
import javax.swing.plaf.basic.BasicScrollBarUI

/**
 * 细滚动条：IDEA 默认滚动条在深色主题下轨道会画成一条很粗的浅色带，
 * 这里改成透明轨道 + 6px 圆角滑块，贴合新版 IDEA 的细滚动条观感。
 */
private class ThinScrollBarUI : BasicScrollBarUI() {

    override fun paintTrack(g: Graphics, c: JComponent, trackBounds: Rectangle) = Unit

    override fun paintThumb(g: Graphics, c: JComponent, thumbBounds: Rectangle) {
        if (thumbBounds.isEmpty || !scrollbar.isEnabled) return
        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g2.color = THUMB
            val arc = JBUI.scale(6)
            g2.fillRoundRect(
                thumbBounds.x + 1,
                thumbBounds.y + 1,
                (thumbBounds.width - 2).coerceAtLeast(1),
                (thumbBounds.height - 2).coerceAtLeast(1),
                arc,
                arc
            )
        } finally {
            g2.dispose()
        }
    }

    override fun createDecreaseButton(orientation: Int): JButton = invisibleButton()

    override fun createIncreaseButton(orientation: Int): JButton = invisibleButton()

    private fun invisibleButton() = JButton().apply {
        preferredSize = Dimension(0, 0)
        minimumSize = Dimension(0, 0)
        maximumSize = Dimension(0, 0)
        isOpaque = false
        isFocusable = false
        isVisible = false
    }

    private companion object {
        val THUMB: Color = JBColor(Color(0xB9BEC6), Color(0x5E646D))
    }
}

/** 统一的细滚动条容器，替换默认 JBScrollPane 的粗浅色滚动条 */
internal fun thinScrollPane(component: JComponent): JBScrollPane {
    val scroll = JBScrollPane(component)
    // 明确按需显示：一旦被设成 NEVER 就再也滚不动了
    scroll.horizontalScrollBarPolicy = JScrollPane.HORIZONTAL_SCROLLBAR_AS_NEEDED
    scroll.verticalScrollBarPolicy = JScrollPane.VERTICAL_SCROLLBAR_AS_NEEDED
    scroll.horizontalScrollBar.applyThin(JScrollBar.HORIZONTAL)
    scroll.verticalScrollBar.applyThin(JScrollBar.VERTICAL)
    return scroll
}

private fun JScrollBar.applyThin(orientation: Int) {
    setUI(ThinScrollBarUI())
    isOpaque = false
    border = JBUI.Borders.empty()
    if (orientation == JScrollBar.HORIZONTAL) {
        preferredSize = Dimension(0, JBUI.scale(8))
        minimumSize = Dimension(0, JBUI.scale(8))
    } else {
        preferredSize = Dimension(JBUI.scale(8), 0)
        minimumSize = Dimension(JBUI.scale(8), 0)
    }
}
