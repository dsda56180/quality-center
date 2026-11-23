package com.dsda56180.qualitycenter.ui

import com.dsda56180.qualitycenter.model.ScanProgress
import com.dsda56180.qualitycenter.model.StageProgress
import com.intellij.util.ui.JBUI
import java.awt.BasicStroke
import java.awt.Color
import java.awt.Dimension
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.LinearGradientPaint
import java.awt.RenderingHints
import java.awt.geom.Path2D
import java.awt.geom.Point2D
import java.awt.geom.RoundRectangle2D
import javax.swing.JComponent
import javax.swing.Timer
import javax.swing.UIManager
import kotlin.math.sin

/**
 * 猫咪进度条：底部蓝色填充表示真实完成度，上方猫队从左向右循环奔跑。
 * 跑到右端后直接回到左侧重新进入，避免出现可见的回拉动画。
 */
class CatProgressBar : JComponent() {

    private val timer = Timer(33) { tick() }
    private var progress: ScanProgress? = null
    private var stage: StageProgress? = null
    private var paused = false
    private var completed = false
    private var travel = -60.0
    private var lastTick = 0L
    /** 填充区上的高光扫过相位 */
    private var shimmer = 0.0
    /** 未知进度时来回扫动的色带相位 */
    private var sweep = 0.0

    init {
        isOpaque = false
        preferredSize = Dimension(JBUI.scale(420), JBUI.scale(56))
        minimumSize = Dimension(JBUI.scale(120), JBUI.scale(56))
    }

    fun start() {
        if (!timer.isRunning) {
            lastTick = 0L
            timer.start()
        }
    }

    fun stop() {
        timer.stop()
    }

    fun update(progress: ScanProgress?, stage: StageProgress?, paused: Boolean) {
        this.progress = progress
        this.stage = stage
        this.paused = paused
        this.completed = false
        start()
        repaint()
    }

    fun markCompleted() {
        completed = true
        repaint()
    }

    private fun unitCount(): Int {
        val total = stage?.total ?: progress?.total ?: 0
        return total.coerceIn(0, 10)
    }

    private fun doneCount(): Int {
        return stage?.done ?: progress?.done ?: 0
    }

    private fun ratio(): Double {
        if (completed) return 1.0
        val currentStage = stage
        if (currentStage != null && currentStage.total > 0) {
            return ((currentStage.done + 1).toDouble() / currentStage.total).coerceIn(0.0, 1.0)
        }
        val current = progress
        if (current != null && current.total > 0) {
            return (current.done.toDouble() / current.total).coerceIn(0.0, 1.0)
        }
        return 0.0
    }

