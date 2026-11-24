package com.dsda56180.qualitycenter.service

import com.dsda56180.qualitycenter.deps.indexBomManagement
import com.dsda56180.qualitycenter.deps.localRepository
import com.dsda56180.qualitycenter.deps.parseBomRefs
import com.dsda56180.qualitycenter.deps.parseDependencyTree
import com.dsda56180.qualitycenter.fix.applyAutoFixes
import com.dsda56180.qualitycenter.fix.isFixable
import com.dsda56180.qualitycenter.model.Issue
import com.dsda56180.qualitycenter.model.IssueSource
import com.dsda56180.qualitycenter.model.ScanProgress
import com.dsda56180.qualitycenter.model.ScanResult
import com.dsda56180.qualitycenter.model.StageProgress
import com.dsda56180.qualitycenter.project.ProjectProfile
import com.dsda56180.qualitycenter.project.detectProjectProfile
import com.dsda56180.qualitycenter.project.recipeAdvice
import com.dsda56180.qualitycenter.recipes.DEFAULT_RECIPE_ARTIFACTS
import com.dsda56180.qualitycenter.recipes.RECIPE_LIBRARY
import com.dsda56180.qualitycenter.recipes.RECIPE_PLUGIN_VERSION
import com.dsda56180.qualitycenter.recipes.RecipeDefinition
import com.dsda56180.qualitycenter.recipes.applicableRecipes
import com.dsda56180.qualitycenter.recipes.artifactsForRecipes
import com.dsda56180.qualitycenter.recipes.autoRecipeIds
import com.dsda56180.qualitycenter.recipes.classifyDiscoveredRecipes
import com.dsda56180.qualitycenter.recipes.mergeRecipeLibrary
import com.dsda56180.qualitycenter.recipes.parseDiscoverOutput
import com.dsda56180.qualitycenter.recipes.recipeLabel
import com.dsda56180.qualitycenter.recipes.requiredPluginVersion
import com.dsda56180.qualitycenter.report.AgentExport
import com.dsda56180.qualitycenter.report.Report
import com.dsda56180.qualitycenter.scanner.ScanOptions
import com.dsda56180.qualitycenter.scanner.ScanRunner
import com.dsda56180.qualitycenter.scanner.TrivyScanner
import com.dsda56180.qualitycenter.settings.QualitySettings
import com.dsda56180.qualitycenter.ui.DeepFixPreviewInfo
import com.dsda56180.qualitycenter.ui.UpgradeDecision
import com.dsda56180.qualitycenter.ui.showDeepFixPreview
import com.dsda56180.qualitycenter.ui.showUpgradePreview
import com.dsda56180.qualitycenter.upgrade.UpgradeCandidate
import com.dsda56180.qualitycenter.upgrade.UpgradeContext
import com.dsda56180.qualitycenter.upgrade.applyUpgrade
import com.dsda56180.qualitycenter.upgrade.planUpgrades
import com.dsda56180.qualitycenter.util.Exec
import com.dsda56180.qualitycenter.util.Maven
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.LogicalPosition
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileDocumentManagerListener
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.util.SystemProperties
import com.google.gson.GsonBuilder
import com.google.gson.TypeAdapter
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonWriter
import com.intellij.openapi.util.io.FileUtil
import java.awt.datatransfer.StringSelection
import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** 面板展示所需的全部状态快照 */
data class QualityUiState(
    val scanning: Boolean = false,
    val paused: Boolean = false,
    val progress: ScanProgress = ScanProgress(),
    val stage: StageProgress? = null,
    val result: ScanResult? = null,
    val recipeLibrary: List<RecipeDefinition> = RECIPE_LIBRARY,
    val discoveringRecipes: Boolean = false,
    val profile: ProjectProfile = ProjectProfile(),
    val agentFile: String? = null
)

/** 规则 → OpenRewrite 配方，用于单条问题级修复 */
data class RuleRecipe(val recipe: String, val label: String, val artifact: String? = null)

val RULE_RECIPES: Map<String, RuleRecipe> = mapOf(
    "UnusedImports" to RuleRecipe("org.openrewrite.java.RemoveUnusedImports", "清理无用导入"),
    "RedundantImport" to RuleRecipe("org.openrewrite.java.RemoveUnusedImports", "清理无用导入"),
    "SimplifyBooleanExpression" to RuleRecipe(
        "org.openrewrite.staticanalysis.SimplifyBooleanExpression", "简化布尔表达式",
        "org.openrewrite.recipe:rewrite-static-analysis:2.10.0"
    ),
    "UnnecessaryParentheses" to RuleRecipe(
        "org.openrewrite.staticanalysis.UnnecessaryParentheses", "去除多余括号",
        "org.openrewrite.recipe:rewrite-static-analysis:2.10.0"
    )
)

@Service(Service.Level.PROJECT)
class QualityCenterService(val project: Project) : Disposable {

    val settings = QualitySettings(project)

