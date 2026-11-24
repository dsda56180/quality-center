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
import javax.swing.Box
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
    val files: List<String>,
    /** true = 内嵌 IDEA 原生 diff 渲染，false = 插件内置的自绘列表 */
    val nativeDiff: Boolean = false,
    /** true = 本次预览复用上次的预演结果，没有重新跑 OpenRewrite */
    val reusedPreview: Boolean = false
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
    private val project: Project,
    private val info: DeepFixPreviewInfo
) : DialogWrapper(project, true) {

    private class Row(val path: String, val box: JCheckBox, val panel: JPanel)
    private class RenderData(
        val unified: List<DiffLine>,
        val left: List<DiffLine>,
        val right: List<DiffLine>,
        val added: Int,
        val removed: Int,
        val maxCols: Int
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
    /** 原生模式的内容缓存（key = 路径）：避免重复读文件、重复套 patch */
    private val nativeCache = LinkedHashMap<String, NativeTexts>()
    /**
     * 点击防抖：连续快速点多个文件时只在最后一次点击 120ms 后真正渲染。
     * 原生面板每次 setRequest 都会重建编辑器，逐次渲染会把 EDT 排满，表现出来就是"越点越卡"。
     */
    private val renderAlarm = com.intellij.util.Alarm(com.intellij.util.Alarm.ThreadToUse.SWING_THREAD, null)

    private val unifiedList = DiffRowList()
    private val leftList = DiffRowList()
    private val rightList = DiffRowList()
    private val pathLabel = JLabel(" ").apply {
        font = JBUI.Fonts.smallFont()
        foreground = MUTED_FOREGROUND
        border = JBUI.Borders.empty(2, 6, 2, 6)
    }
    private val diffCards = JPanel(CardLayout())
    /**
     * 官方内嵌方式：只保留一个 DiffRequestPanel（官方 doApplyRequest 每次 setRequest 都会重建 viewer，
     * 多留几个面板会让多个编辑器同时跑高亮/守护进程，反而更卡）。
     */
    private val nativeHost = JPanel(BorderLayout())
    private var nativePanel: com.intellij.diff.DiffRequestPanel? = null
    /** 原生面板构造失败后置位，后续一律回退内置渲染，避免反复抛异常 */
    private var nativeFailed = false
    private var useNative = info.nativeDiff
    /** 单飞标记：一次渲染未结束时，后续点击只置 queuedRender，避免把 EDT 队列堆满 */
    private var renderInFlight = false
    private var queuedRender = false
    /** 对话框尚未显示时暂存的待渲染请求（此时拿不到 Window，无法创建原生面板） */
    private var pendingNative: Pair<String, NativeTexts>? = null
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
                if (info.reusedPreview) {
                    appendLine("本次复用上次的预演结果（代码或提交有变化会重新预演）。")
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
                val rowHeight = JBUI.scale(24)
                val rowPanel = JPanel(BorderLayout(JBUI.scale(4), 0)).apply {
                    isOpaque = true
                    background = bg
                    border = JBUI.Borders.empty(2, 2)
                    add(checkBox, BorderLayout.WEST)
                    add(label, BorderLayout.CENTER)
                    // BoxLayout 默认拿 JComponent 的最大尺寸（Short.MAX_VALUE）分配剩余空间，
                    // 文件少的时候每行会被拉成几十像素高。这里锁死行高，多余空间交给底部 glue。
                    preferredSize = Dimension(JBUI.scale(600), rowHeight)
                    minimumSize = Dimension(0, rowHeight)
                    maximumSize = Dimension(Short.MAX_VALUE.toInt(), rowHeight)
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

        filesPanel.add(Box.createVerticalGlue())

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

        // 原生视图：内嵌 IDEA 自己的 diff 面板（真实编辑器，虚拟化渲染）
        nativeHost.isOpaque = false
        diffCards.add(nativeHost, CARD_NATIVE)
        // 对话框还没显示时创建原生面板拿不到 Window，等它真正 show 出来再补渲染
        nativeHost.addHierarchyListener { e ->
            if (e.changeFlags and java.awt.event.HierarchyEvent.SHOWING_CHANGED.toLong() != 0L && nativeHost.isShowing) {
                pendingNative?.let { pending ->
                    pendingNative = null
                    showNative(pending.first, pending.second)
                }
            }
        }

        val modeBar = JPanel(BorderLayout(JBUI.scale(6), 0))
        val hint = JLabel(if (useNative) "由 IDEA 原生对比渲染，布局用面板自带工具栏切换" else "绿色为新增、红色为删除")
        hint.font = JBUI.Fonts.smallFont()
        hint.foreground = MUTED_FOREGROUND
        modeBar.add(hint, BorderLayout.WEST)
        modeSwitch.isVisible = !useNative
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

        info.files.firstOrNull()?.let { showFile(it, immediate = true) }
        prebuildAll()
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
        if (useNative) return
        (diffCards.layout as CardLayout).show(diffCards, if (side) CARD_SIDE_BY_SIDE else CARD_UNIFIED)
        // 两种视图的数据在切文件时已一起准备好，切模式只需换卡片，不做任何重建
        if (unifiedList.model.size == 0) renderActive()
    }

    private fun showFile(path: String, immediate: Boolean = false) {
        if (selectedPath == path) return
        selectedPath = path
        baseBackground?.let { bg ->
            rows.forEach { other ->
                other.panel.background = if (other.path == path) ROW_SELECTED_BACKGROUND else bg
                other.panel.repaint()
            }
        }
        // 立刻给出反馈：即使后面的对比还在生成，也能看到「点到的是哪个文件」
        val counts = countChanges(diffLines(path))
        pathLabel.text = "${path}    +${counts.first} / -${counts.second}"
        if (immediate) renderActive() else scheduleRender()
    }

    private fun scheduleRender() {
        renderAlarm.cancelAllRequests()
        renderAlarm.addRequest({ renderActive() }, RENDER_DEBOUNCE_MS)
    }

    private fun diffLines(path: String): List<String>? = fileDiffs.entries
        .firstOrNull { (key, _) -> key == path || key.endsWith("/$path") || path.endsWith("/$key") }
        ?.value

    /**
     * 单飞（single-flight）：同一时刻只允许一次渲染在跑，中途的点击只记一个"待渲染"标记。
     * 否则连续快速点击会把 N 次 setRequest 排进 EDT 队列，界面看起来像"点了没反应"，
     * 过一段时间再一次性跳到最后一个文件。
     */
    private fun renderActive() {
        val path = selectedPath ?: return
        if (renderInFlight) {
            queuedRender = true
            return
        }
        renderInFlight = true
        try {
            if (useNative) renderNative(path) else renderBuiltIn(path)
        } catch (e: Throwable) {
            // 任何同步异常都要把单飞标记放开，否则后续点击会被永久排队
            logWarn("渲染失败", e)
            finishRender()
        }
    }

    private fun finishRender() {
        renderInFlight = false
        if (queuedRender) {
            queuedRender = false
            scheduleRender()
        }
    }

    /** 内置渲染：固定行高列表，只画可见行 */
    private fun renderBuiltIn(path: String) {
        val token = ++renderToken
        val cached = synchronized(dataCache) { dataCache[path] }
        if (cached != null) {
            try {
                applyRender(path, cached)
            } finally {
                finishRender()
            }
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
                if (dataCache.size >= 400) dataCache.keys.firstOrNull()?.let { dataCache.remove(it) }
                dataCache[path] = data
            }
            // 预览是模态对话框：后台线程直接 invokeLater 用的是 NON_MODAL 模态状态，会被挡在队列里，
            // 表现为面板一直空白，必须用 ModalityState.any()
            app.invokeLater({
                try {
                    if (token == renderToken) applyRender(path, data)
                } finally {
                    finishRender()
                }
            }, com.intellij.openapi.application.ModalityState.any())
        }
    }

    /** 对话框一打开就在后台把所有文件的行数据预处理好，之后点任何条目都是纯内存赋值 */
    private fun prebuildAll() {
        if (useNative) {
            prebuildNative()
            return
        }
        val app = com.intellij.openapi.application.ApplicationManager.getApplication()
        val pending = info.files.filter { synchronized(dataCache) { dataCache[it] } == null }
        if (pending.isEmpty()) return
        app.executeOnPooledThread {
            pending.forEach { path ->
                val data = try {
                    buildRenderData(diffLines(path))
                } catch (_: Throwable) {
                    null
                } ?: return@forEach
                synchronized(dataCache) { dataCache[path] = data }
            }
        }
    }

    /**
     * 原生模式：后台把所有文件的「改前 / 改后」文本一次准备好。
     * 这样点击条目时 EDT 上只剩下 setRequest 一件事，不再有「点击 → 排队 → 读文件 → 再渲染」的延迟链。
     */
    private fun prebuildNative() {
        val app = com.intellij.openapi.application.ApplicationManager.getApplication()
        val pending = info.files.filter { synchronized(nativeCache) { nativeCache[it] } == null }
        if (pending.isEmpty()) return
        app.executeOnPooledThread {
            pending.forEach { path ->
                val texts = try {
                    buildNativeTexts(path, diffLines(path))
                } catch (_: Throwable) {
                    null
                } ?: return@forEach
                synchronized(nativeCache) {
                    if (nativeCache.size >= 200) nativeCache.keys.firstOrNull()?.let { nativeCache.remove(it) }
                    nativeCache[path] = texts
                }
            }
        }
    }

    private fun applyRender(path: String, data: RenderData) {
        pathLabel.text = "${path}    +${data.added} / -${data.removed}"
        val width = data.maxCols * charWidth + JBUI.scale(24)
        unifiedList.showRows(data.unified, width)
        leftList.showRows(data.left, width)
        rightList.showRows(data.right, width)
    }

    /** 等宽字体的字符宽度只量一次 */
    private val charWidth: Int by lazy {
        runCatching {
            val image = java.awt.image.BufferedImage(1, 1, java.awt.image.BufferedImage.TYPE_INT_ARGB)
            val g = image.createGraphics()
            g.font = monoFont
            val w = g.fontMetrics.charWidth('M')
            g.dispose()
            w
        }.getOrNull()?.takeIf { it > 0 } ?: JBUI.scale(8)
    }

    // ------------------------------------------------------------ 原生 diff 渲染

    private class NativeTexts(
        val before: String,
        val after: String,
        val file: com.intellij.openapi.vfs.VirtualFile?
    )

    /**
     * 原生模式：用平台的 DiffRequestPanel 渲染（内部就是真实编辑器，虚拟化、增量重绘）。
     * 内容按补丁 hunk 的行号还原成「整文件的改前 / 改后」，这样行号、上下文、语法高亮都和
     * IDEA 自己的对比窗口一致。
     */
    private fun renderNative(path: String) {
        val token = ++renderToken
        val cached = synchronized(nativeCache) { nativeCache[path] }
        if (cached != null) {
            try {
                showNative(path, cached)
            } finally {
                finishRender()
            }
            return
        }
        val lines = diffLines(path)
        val app = com.intellij.openapi.application.ApplicationManager.getApplication()
        app.executeOnPooledThread {
            val texts = try {
                buildNativeTexts(path, lines)
            } catch (_: Throwable) {
                null
            }
            if (texts == null) {
                app.invokeLater({ finishRender() }, com.intellij.openapi.application.ModalityState.any())
                return@executeOnPooledThread
            }
            synchronized(nativeCache) {
                if (nativeCache.size >= 200) nativeCache.keys.firstOrNull()?.let { nativeCache.remove(it) }
                nativeCache[path] = texts
            }
            app.invokeLater({
                try {
                    if (token == renderToken) showNative(path, texts)
                } finally {
                    finishRender()
                }
            }, com.intellij.openapi.application.ModalityState.any())
        }
    }

    private fun showNative(path: String, texts: NativeTexts) {
        if (javax.swing.SwingUtilities.getWindowAncestor(nativeHost) == null) {
            // 对话框尚未显示：先记下来，等 hierarchy 显示事件触发后再渲染
            pendingNative = path to texts
            return
        }
        val panel = ensureNativePanel() ?: run {
            fallbackToBuiltIn()
            return
        }
        val t0 = System.nanoTime()
        val request = try {
            buildNativeRequest(path, texts)
        } catch (e: Throwable) {
            logWarn("构造 diff 请求失败", e)
            fallbackToBuiltIn()
            return
        }
        val tRequest = (System.nanoTime() - t0) / 1_000_000
        val t1 = System.nanoTime()
        try {
            panel.setRequest(request)
        } catch (e: Throwable) {
            logWarn("原生 diff 面板渲染失败", e)
            fallbackToBuiltIn()
            return
        }
        val tPanel = (System.nanoTime() - t1) / 1_000_000
        updatePathLabel(path)
        (diffCards.layout as CardLayout).show(diffCards, CARD_NATIVE)
        nativeHost.revalidate()
        nativeHost.repaint()
        val tTotal = (System.nanoTime() - t0) / 1_000_000
        if (tTotal > 60) {
            com.intellij.openapi.diagnostic.Logger.getInstance(DeepFixPreviewDialog::class.java)
                .warn("原生 diff 渲染耗时 ${tTotal}ms（构造请求 ${tRequest}ms / setRequest ${tPanel}ms，$path）")
        }
    }

    private fun updatePathLabel(path: String) {
        val counts = countChanges(diffLines(path))
        pathLabel.text = "${path}    +${counts.first} / -${counts.second}"
    }

    /** 反射构造平台的 DiffRequestPanel 实现（官方推荐的嵌入方式 DiffManager.createRequestPanel 内部就是这个类） */
    private fun ensureNativePanel(): com.intellij.diff.DiffRequestPanel? {
        nativePanel?.let { return it }
        if (nativeFailed) return null
        return try {
            val type = Class.forName("com.intellij.diff.impl.DiffRequestPanelImpl")
            val ctor = type.getConstructor(Project::class.java, java.awt.Window::class.java)
            val window = javax.swing.SwingUtilities.getWindowAncestor(nativeHost)
            val instance = ctor.newInstance(project, window) as com.intellij.diff.DiffRequestPanel
            nativeHost.removeAll()
            nativeHost.add(instance.component, BorderLayout.CENTER)
            nativeHost.revalidate()
            nativePanel = instance
            instance
        } catch (e: Throwable) {
            logWarn("无法创建原生 diff 面板，回退内置渲染", e)
            nativeFailed = true
            null
        }
    }

    private fun buildNativeRequest(path: String, texts: NativeTexts): com.intellij.diff.requests.DiffRequest {
        val factory = com.intellij.diff.DiffContentFactory.getInstance()
        val fileType = texts.file?.fileType
            ?: com.intellij.openapi.fileTypes.FileTypeManager.getInstance().getFileTypeByFileName(path)
        val before = factory.create(project, texts.before, fileType)
        val after = factory.create(project, texts.after, fileType)
        return com.intellij.diff.requests.SimpleDiffRequest(path, before, after, "修改前", "修改后")
    }

    private fun fallbackToBuiltIn() {
        if (!useNative) return
        useNative = false
        modeSwitch.isVisible = true
        (diffCards.layout as CardLayout).show(diffCards, CARD_UNIFIED)
        // 交给 finishRender 用内置渲染把当前文件重跑一遍，避免在渲染过程中递归调用
        queuedRender = true
    }

    private fun logWarn(message: String, error: Throwable) {
        com.intellij.openapi.diagnostic.Logger.getInstance(DeepFixPreviewDialog::class.java).warn(message, error)
    }

    private fun countChanges(lines: List<String>?): Pair<Int, Int> {
        var added = 0
        var removed = 0
        lines?.forEach { line ->
            when {
                line.startsWith("+") && !line.startsWith("+++") -> added++
                line.startsWith("-") && !line.startsWith("---") -> removed++
            }
        }
        return added to removed
    }

    private fun buildNativeTexts(path: String, lines: List<String>?): NativeTexts {
        val virtualFile = findVirtualFile(path)
        val original = virtualFile?.let { readVirtualText(it) }
        // 保留原始行尾：改前/改后两侧必须是同一种换行风格，否则原生面板会标成 CRLF vs LF
        val sep = if (original != null && original.contains("\r\n")) "\r\n" else "\n"
        val rebuilt = if (original != null && !lines.isNullOrEmpty()) {
            applyHunks(splitLines(original), lines, sep)
        } else {
            null
        }
        if (original != null && rebuilt != null) {
            return NativeTexts(original, rebuilt, virtualFile)
        }
        if (lines == null) return NativeTexts("", "", virtualFile)
        return NativeTexts(fragment(lines, old = true), fragment(lines, old = false), virtualFile)
    }

    /** 按 \n 切行但去掉 \r，保留结尾空行（与 String.lines() 相比不会吞掉末尾换行） */
    private fun splitLines(text: String): List<String> =
        text.split("\n").map { if (it.endsWith("\r")) it.dropLast(1) else it }

    private fun findVirtualFile(path: String): com.intellij.openapi.vfs.VirtualFile? {
        val base = project.basePath ?: return null
        val candidate = if (path.startsWith("/")) path else "$base/$path"
        return com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(candidate.replace('\\', '/'))
    }

    private fun readVirtualText(file: com.intellij.openapi.vfs.VirtualFile): String? =
        com.intellij.openapi.application.ApplicationManager.getApplication().runReadAction<String?> {
            runCatching { com.intellij.openapi.vfs.VfsUtilCore.loadText(file) }.getOrNull()
        }

    /**
     * 按 hunk 头里的行号把补丁套回原文件，得到完整的「改后」文本。
     * 和 git apply 一样，每一行上下文 / 删除行都必须和当前文件逐字对上，行数也必须和 hunk 头一致；
     * 任何一处对不上就整份放弃（退回只显示补丁片段），绝不把错位的行拼进结果。
     */
    private fun applyHunks(original: List<String>, lines: List<String>, sep: String): String? {
        val out = ArrayList<String>(original.size + 64)
        var cursor = 0
        var index = 0
        var hunks = 0
        while (index < lines.size) {
            val line = lines[index]
            if (!line.startsWith("@@")) {
                index++
                continue
            }
            val header = HUNK_HEADER.find(line) ?: return null
            val oldStart = header.groupValues[1].toIntOrNull() ?: return null
            val oldCount = header.groupValues[2].takeIf { it.isNotEmpty() }?.toIntOrNull() ?: 1
            val newCount = header.groupValues[4].takeIf { it.isNotEmpty() }?.toIntOrNull() ?: 1
            val target = oldStart - 1
            if (target < cursor || target + oldCount > original.size) return null
            while (cursor < target) {
                out += original[cursor]
                cursor++
            }
            var body = index + 1
            var oldSeen = 0
            var newSeen = 0
            var oldPos = target
            while (body < lines.size && oldSeen < oldCount && newSeen < newCount) {
                val raw = lines[body]
                when {
                    // \ No newline at end of file
                    raw.startsWith("\\") -> Unit
                    raw.startsWith("+") && !raw.startsWith("+++") -> {
                        out += raw.substring(1)
                        newSeen++
                    }
                    raw.startsWith("-") && !raw.startsWith("---") -> {
                        if (oldPos >= original.size || original[oldPos].trimEnd() != raw.substring(1).trimEnd()) return null
                        oldPos++
                        oldSeen++
                    }
                    raw.startsWith(" ") -> {
                        if (oldPos >= original.size || original[oldPos].trimEnd() != raw.substring(1).trimEnd()) return null
                        // 用原文而不是补丁里的副本，避免行尾空白被补丁工具裁掉
                        out += original[oldPos]
                        oldPos++
                        oldSeen++
                        newSeen++
                    }
                    // 空行只可能是「被裁掉行尾空格的空上下文行」，同样要和原文对上
                    raw.isEmpty() -> {
                        if (oldPos >= original.size || original[oldPos] != "") return null
                        out += ""
                        oldPos++
                        oldSeen++
                        newSeen++
                    }
                    else -> return null
                }
                body++
            }
            if (oldSeen != oldCount || newSeen != newCount) return null
            cursor = oldPos
            index = body
            hunks++
        }
        if (hunks == 0) return null
        while (cursor < original.size) {
            out += original[cursor]
            cursor++
        }
        return out.joinToString(sep)
    }

    /** 退化路径：把整份补丁拼成「改前 / 改后」两段文本（只有 hunk 片段，行号从 1 起） */
    private fun fragment(lines: List<String>, old: Boolean): String {
        val out = ArrayList<String>(lines.size)
        lines.forEach { line ->
            when {
                line.startsWith("+") && !line.startsWith("+++") -> if (!old) out += line.substring(1)
                line.startsWith("-") && !line.startsWith("---") -> if (old) out += line.substring(1)
                line.startsWith(" ") -> out += line.substring(1)
                line.startsWith("@@") -> out += line
                line.startsWith("diff ") || line.startsWith("index ") -> Unit
                else -> out += line
            }
        }
        return out.joinToString("\n")
    }

    override fun dispose() {
        renderAlarm.cancelAllRequests()
        runCatching { renderAlarm.dispose() }
        runCatching { nativePanel?.dispose() }
        nativePanel = null
        super.dispose()
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
            return RenderData(unified, left, right, 0, 0, message.text.length)
        }

        var added = 0
        var removed = 0
        var truncated = false
        var maxCols = 1
        val removedBuf = ArrayList<String>()
        val addedBuf = ArrayList<String>()

        fun track(line: DiffLine) {
            maxCols = maxOf(maxCols, line.text.length)
        }

        fun flush() {
            if (removedBuf.isEmpty() && addedBuf.isEmpty()) return
            removedBuf.forEach {
                val line = DiffLine("-" + it, DiffKind.DELETE)
                unified += line
                track(line)
            }
            addedBuf.forEach {
                val line = DiffLine("+" + it, DiffKind.ADD)
                unified += line
                track(line)
            }
            val count = maxOf(removedBuf.size, addedBuf.size)
            for (index in 0 until count) {
                val old = removedBuf.getOrNull(index)
                val new = addedBuf.getOrNull(index)
                val leftLine = if (old != null) DiffLine("-" + old, DiffKind.DELETE) else DiffLine("", DiffKind.BLANK)
                val rightLine = if (new != null) DiffLine("+" + new, DiffKind.ADD) else DiffLine("", DiffKind.BLANK)
                left += leftLine
                right += rightLine
                track(leftLine)
                track(rightLine)
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
            track(rendered)
        }

        fun addBoth(text: String, kind: DiffKind) {
            flush()
            val rendered = DiffLine(text, kind)
            unified += rendered
            left += rendered
            right += rendered
            track(rendered)
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
        return RenderData(unified, left, right, added, removed, maxCols)
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
        const val CARD_NATIVE = "native"
        const val MAX_DIFF_LINES = 1200
        const val MAX_LINE_LENGTH = 400
        /** 渲染已足够便宜，只留很小的合并窗口，避免出现「点了要等一下才跳」的手感 */
        const val RENDER_DEBOUNCE_MS = 30
    }
}

/** diff 行的类型：决定前景色与底色 */
private enum class DiffKind { CONTEXT, DELETE, ADD, HUNK, META, BLANK }

private class DiffLine(val text: String, val kind: DiffKind)

/** 颜色只创建一次：JBColor 每创建一次都会登记进全局主题更新列表，放在绘制回调里会拖慢滚动 */
private val DIFF_TEXT = JBColor(Color(0x24292F), Color(0xD4D9DF))
private val DIFF_ADD_TEXT = JBColor(Color(0x1B7F3B), Color(0x6EDC93))
private val DIFF_DEL_TEXT = JBColor(Color(0xB4261C), Color(0xFF8078))
private val DIFF_HUNK_TEXT = JBColor(Color(0x2C6BE0), Color(0x7FA8FF))
private val DIFF_ADD_BACKGROUND = JBColor(Color(0xE8F5EC), Color(0x2C4235))
private val DIFF_DEL_BACKGROUND = JBColor(Color(0xFBE7E7), Color(0x4A2727))
private val DIFF_BLANK_BACKGROUND = JBColor(Color(0xF4F5F7), Color(0x2A2C30))
private val DIFF_HUNK_BACKGROUND = JBColor(Color(0xEFF4FD), Color(0x252C38))

private fun diffForeground(kind: DiffKind): Color = when (kind) {
    DiffKind.ADD -> DIFF_ADD_TEXT
    DiffKind.DELETE -> DIFF_DEL_TEXT
    DiffKind.HUNK -> DIFF_HUNK_TEXT
    DiffKind.META, DiffKind.BLANK -> MUTED_FOREGROUND
    else -> DIFF_TEXT
}

private fun diffBackground(kind: DiffKind, base: Color): Color = when (kind) {
    DiffKind.ADD -> DIFF_ADD_BACKGROUND
    DiffKind.DELETE -> DIFF_DEL_BACKGROUND
    DiffKind.BLANK -> DIFF_BLANK_BACKGROUND
    DiffKind.HUNK -> DIFF_HUNK_BACKGROUND
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

    /** 内容比视口窄时跟随视口宽度（否则只有文字那么宽、底色不铺满），更宽时出横向滚动条 */
    override fun getScrollableTracksViewportWidth(): Boolean {
        val holder = parent
        val available = if (holder is javax.swing.JViewport) holder.width else width
        return preferredWidth <= available
    }

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

/** unified diff 的 hunk 头：@@ -12,7 +12,7 @@ */
private val HUNK_HEADER = Regex("""^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@""")

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