    private fun tick() {
        val now = System.currentTimeMillis()
        if (lastTick == 0L) lastTick = now
        val delta = (now - lastTick).coerceAtMost(64L)
        lastTick = now
        if (!paused && !completed) {
            // 进度未知时（例如深度修复单阶段）也要有动效，否则只是一块灰条
            shimmer += delta * 0.0016
            if (shimmer > 1.0) shimmer -= 1.0
            sweep += delta * 0.0008
            if (sweep > 1.0) sweep -= 1.0
        }
        if (!paused && unitCount() > 0 && !completed) {
            travel += delta * 0.09
            if (travel > width + JBUI.scale(40)) {
                travel = -60.0
            }
        }
        repaint()
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            val scale = JBUI.scale(1f)
            val trackHeight = 11f * scale
            val trackY = height - trackHeight - 3f * scale
            val trackWidth = width.toFloat()

            g2.color = trackBackground()
            g2.fill(RoundRectangle2D.Float(0f, trackY, trackWidth, trackHeight, trackHeight, trackHeight))

            val accent = fillColor()
            val r = ratio()
            if (r > 0) {
                // 已知进度：按比例填充，并叠一层流动高光
                val fillWidth = (trackWidth * r.toFloat()).coerceAtLeast(8f * scale)
                drawFill(g2, 0f, trackY, fillWidth, trackHeight, accent)
            } else {
                // 未知进度（如单阶段深度修复）：用一条来回扫动的彩色光带表示进行中
                val bandWidth = (trackWidth * 0.34f).coerceAtLeast(60f * scale)
                val bandX = (trackWidth + bandWidth) * sweep.toFloat() - bandWidth
                drawFill(g2, bandX, trackY, bandWidth, trackHeight, accent)
            }

            if (unitCount() > 0) {
                drawCats(g2, trackY)
            }
        } finally {
            g2.dispose()
        }
    }

    /** 彩色渐变填充 + 高光扫过，让进度条在深色主题下也有明显的动态感 */
    private fun drawFill(g2: Graphics2D, x: Float, y: Float, w: Float, h: Float, color: Color) {
        if (w <= 0f) return
        val scale = JBUI.scale(1f)
        val end = Color(
            (color.red + (255 - color.red) / 3),
            (color.green + (255 - color.green) / 4),
            (color.blue + (255 - color.blue) / 6)
        )
        g2.paint = LinearGradientPaint(
            Point2D.Float(x, y),
            Point2D.Float((x + w).coerceAtLeast(x + 1f), y),
            floatArrayOf(0f, 1f),
            arrayOf(color, end)
        )
        val shape = RoundRectangle2D.Float(x, y, w, h, h, h)
        g2.fill(shape)

        val bandWidth = (w * 0.55f).coerceAtLeast(28f * scale)
        val bandX = x - bandWidth + (w + bandWidth) * shimmer.toFloat()
        g2.paint = LinearGradientPaint(
            Point2D.Float(bandX, y),
            Point2D.Float((bandX + bandWidth).coerceAtLeast(bandX + 1f), y),
            floatArrayOf(0f, 0.5f, 1f),
            arrayOf(Color(255, 255, 255, 0), Color(255, 255, 255, 120), Color(255, 255, 255, 0))
        )
        g2.fill(shape)
    }

    private fun drawCats(g2: Graphics2D, trackY: Float) {
        val total = unitCount()
        val done = if (completed) total else doneCount()
        val remaining = (total - done).coerceAtLeast(0)
        val size = JBUI.scale(24).toFloat()
        val gap = JBUI.scale(6).toFloat()
        val baseY = trackY - size
        val phase = System.currentTimeMillis() / 220.0

        for (index in 0 until total) {
            val catX = (travel + index * (size + gap)).toFloat()
            if (catX > width + size || catX < -size * 2) {
                continue
            }
            val bob = if (paused) 0.0 else sin(phase + index * 0.9) * 3.0
            val active = index < remaining || completed
            drawCat(g2, catX, baseY + bob.toFloat(), size, index, active)
        }
    }

    private fun drawCat(g2: Graphics2D, x: Float, y: Float, size: Float, breed: Int, active: Boolean) {
        val colors = CAT_COLORS[breed % CAT_COLORS.size]
        val alpha = if (active) 255 else 90
        val face = Color(colors[0].red, colors[0].green, colors[0].blue, alpha)
        val ear = Color(colors[1].red, colors[1].green, colors[1].blue, alpha)
        val dark = Color(30, 30, 35, alpha)

        val faceX = x + size * 0.08f
        val faceY = y + size * 0.22f
        val faceW = size * 0.84f
        val faceH = size * 0.74f

        // 耳朵
        val leftEar = Path2D.Float().apply {
            moveTo(faceX + faceW * 0.12f, faceY + faceH * 0.2f)
            lineTo(faceX + faceW * 0.28f, faceY - faceH * 0.18f)
            lineTo(faceX + faceW * 0.46f, faceY + faceH * 0.16f)
            closePath()
        }
        val rightEar = Path2D.Float().apply {
            moveTo(faceX + faceW * 0.54f, faceY + faceH * 0.16f)
            lineTo(faceX + faceW * 0.72f, faceY - faceH * 0.18f)
            lineTo(faceX + faceW * 0.88f, faceY + faceH * 0.2f)
            closePath()
        }
        g2.color = ear
        g2.fill(leftEar)
        g2.fill(rightEar)

        // 方形圆角脸
        g2.color = face
        val radius = faceW * 0.28f
        g2.fill(RoundRectangle2D.Float(faceX, faceY, faceW, faceH, radius, radius))

        // 眼睛
        g2.color = dark
        val eyeW = faceW * 0.10f
        val eyeH = faceH * 0.16f
        g2.fillOval((faceX + faceW * 0.28f).toInt(), (faceY + faceH * 0.32f).toInt(), eyeW.toInt().coerceAtLeast(1), eyeH.toInt().coerceAtLeast(1))
        g2.fillOval((faceX + faceW * 0.62f).toInt(), (faceY + faceH * 0.32f).toInt(), eyeW.toInt().coerceAtLeast(1), eyeH.toInt().coerceAtLeast(1))

        // 鼻子
        val nose = Path2D.Float().apply {
            moveTo(faceX + faceW * 0.44f, faceY + faceH * 0.58f)
            lineTo(faceX + faceW * 0.56f, faceY + faceH * 0.58f)
            lineTo(faceX + faceW * 0.50f, faceY + faceH * 0.68f)
            closePath()
        }
        g2.color = Color(226, 120, 140, alpha)
        g2.fill(nose)

        // 胡须
        g2.color = Color(dark.red, dark.green, dark.blue, (alpha * 0.7).toInt())
        g2.stroke = BasicStroke(0.8f * JBUI.scale(1f))
        val whiskerY = (faceY + faceH * 0.6f).toInt()
        g2.drawLine((faceX - faceW * 0.12f).toInt(), whiskerY - 2, (faceX + faceW * 0.18f).toInt(), whiskerY)
        g2.drawLine((faceX - faceW * 0.10f).toInt(), whiskerY + 4, (faceX + faceW * 0.18f).toInt(), whiskerY + 2)
        g2.drawLine((faceX + faceW * 0.82f).toInt(), whiskerY, (faceX + faceW * 1.12f).toInt(), whiskerY - 2)
        g2.drawLine((faceX + faceW * 0.82f).toInt(), whiskerY + 2, (faceX + faceW * 1.10f).toInt(), whiskerY + 4)
    }

    private fun trackBackground(): Color {
        val panel = UIManager.getColor("Panel.background") ?: Color(60, 63, 65)
        return if (panel.red + panel.green + panel.blue > 380) {
            Color(0, 0, 0, 26)
        } else {
            Color(255, 255, 255, 26)
        }
    }

    private fun fillColor(): Color = UIManager.getColor("ProgressBar.foreground") ?: Color(55, 148, 255)

    private companion object {
        /** 10 种猫咪配色：脸 / 耳朵 */
        val CAT_COLORS: List<List<Color>> = listOf(
            listOf(Color(150, 153, 160), Color(220, 158, 132)), // 灰
            listOf(Color(232, 158, 88), Color(246, 196, 150)),  // 橘
            listOf(Color(246, 246, 246), Color(232, 180, 180)),  // 白
            listOf(Color(72, 72, 78), Color(120, 120, 128)),    // 黑
            listOf(Color(214, 178, 140), Color(240, 214, 188)),  // 三花
            listOf(Color(126, 150, 178), Color(176, 196, 220)),  // 蓝灰
            listOf(Color(148, 112, 86), Color(196, 160, 130)),   // 棕
            listOf(Color(244, 226, 196), Color(240, 200, 170)),  // 奶油
            listOf(Color(186, 192, 200), Color(214, 218, 224)),  // 银
            listOf(Color(228, 214, 196), Color(90, 80, 76))      // 重点色
        )
    }
}