    private val baseDir: File? = ProjectRootManager.getInstance(project).contentRoots
        .firstOrNull()?.path?.let(::File)
    private val runner: ScanRunner? = baseDir?.let { ScanRunner(it, cacheFile(it)) }
    private val listeners = CopyOnWriteArrayList<Runnable>()
    private val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "quality-center-${project.name}").apply { isDaemon = true }
    }

    private data class BackupData(
        val dir: File,
        val patchFile: File,
        val untracked: List<String>
    )

    /** 上次预演结果：签名一致时直接复用，避免误关预览后再次点击又要重跑一遍 OpenRewrite */
    private data class CachedPreview(
        val signature: String,
        val files: List<String>,
        val patchText: String?
    )

    @Volatile
    private var cachedPreview: CachedPreview? = null

    init {
        runCatching {
            val storage = File(PathManager.getSystemPath(), "quality-center")
            storage.mkdirs()
            Maven.init(storage.path)
        }
    }

    @Volatile
    private var uiState = QualityUiState(
        result = runner?.lastResult,
        recipeLibrary = RECIPE_LIBRARY
    )
    private var discoverCache: List<RecipeDefinition>? = null
    private var depContextCache: Pair<String, UpgradeContext>? = null
    private var profileCache: Pair<String, ProjectProfile>? = null
    private val started = AtomicBoolean(false)

    val root: File? get() = baseDir
    val result: ScanResult? get() = uiState.result
    val state: QualityUiState get() = uiState
    val isRunning: Boolean get() = runner?.isRunning == true || uiState.stage != null

    fun addListener(listener: Runnable) = listeners.addIfAbsent(listener)

    fun removeListener(listener: Runnable) = listeners.remove(listener)

    private fun update(mutator: (QualityUiState) -> QualityUiState) {
        uiState = mutator(uiState)
        notifyListeners()
    }

    private fun notifyListeners() {
        ApplicationManager.getApplication().invokeLater {
            listeners.forEach { runCatching { it.run() } }
        }
    }

    private fun cacheFile(root: File): File {
        val idea = File(root, ".idea")
        val dir = if (idea.isDirectory) idea else File(SystemProperties.getUserHome(), ".quality-center")
        return File(dir, "quality-center-cache.json")
    }

    // ---------------------------------------------------------------- 扫描

    fun scan(force: Boolean = true) {
        val scanRunner = runner ?: run {
            notifyInfo("请先打开一个 Maven 项目，再执行扫描。")
            return
        }
        if (scanRunner.isRunning || uiState.stage != null) {
            return
        }
        if (!force && uiState.paused) {
            return
        }
        if (force) {
            resume()
        }
        scanRunner.options = buildScanOptions()
        update { it.copy(scanning = true, paused = false, progress = ScanProgress()) }
        executor.execute {
            try {
                val res = scanRunner.scan { progress -> update { it.copy(progress = progress) } }
                writeAgentFiles(res)
                update { it.copy(result = res) }
            } catch (e: Exception) {
                notifyError("扫描失败：${e.message}")
            } finally {
                update { it.copy(scanning = false, progress = ScanProgress()) }
            }
        }
    }

    fun pause() {
        if (!uiState.scanning) return
        runner?.pause()
        update { it.copy(paused = true) }
    }

    fun resume() {
        runner?.resume()
        update { it.copy(paused = false) }
    }

    fun cancel() {
        Exec.killAll()
        runner?.cancel()
        update { it.copy(scanning = false, paused = false, stage = null, progress = ScanProgress()) }
    }

    fun ignore(id: Int) {
        if (runner?.ignoreIssue(id) == true) {
            update { it.copy(result = runner.lastResult) }
            writeAgentFiles(runner.lastResult)
        }
    }

    fun unignore(id: Int) {
        if (runner?.unignoreIssue(id) == true) {
            update { it.copy(result = runner.lastResult) }
            writeAgentFiles(runner.lastResult)
        }
    }

    fun scanOnStartupOnce() {
        if (!settings.scanOnStartup || !started.compareAndSet(false, true)) {
            return
        }
        scan(force = false)
    }

    fun onDocumentSaved() {
        if (!settings.scanOnSave || !isJavaLikeSaved()) {
            return
        }
        scan(force = false)
    }

    private var lastSaveAt = 0L

    private fun isJavaLikeSaved(): Boolean {
        // 保存事件本身已由监听器筛选；这里做 1.5 秒防抖
        val now = System.currentTimeMillis()
        if (now - lastSaveAt < 1500) {
            return false
        }
        lastSaveAt = now
        return true
    }

    // ---------------------------------------------------------------- 导出 / 复制

    fun markdown(): String? {
        val res = uiState.result ?: return null
        val dir = root ?: return null
        return Report.toMarkdown(res, dir)
    }

    fun copyMarkdown() {
        val text = markdown()
        if (text == null) {
            notifyInfo("还没有扫描结果，请先执行扫描。")
            return
        }
        CopyPasteManager.getInstance().setContents(StringSelection(text))
        notifyInfo("已复制 ${uiState.result?.issues?.size ?: 0} 个问题到剪贴板，可直接粘贴给 AI。")
    }

    fun exportReport() {
        val text = markdown()
        val dir = root
        if (text == null || dir == null) {
            notifyInfo("还没有扫描结果，请先执行扫描。")
            return
        }
        executor.execute {
            val target = File(dir, "quality-report.md")
            Files.write(target.toPath(), text.toByteArray(StandardCharsets.UTF_8))
            ApplicationManager.getApplication().invokeLater {
                openFile(target, 1)
                notifyInfo("已导出报告：${target.path}")
            }
        }
    }

    fun copyIssue(id: Int) {
        val issue = uiState.result?.issues?.getOrNull(id - 1) ?: return
        val dir = root
        val rel = issue.file?.let { file ->
            if (dir != null) file.replace(dir.path + File.separator, "").replace('\\', '/') else file
        } ?: ""
        val text = buildString {
            appendLine("### 问题 #$id")
            appendLine("- 来源：${issue.source.label}")
            appendLine("- 等级：${issue.severity.label}")
            if (rel.isNotEmpty()) appendLine("- 位置：$rel${issue.line?.let { ":$it" } ?: ""}")
            appendLine("- 规则：${issue.rule}")
            appendLine("- 说明：${issue.zhSummary ?: issue.message}")
            issue.advice?.takeIf { it.isNotBlank() }?.let { appendLine("- 建议：$it") }
            issue.link?.takeIf { it.isNotBlank() }?.let { appendLine("- 链接：$it") }
        }
        CopyPasteManager.getInstance().setContents(StringSelection(text))
        notifyInfo("已复制第 $id 条问题，可直接粘贴给 AI。")
    }

    fun copySuggestion(id: Int) {
        val suggestion = uiState.result?.suggestions?.getOrNull(id - 1) ?: return
        val text = """
            ### 修复建议：${suggestion.title}
            - 可覆盖问题数：${suggestion.impact}
            - 类别：${suggestion.category}
            - 说明：${suggestion.detail}
        """.trimIndent()
        CopyPasteManager.getInstance().setContents(StringSelection(text))
        notifyInfo("已复制修复建议，可直接粘贴给 AI。")
    }

    // ---------------------------------------------------------------- 自动修复

    fun fixAll() {
        val targets = uiState.result?.issues?.filter(::isFixable) ?: emptyList()
        if (targets.isEmpty()) {
            notifyInfo("当前没有可自动修复的问题。")
            return
        }
        executor.execute {
            val outcome = applyAutoFixes(targets)
            ApplicationManager.getApplication().invokeLater {
                notifyInfo("已修复 ${outcome.applied} 项，跳过 ${outcome.skipped} 项。")
                scan(force = false)
            }
        }
    }

    fun fixIssue(id: Int) {
        val issue = uiState.result?.issues?.getOrNull(id - 1) ?: return
        if (!isFixable(issue)) return
        executor.execute {
            val outcome = applyAutoFixes(listOf(issue))
            ApplicationManager.getApplication().invokeLater {
                notifyInfo("已修复 ${outcome.applied} 项，跳过 ${outcome.skipped} 项。")
                scan(force = false)
            }
        }
    }

    // ---------------------------------------------------------------- 构建并扫描

    fun buildAndScan() {
        val dir = root ?: run {
            notifyInfo("请先打开一个 Maven 项目，再执行构建扫描。")
            return
        }
        executor.execute {
            setStage("执行 mvn package 构建", 1)
            try {
                val outcome = Maven.runMvn(dir, listOf("-DskipTests", "package"), timeoutMs = 20 * 60_000)
                if (outcome.code != 0) {
                    notifyError("构建失败：${tail(outcome.stderr.ifBlank { outcome.stdout })}")
                    return@execute
                }
                update { it.copy(stage = null) }
                scan(force = false)
            } finally {
                update { it.copy(stage = null) }
            }
        }
    }

    // ---------------------------------------------------------------- 深度修复

    fun deepFix() = deepFixInternal(null)

    fun deepFixRule(id: Int) {
        val issue = uiState.result?.issues?.getOrNull(id - 1) ?: return
        val mapping = RULE_RECIPES[issue.rule] ?: return
        deepFixInternal(
            DeepFixOverride(
                recipes = listOf(mapping.recipe),
                artifacts = listOfNotNull(mapping.artifact),
                label = mapping.label
            )
        )
    }

    private data class DeepFixOverride(val recipes: List<String>, val artifacts: List<String>, val label: String?)

    private fun deepFixInternal(override: DeepFixOverride?) {
        val dir = root ?: run {
            notifyInfo("请先打开一个 Maven 项目，再执行深度修复。")
            return
        }
        if (!settings.openRewriteEnabled) {
            notifyInfo("深度修复已在设置中关闭。")
            return
        }
        if (isRunning) {
            notifyInfo("当前有任务在执行，请稍后再试。")
            return
        }

        val profile = projectProfile(dir)
        val recipes = if (override != null) {
            override.recipes
        } else {
            val configured = settings.openRewriteRecipes
            val auto = if (settings.openRewriteAutoRecipes) autoRecipeIds(profile) else emptyList()
            (configured + auto).distinct()
        }
        if (recipes.isEmpty()) {
            notifyInfo("当前项目没有可用的 OpenRewrite 配方，请在「设置」中勾选。")
            return
        }
        val version = override?.let { requiredPluginVersion(recipes) }
            ?: requiredPluginVersion(recipes)
            ?: settings.openRewritePluginVersion
        val artifacts = (artifactsForRecipes(recipes) +
            (override?.artifacts ?: emptyList()) +
            settings.openRewriteRecipeArtifacts).map { it.trim() }.filter { it.isNotEmpty() }
            .distinctBy { it.split(":").take(2).joinToString(":") }

        executor.execute {
            try {
                val status = git(dir, listOf("status", "--porcelain"))
                if (status.code != 0) {
                    notifyError("深度修复需要在 Git 仓库中运行，便于失败时回滚。")
                    return@execute
                }
                val dirty = status.stdout.lines().count { it.isNotBlank() }

                var previewFiles: List<String> = emptyList()
                var previewPatch: String? = null
                var previewFailed = false
                var reusedPreview = false
                if (settings.openRewriteDryRunPreview) {
                    // 预演很贵（要跑一次 Maven + OpenRewrite），按「配方 + HEAD + 工作区状态」做缓存：
                    // 弹窗被误关、或再次点击深度修复时，直接复现上次的预览，不重新预演
                    val signature = previewSignature(dir, recipes, artifacts, version, override?.label)
                    val cached = cachedPreview?.takeIf { it.signature == signature }
                    if (cached != null) {
                        advanceStage("复用上次预演结果")
                        previewFiles = cached.files
                        previewPatch = cached.patchText
                        reusedPreview = true
                    } else {
                        setStage("运行 OpenRewrite 配方（预演）", 3)
                        val preview = previewDeepFix(dir, recipes, artifacts, version)
                        advanceStage("生成修复补丁")
                        advanceStage("整理预览")
                        if (preview == null) {
                            previewFailed = true
                        } else if (preview.files.isEmpty()) {
                            notifyInfo("预演未发现需要改动的代码，已跳过深度修复。")
                            return@execute
                        } else {
                            previewFiles = preview.files
                            previewPatch = preview.patchFile?.readTextSafely()
                            cachedPreview = CachedPreview(signature, previewFiles, previewPatch)
                        }
                    }
                }

                update { it.copy(stage = null) }
                var selected: Set<String>? = null
                if (previewFiles.isNotEmpty()) {
                    val selectable = previewFiles.size > 1 && settings.openRewriteFileSelection
                    val info = DeepFixPreviewInfo(
                        label = override?.label,
                        projectText = listOfNotNull(profile.javaVersion?.let { "Java $it" },
                            profile.springBootVersion?.let { "Spring Boot $it" }).joinToString(" · ")
                            .ifEmpty { "Java 项目" },
                        recipes = recipes.map(::recipeLabel),
                        advice = recipeAdvice(profile),
                        dirtyCount = dirty,
                        selectable = selectable,
                        patchText = previewPatch,
                        files = previewFiles,
                        nativeDiff = settings.previewNativeDiff,
                        reusedPreview = reusedPreview
                    )
                    val decision = onEdt { showDeepFixPreview(project, info) } ?: run {
                        notifyInfo("已取消深度修复。")
                        return@execute
                    }
                    if (decision.size < previewFiles.size) {
                        selected = decision.toSet()
                    }
                } else {
                    val headline = override?.label?.let { "深度修复：$it" } ?: "执行深度修复"
                    val detail = buildString {
                        if (previewFailed) appendLine("预演失败（详见日志），将直接执行修复。")
                        appendLine("将执行 ${recipes.size} 个配方：")
                        recipes.forEach { appendLine("· ${recipeLabel(it)}") }
                        if (recipeAdvice(profile).isNotEmpty()) {
                            appendLine("推荐（未启用）：")
                            recipeAdvice(profile).forEach { appendLine("· $it") }
                        }
                        if (dirty > 0) appendLine("检测到 $dirty 处未提交改动，会先做完整备份。")
                    }
                    val confirmed = onEdt {
                        com.intellij.openapi.ui.Messages.showYesNoDialog(
                            project, detail, headline, "执行深度修复", "取消", null
                        )
                    }
                    if (confirmed != com.intellij.openapi.ui.Messages.YES) {
                        return@execute
                    }
                }

                runDeepFix(dir, recipes, artifacts, version, dirty, override?.label, selected)
                // 修复已执行，工作区变了，缓存作废
                cachedPreview = null
            } catch (e: Exception) {
                notifyError("深度修复失败：${e.message}")
            } finally {
                update { it.copy(stage = null) }
            }
        }
    }

    private fun runDeepFix(
        dir: File,
        recipes: List<String>,
        artifacts: List<String>,
        version: String,
        dirty: Int,
        label: String?,
        selected: Set<String>?
    ) {
        var backup: BackupData? = null
        val untrackedBefore = mutableSetOf<String>()

        fun createBackup(): Boolean {
            if (dirty == 0) return true
            advanceStage("备份未提交改动")
            return try {
                val backupDir = Files.createTempDirectory("quality-center-backup-").toFile()
                val diff = git(dir, listOf("diff", "HEAD", "--binary"), 120_000)
                if (diff.code != 0) {
                    throw IllegalStateException(diff.stderr.ifBlank { diff.stdout }.trim())
                }
                val patchFile = File(backupDir, "changes.patch")
                patchFile.writeText(diff.stdout, StandardCharsets.UTF_8)
                val others = git(dir, listOf("ls-files", "--others", "--exclude-standard"), 60_000)
                val untracked = others.stdout.lines().filter { it.isNotBlank() }
                untracked.forEach { relative ->
                    untrackedBefore.add(relative)
                    val source = File(dir, relative)
                    val target = File(backupDir, "untracked/$relative")
                    target.parentFile?.mkdirs()
                    if (source.exists()) source.copyTo(target, overwrite = true)
                }
                backup = BackupData(backupDir, patchFile, untracked)
                true
            } catch (e: Exception) {
                notifyError("备份未提交改动失败，已取消深度修复：${e.message}")
                false
            }
        }

        fun restoreBackup(): Boolean {
            val current = backup ?: return true
            advanceStage("恢复未提交改动")
            git(dir, listOf("checkout", "HEAD", "--", "."), 120_000)
            var ok = true
            try {
                if (current.patchFile.exists() && current.patchFile.length() > 0) {
                    val applied = git(
                        dir, listOf("apply", "--binary", "--whitespace=nowarn", current.patchFile.path), 120_000
                    )
                    if (applied.code != 0) {
                        ok = false
                        notifyError("恢复未提交改动失败：${tail(applied.stderr.ifBlank { applied.stdout })}")
                    }
                }
                current.untracked.forEach { relative ->
                    val source = File(current.dir, "untracked/$relative")
                    if (source.exists()) {
                        val target = File(dir, relative)
                        target.parentFile?.mkdirs()
                        source.copyTo(target, overwrite = true)
                    }
                }
            } catch (e: Exception) {
                ok = false
                notifyError("恢复未提交改动失败：${e.message}")
            }
            if (ok) {
                current.dir.deleteRecursively()
                backup = null
            }
            return ok
        }

        setStage("备份改动", 4)
        if (!createBackup()) return

        var baseRef = "HEAD"
        if (dirty > 0) {
            val snapshot = git(dir, listOf("stash", "create"), 60_000)
            if (snapshot.code == 0 && snapshot.stdout.isNotBlank()) {
                baseRef = snapshot.stdout.trim()
            }
        }

        advanceStage("运行 OpenRewrite 配方")
        val encoding = sourceEncoding(dir)
        val args = mutableListOf("-B", "-q")
        args += Maven.mirrorArgs()
        args += listOf(
            "-Dproject.build.sourceEncoding=$encoding",
            "-Drewrite.activeRecipes=${recipes.joinToString(",")}"
        )
        if (artifacts.isNotEmpty()) {
            args += "-Drewrite.recipeArtifactCoordinates=${artifacts.joinToString(",")}"
        }
        args += "org.openrewrite.maven:rewrite-maven-plugin:$version:run"
        val outcome = Maven.runMvn(dir, args, 20 * 60_000, mapOf("MAVEN_OPTS" to "-Dfile.encoding=$encoding"))
        if (outcome.code != 0) {
            notifyError("深度修复失败，已撤销本次改动：${tail(outcome.stderr.ifBlank { outcome.stdout })}")
            restoreBackup()
            return
        }

        advanceStage("收集改动文件")
        val changed = LinkedHashSet<String>()
        git(dir, listOf("diff", "--name-only", baseRef), 30_000).stdout.lines()
            .filter { it.isNotBlank() }.forEach { changed.add(it) }
        git(dir, listOf("ls-files", "--others", "--exclude-standard"), 60_000).stdout.lines()
            .filter { it.isNotBlank() }.forEach { if (it !in untrackedBefore) changed.add(it) }

        if (selected != null) {
            val tracked = git(dir, listOf("ls-files"), 60_000).stdout.lines().filter { it.isNotBlank() }.toSet()
            val toRestore = changed.filter { it !in selected && (it in tracked || it in untrackedBefore) }
            val toDelete = changed.filter { it !in selected && it !in tracked && it !in untrackedBefore }
            if (toRestore.isNotEmpty() || toDelete.isNotEmpty()) {
                advanceStage("恢复未选择的文件")
                val trackedRestore = toRestore.filter { it in tracked }
                if (trackedRestore.isNotEmpty()) {
                    git(dir, listOf("checkout", baseRef, "--") + trackedRestore, 120_000)
                }
                toRestore.filter { it !in tracked }.forEach { file ->
                    val source = backup?.let { File(it.dir, "untracked/$file") }
                    if (source != null && source.exists()) source.copyTo(File(dir, file), overwrite = true)
                }
                toDelete.forEach { runCatching { File(dir, it).delete() } }
                changed.clear()
                git(dir, listOf("diff", "--name-only", baseRef), 30_000).stdout.lines()
                    .filter { it.isNotBlank() }.forEach { changed.add(it) }
                git(dir, listOf("ls-files", "--others", "--exclude-standard"), 60_000).stdout.lines()
                    .filter { it.isNotBlank() && File(dir, it).exists() && it !in untrackedBefore }
                    .forEach { changed.add(it) }
            }
        }

        if (changed.isEmpty()) {
            backup?.dir?.deleteRecursively()
            backup = null
            notifyInfo("深度修复完成，没有需要改动的代码。")
            return
        }

        if (settings.openRewriteCompileGate) {
            advanceStage("校验编译")
            val build = Maven.runMvn(dir, listOf("-B", "-q") + Maven.mirrorArgs() + listOf("-DskipTests", "compile"), 20 * 60_000)
            if (build.code != 0) {
                advanceStage("编译失败，等待回滚确认")
                val rollback = onEdt {
                    com.intellij.openapi.ui.Messages.showYesNoDialog(
                        project,
                        "深度修复后编译失败，需要回滚已改动的 ${changed.size} 个文件。\n${tail(build.stderr.ifBlank { build.stdout })}",
                        "编译失败",
                        "立即回滚",
                        "保留改动",
                        null
                    )
                } == com.intellij.openapi.ui.Messages.YES
                if (rollback) {
                    advanceStage("回滚本次改动")
                    restoreBackup()
                    notifyInfo("已回滚到修复前的状态，并恢复未提交的改动。")
                } else {
                    backup?.dir?.deleteRecursively()
                    backup = null
                }
                return
            }
        }

        backup?.dir?.deleteRecursively()
        backup = null
        update { it.copy(stage = null) }
        notifyInfo("深度修复完成，共改动 ${changed.size} 个文件。")
        scan(force = false)
    }

    private data class PreviewResult(val files: List<String>, val patchFile: File?)

    private fun previewSignature(
        dir: File,
        recipes: List<String>,
        artifacts: List<String>,
        version: String,
        label: String?
    ): String {
        val head = git(dir, listOf("rev-parse", "HEAD"), 30_000).stdout.trim()
        val status = git(dir, listOf("status", "--porcelain"), 30_000).stdout
        return buildString {
            append(recipes.sorted().joinToString(","))
            append('|').append(artifacts.sorted().joinToString(","))
            append('|').append(version)
            append('|').append(label ?: "")
            append('|').append(head)
            append('|').append(sha1(status))
        }
    }

    private fun previewDeepFix(
        dir: File,
        recipes: List<String>,
        artifacts: List<String>,
        version: String
    ): PreviewResult? {
        val startedAt = System.currentTimeMillis()
        val encoding = sourceEncoding(dir)
        val args = mutableListOf("-B", "-q")
        args += Maven.mirrorArgs()
        args += listOf(
            "-Dproject.build.sourceEncoding=$encoding",
            "-Drewrite.activeRecipes=${recipes.joinToString(",")}"
        )
        if (artifacts.isNotEmpty()) {
            args += "-Drewrite.recipeArtifactCoordinates=${artifacts.joinToString(",")}"
        }
        args += "org.openrewrite.maven:rewrite-maven-plugin:$version:dryRun"
        val outcome = Maven.runMvn(dir, args, 20 * 60_000, mapOf("MAVEN_OPTS" to "-Dfile.encoding=$encoding"))
        if (outcome.code != 0) {
            return null
        }
        val output = "${outcome.stdout}\n${outcome.stderr}"
        val files = LinkedHashSet<String>()
        output.lines().forEach { line ->
            val match = Regex("These recipes would make changes to (.+):\\s*$", RegexOption.IGNORE_CASE)
                .find(line)
            match?.groupValues?.get(1)?.trim()?.let { files.add(it.replace('\\', '/')) }
        }
        val candidates = mutableListOf<File>()
        Regex("Patch file available:\\s*\\r?\\n\\s*([^\\r\\n]+)", RegexOption.IGNORE_CASE)
            .find(output)?.groupValues?.get(1)?.replace(Regex("^\\[[A-Z]+]\\s*"), "")?.trim()
            ?.let { candidates.add(File(it)) }
        candidates.add(File(dir, "target/rewrite/rewrite.patch"))
        val patchFile = candidates.firstOrNull { it.exists() && it.lastModified() >= startedAt }
        if (files.isEmpty() && patchFile != null) {
            patchFile.readTextSafely()?.lines()?.forEach { line ->
                val match = Regex("^\\+\\+\\+ b/(.+)$").find(line)
                match?.groupValues?.get(1)?.let { files.add(it) }
            }
        }
        return PreviewResult(files.toList().sorted(), patchFile)
    }

    // ---------------------------------------------------------------- 依赖升级

    fun upgradeDependencies(packageName: String? = null) {
        val dir = root ?: run {
            notifyInfo("请先打开一个 Maven 项目，再执行依赖升级。")
            return
        }
        if (!settings.dependencyUpgradeEnabled) {
            notifyInfo("依赖升级已在设置中关闭。")
            return
        }
        if (isRunning) {
            notifyInfo("当前有任务在执行，请稍后再试。")
            return
        }
        val result = uiState.result ?: run {
            notifyInfo("还没有扫描结果，请先执行扫描。")
            return
        }
        val pomFile = File(dir, "pom.xml")
        if (!pomFile.exists()) {
            notifyInfo("未找到 pom.xml。")
            return
        }

        executor.execute {
            try {
                setStage("解析依赖树", 2)
                val context = loadUpgradeContext(dir)
                advanceStage("对齐 BOM 版本")
                val plan = planUpgrades(dir, result.issues, context)
                update { it.copy(stage = null) }
                if (plan.candidates.isEmpty()) {
                    notifyInfo(
                        "没有可直接升级的依赖：\n" + plan.skipped.take(5)
                            .joinToString("\n") { "· ${it.packageName}：${it.reason}" }
                    )
                    return@execute
                }
                val pool = if (packageName != null) {
                    plan.candidates.filter { it.packageName == packageName }.also {
                        if (it.isEmpty()) {
                            notifyInfo("$packageName 不在可自动升级范围。")
                            return@execute
                        }
                    }
                } else {
                    plan.candidates
                }

                val original = pomFile.readText(StandardCharsets.UTF_8)
                val previewEntries = pool.filter { applyUpgrade(original, it) != null }
                if (previewEntries.isEmpty()) {
                    notifyInfo("没有可在 pom.xml 中定位到的升级项。")
                    return@execute
                }
                val profile = projectProfile(dir)
                val projectText = listOfNotNull(
                    profile.javaVersion?.let { "Java $it" },
                    profile.springBootVersion?.let { "Spring Boot $it" }
                ).joinToString(" · ")
                val decision = showUpgradePreview(project, previewEntries, plan.skipped, projectText)
                    ?: run {
                        notifyInfo("已取消依赖升级。")
                        return@execute
                    }
                val chosen = previewEntries.filter { it.packageName in decision.packages }
                if (chosen.isEmpty()) return@execute

                var text = original
                chosen.forEach { candidate ->
                    val target = decision.versions[candidate.packageName] ?: candidate.to
                    val applied = applyUpgrade(text, candidate, target)
                        ?: run {
                            notifyError("未在 pom.xml 中找到 ${candidate.packageName} ${candidate.from}，已取消本次升级。")
                            return@execute
                        }
                    text = applied.text
                }

                setStage("写入 pom", 2)
                pomFile.writeText(text, StandardCharsets.UTF_8)
                advanceStage("校验编译")
                val build = Maven.runMvn(
                    dir, listOf("-B", "-q") + Maven.mirrorArgs() + listOf("-DskipTests", "compile"), 20 * 60_000
                )
                if (build.code != 0) {
                    pomFile.writeText(original, StandardCharsets.UTF_8)
                    notifyError("依赖升级后编译失败，已还原 pom.xml：${tail(build.stderr.ifBlank { build.stdout })}")
                    return@execute
                }
                notifyInfo("已升级 ${chosen.size} 个依赖并通过编译校验，正在重新扫描。")
                update { it.copy(stage = null) }
                scan(force = false)

                val spring = chosen.firstOrNull {
                    it.groupId == "org.springframework.boot" && it.mode.name.lowercase() in setOf("parent", "bom")
                }
                if (spring != null) {
                    val bootVersion = decision.versions[spring.packageName] ?: spring.to
                    val migrate = onEdt {
                        com.intellij.openapi.ui.Messages.showYesNoDialog(
                            project,
                            "Spring Boot 已升级到 $bootVersion 并通过编译。是否继续执行代码级迁移？（rewrite-spring 会改动业务代码）",
                            "继续迁移",
                            "执行代码迁移",
                            "稍后",
                            null
                        )
                    } == com.intellij.openapi.ui.Messages.YES
                    if (migrate) {
                        deepFixInternal(
                            DeepFixOverride(
                                recipes = listOf("org.openrewrite.java.spring.boot2.UpgradeSpringBoot_2_7"),
                                artifacts = emptyList(),
                                label = "Spring Boot $bootVersion 代码迁移"
                            )
                        )
                    }
                }
            } catch (e: Exception) {
                notifyError("依赖升级失败：${e.message}")
            } finally {
                update { it.copy(stage = null) }
            }
        }
    }

    private fun loadUpgradeContext(dir: File): UpgradeContext {
        val pomFile = File(dir, "pom.xml")
        val pom = runCatching { pomFile.readText(StandardCharsets.UTF_8) }.getOrElse { return UpgradeContext() }
        val key = sha1(pom)
        depContextCache?.let { if (it.first == key) return it.second }
        val context = UpgradeContext()
        try {
            val outDir = File(System.getProperty("java.io.tmpdir"), "quality-center")
            outDir.mkdirs()
            val outFile = File(outDir, "dependency-tree-${key.take(8)}.txt")
            outFile.delete()
            val outcome = Maven.runMvn(
                dir,
                listOf("-B", "-q") + Maven.mirrorArgs() +
                    listOf("dependency:tree", "-Dverbose", "-DoutputFile=${outFile.path}"),
                10 * 60_000
            )
            val text = if (outFile.exists()) outFile.readText(StandardCharsets.UTF_8)
            else "${outcome.stdout}\n${outcome.stderr}"
            val nodes = parseDependencyTree(text)
            val repo = localRepository(dir)
            val managed = repo?.let { indexBomManagement(parseBomRefs(pom), it) } ?: emptyMap()
            val built = UpgradeContext(nodes = nodes, managed = managed)
            depContextCache = key to built
            return built
        } catch (e: Exception) {
            return context
        }
    }

    // ---------------------------------------------------------------- 配方

    fun recipesForUi(): List<RecipeDefinition> {
        if (!settings.openRewriteShowAllRecipes) {
            return RECIPE_LIBRARY
        }
        return discoverCache?.let { mergeRecipeLibrary(it) } ?: RECIPE_LIBRARY
    }

    fun applicableRecipes(): List<RecipeDefinition> {
        val dir = root ?: return emptyList()
        return applicableRecipes(projectProfile(dir))
    }

    fun discoverRecipesIfNeeded() {
        val dir = root ?: return
        if (!settings.openRewriteShowAllRecipes || discoverCache != null || uiState.discoveringRecipes) {
            return
        }
        update { it.copy(discoveringRecipes = true) }
        executor.execute {
            try {
                val outcome = Maven.runMvn(
                    dir,
                    listOf("-B") + Maven.mirrorArgs() + listOf(
                        "-Dfile.encoding=UTF-8",
                        "-Ddetail=true",
                        "-Drewrite.recipeArtifactCoordinates=${DEFAULT_RECIPE_ARTIFACTS.joinToString(",")}",
                        "org.openrewrite.maven:rewrite-maven-plugin:$RECIPE_PLUGIN_VERSION:discover"
                    ),
                    5 * 60_000
                )
                val items = parseDiscoverOutput("${outcome.stdout}\n${outcome.stderr}")
                if (outcome.code != 0 && items.isEmpty()) {
                    throw IllegalStateException("rewrite:discover 执行失败")
                }
                discoverCache = classifyDiscoveredRecipes(items)
                update {
                    it.copy(
                        discoveringRecipes = false,
                        recipeLibrary = mergeRecipeLibrary(discoverCache ?: emptyList())
                    )
                }
            } catch (e: Exception) {
                update { it.copy(discoveringRecipes = false) }
            }
        }
    }

    // ---------------------------------------------------------------- 打开 / 环境

    fun openIssue(issue: Issue) {
        val path = issue.file?.trim()
        if (path.isNullOrEmpty()) {
            notifyInfo("这条问题没有可跳转的代码位置。")
            return
        }
        val target = resolveIssueFile(path)
        if (target == null) {
            notifyError("找不到文件：$path")
            return
        }
        openFile(target, issue.line ?: 1, issue.column ?: 1)
    }

    /** 兼容绝对 / 相对路径与正反斜杠：逐个候选探测，找不到就提示而不是静默失败 */
    private fun resolveIssueFile(path: String): File? {
        val direct = File(path)
        val candidates = mutableListOf<File>()
        if (direct.isAbsolute) {
            candidates += direct
        } else {
            baseDir?.let { root ->
                candidates += File(root, path)
                candidates += File(root, path.replace('/', File.separatorChar).replace('\\', File.separatorChar))
            }
        }
        candidates.firstOrNull { it.isFile }?.let { return it.absoluteFile.normalize() }
        candidates.firstOrNull { it.exists() }?.let { return it.absoluteFile.normalize() }
        return null
    }

    fun openFile(file: File, line: Int) = openFile(file, line, 1)

    fun openFile(file: File, line: Int, column: Int) {
        ApplicationManager.getApplication().invokeLater {
            val target = file.absoluteFile.normalize()
            if (!target.isFile) {
                notifyError("无法定位文件：${target.path}")
                return@invokeLater
            }
            val virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(target)
            if (virtualFile == null || virtualFile.isDirectory) {
                notifyError("无法在 IDE 中打开文件：${target.path}")
                return@invokeLater
            }
            val offset = ApplicationManager.getApplication().runReadAction<Int> {
                val document = FileDocumentManager.getInstance().getDocument(virtualFile)
                if (document == null) {
                    0
                } else {
                    val lineIndex = (line - 1).coerceIn(0, (document.lineCount - 1).coerceAtLeast(0))
                    document.getLineStartOffset(lineIndex)
                }
            }
            val manager = FileEditorManager.getInstance(project)
            val descriptor = OpenFileDescriptor(project, virtualFile, offset, 0)
            runCatching { descriptor.navigate(true) }
            var editor = (manager.getSelectedEditor(virtualFile) as? TextEditor)?.editor
                ?: manager.getAllEditors(virtualFile).filterIsInstance<TextEditor>().firstOrNull()?.editor
            if (editor == null) {
                editor = runCatching { manager.openTextEditor(descriptor, true) }.getOrNull()
            }
            if (editor == null) {
                notifyError("无法打开文件：${target.path}")
                return@invokeLater
            }
            placeCaret(editor, line, column)
        }
    }

    /** 用逻辑行列定位：不依赖字符 offset，文档未加载 / 换行符差异都不会把行号算歪 */
    private fun placeCaret(editor: Editor, line: Int, column: Int) {
        val document = editor.document
        if (document.lineCount <= 0) return
        val lineIndex = (line - 1).coerceIn(0, document.lineCount - 1)
        val lineStart = document.getLineStartOffset(lineIndex)
        val lineEnd = document.getLineEndOffset(lineIndex)
        val columnIndex = (column - 1).coerceIn(0, (lineEnd - lineStart).coerceAtLeast(0))
        editor.caretModel.moveToLogicalPosition(LogicalPosition(lineIndex, columnIndex))
        editor.scrollingModel.scrollToCaret(ScrollType.CENTER)
    }

    fun openLink(url: String) {
        com.intellij.ide.BrowserUtil.browse(url)
    }

    fun projectProfile(dir: File): ProjectProfile {
        val pom = File(dir, "pom.xml")
        val key = "${pom.lastModified()}:${pom.length()}"
        profileCache?.let { if (it.first == key) return it.second }
        val profile = runCatching { detectProjectProfile(dir) }.getOrDefault(ProjectProfile())
        profileCache = key to profile
        return profile
    }

    private fun writeAgentFiles(result: ScanResult?) {
        val dir = root ?: return
        if (result == null || !settings.exportForAgent) {
            update { it.copy(agentFile = null) }
            return
        }
        runCatching {
            val exported = AgentExport.exportForAgent(dir, result)
            val rel = File(exported.jsonPath).relativeTo(dir).path.replace('\\', '/')
            update { it.copy(agentFile = rel) }
        }.onFailure { update { it.copy(agentFile = null) } }
    }

    private fun setStage(label: String, total: Int) {
        update { it.copy(stage = StageProgress(label, 0, total)) }
    }

    private fun buildScanOptions(): ScanOptions {
        val bundled = bundledDir()
        return ScanOptions(
            checkstyleEnabled = settings.checkstyleEnabled,
            checkstyleConfig = settings.checkstyleConfig,
            bundledCheckstyle = bundled?.let { File(it, "checkstyle-default.xml") },
            gitleaksEnabled = settings.gitleaksEnabled,
            gitleaksPath = settings.gitleaksPath,
            bundledGitleaks = bundled?.let { File(it, "gitleaks.toml") },
            trivyEnabled = settings.trivyEnabled,
            trivyOptions = TrivyScanner.TrivyOptions(
                executable = settings.trivyPath,
                scanTarget = settings.trivyScanTarget.ifBlank { null },
                dbRepository = settings.trivyDbRepository.ifBlank { null },
                javaDbRepository = settings.trivyJavaDbRepository.ifBlank { null },
                preferMirror = settings.trivyPreferMirror,
                minSeverity = settings.trivyMinSeverity,
                onlyFixed = settings.trivyOnlyFixed
            ),
            spotbugsEnabled = settings.spotbugsEnabled,
            mavenUseChinaMirror = true
        )
    }

    /** 把插件内置的 Checkstyle / Gitleaks 配置解压到系统目录，作为兜底规则 */
    private fun bundledDir(): File? {
        val dir = File(File(PathManager.getSystemPath(), "quality-center"), "bundled")
        return try {
            dir.mkdirs()
            listOf("checkstyle-default.xml", "gitleaks.toml").forEach { name ->
                val target = File(dir, name)
                if (!target.exists()) {
                    javaClass.getResourceAsStream("/media/$name")?.use { input ->
                        target.outputStream().use { output -> input.copyTo(output) }
                    }
                }
            }
            dir
        } catch (_: Exception) {
            null
        }
    }

    private fun advanceStage(label: String) {
        update { state ->
            val current = state.stage ?: StageProgress(label, 0, 1)
            state.copy(stage = current.copy(label = label, done = (current.done + 1).coerceAtMost(current.total)))
        }
    }

    private fun git(dir: File, args: List<String>, timeoutMs: Long = 30_000): Exec.Result =
        Exec.run("git", args, dir, timeoutMs)

    private fun sourceEncoding(dir: File): String {
        val pom = File(dir, "pom.xml")
        val text = runCatching { pom.readText(StandardCharsets.UTF_8) }.getOrNull() ?: return "UTF-8"
        Regex("<project\\.build\\.sourceEncoding>\\s*([^<]+?)\\s*</project\\.build\\.sourceEncoding>")
            .find(text)?.groupValues?.get(1)?.let { return it.trim() }
        Regex("<encoding>\\s*([^<]+?)\\s*</encoding>").find(text)?.groupValues?.get(1)
            ?.let { return it.trim() }
        return "UTF-8"
    }

    private fun sha1(text: String): String =
        MessageDigest.getInstance("SHA-1").digest(text.toByteArray(StandardCharsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    private fun tail(text: String): String =
        text.lines().filter { it.isNotBlank() }.takeLast(6).joinToString("\n")

    private fun File.readTextSafely(): String? =
        runCatching { com.dsda56180.qualitycenter.util.TextIO.decode(readBytes()) }.getOrNull()

    fun notifyInfo(message: String) = notify(message, NotificationType.INFORMATION)

    fun notifyError(message: String) = notify(message, NotificationType.ERROR)

    private fun notify(message: String, type: NotificationType) {
        NotificationGroupManager.getInstance().getNotificationGroup("QualityCenter")
            .createNotification("质量中心", message, type)
            .notify(project)
    }

    /**
     * 扫描/修复跑在后台线程，但对话框、DialogWrapper 只能从 EDT 打开，
     * 新版 IDE 会直接抛「Access is allowed from EDT only」。统一切到 EDT 再回传结果。
     */
    private fun <T> onEdt(block: () -> T): T {
        val app = ApplicationManager.getApplication()
        if (app.isDispatchThread) return block()
        var holder: Any? = null
        app.invokeAndWait { holder = block() }
        @Suppress("UNCHECKED_CAST")
        return holder as T
    }

    override fun dispose() {
        executor.shutdownNow()
        Exec.killAll()
    }

    private class LowercaseEnumAdapter<T : Enum<T>>(private val type: Class<T>) : TypeAdapter<T>() {
        override fun write(out: JsonWriter, value: T?) {
            out.value(value?.name?.lowercase())
        }

        override fun read(input: JsonReader): T? {
            val text = input.nextString() ?: return null
            return type.enumConstants.firstOrNull { it.name.equals(text, ignoreCase = true) }
        }
    }
}

/** 保存事件监听：与 VS Code 版一致，仅 Java 类文件保存后触发自动扫描 */
class SaveScanListener : FileDocumentManagerListener {
    override fun beforeDocumentSaving(document: Document) {
        val file = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getFile(document) ?: return
        val ext = file.extension?.lowercase() ?: return
        if (ext !in setOf("java", "xml", "properties", "yml", "yaml", "toml", "json", "gradle", "kts")) {
            return
        }
        val project = com.intellij.openapi.project.ProjectLocator.getInstance()
            .getProjectsForFile(file).firstOrNull() ?: return
        project.getService(QualityCenterService::class.java)?.onDocumentSaved()
    }
}
