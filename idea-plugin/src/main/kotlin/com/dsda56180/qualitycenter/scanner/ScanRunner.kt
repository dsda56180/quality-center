package com.dsda56180.qualitycenter.scanner

import com.dsda56180.qualitycenter.baseline.Baseline
import com.dsda56180.qualitycenter.model.Issue
import com.dsda56180.qualitycenter.model.IssueSource
import com.dsda56180.qualitycenter.model.ScanError
import com.dsda56180.qualitycenter.model.ScanProgress
import com.dsda56180.qualitycenter.model.ScanResult
import com.dsda56180.qualitycenter.model.Severity
import com.dsda56180.qualitycenter.model.SkippedSource
import com.dsda56180.qualitycenter.suggest.Suggestions
import com.dsda56180.qualitycenter.util.Exec
import com.dsda56180.qualitycenter.util.Maven
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonDeserializationContext
import com.google.gson.JsonDeserializer
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import com.google.gson.JsonSerializationContext
import com.google.gson.JsonSerializer
import java.io.File
import java.lang.reflect.Type
import java.security.MessageDigest
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.thread

/** 扫描配置，字段对应原扩展 qualityCenter.* 配置项 */
data class ScanOptions(
    val checkstyleEnabled: Boolean = true,
    val checkstyleConfig: String = "",
    val bundledCheckstyle: File? = null,
    val gitleaksEnabled: Boolean = true,
    val gitleaksPath: String = "",
    val bundledGitleaks: File? = null,
    val trivyEnabled: Boolean = true,
    val trivyOptions: TrivyScanner.TrivyOptions = TrivyScanner.TrivyOptions(),
    val spotbugsEnabled: Boolean = true,
    val mavenUseChinaMirror: Boolean = true
)

/**
 * 扫描调度器：最多 2 个扫描器并行，支持暂停 / 恢复 / 取消，
 * 扫描结果与各扫描器输出按文件指纹缓存到 scan-cache.json，
 * 文件未变化时直接复用上次结果，跳过 Maven / Trivy 调用。
 */
class ScanRunner(private val root: File, private val cacheFile: File?) {

    private data class FileStat(val rel: String, val size: Long, val mtime: Long)

    private data class CacheEntry(val sig: String, val value: Any)

    private class Job(val label: String, val run: () -> Unit)

    private val gson: Gson = GsonBuilder()
        .registerTypeAdapter(
            IssueSource::class.java,
            object : JsonSerializer<IssueSource>, JsonDeserializer<IssueSource> {
                override fun serialize(src: IssueSource, typeOfSrc: Type, context: JsonSerializationContext): JsonElement =
                    JsonPrimitive(src.id)

                override fun deserialize(json: JsonElement, typeOfT: Type, context: JsonDeserializationContext): IssueSource =
                    IssueSource.from(if (json.isJsonPrimitive) json.asString else null) ?: IssueSource.CHECKSTYLE
            }
        )
        .registerTypeAdapter(
            Severity::class.java,
            object : JsonSerializer<Severity>, JsonDeserializer<Severity> {
                override fun serialize(src: Severity, typeOfSrc: Type, context: JsonSerializationContext): JsonElement =
                    JsonPrimitive(src.id)

                override fun deserialize(json: JsonElement, typeOfT: Type, context: JsonDeserializationContext): Severity =
                    Severity.from(if (json.isJsonPrimitive) json.asString else null)
            }
        )
        .create()

    @Volatile
    private var running = false

    private val lock = ReentrantLock()
    private val resumeCondition = lock.newCondition()

    /** 扫描队列暂停：当前扫描器结束后不再启动新的扫描器 */
    private var paused = false

    @Volatile
    private var cancelled = false

    @Volatile
    private var resultBacking: ScanResult? = null
    private var cacheLoaded = false

    /** 扫描器结果缓存：文件指纹一致时跳过 Maven/Trivy 调用 */
    private val caches = ConcurrentHashMap<String, CacheEntry>()

    /** 扫描配置 */
    var options: ScanOptions = ScanOptions()

    /** 最近一次扫描结果（首次访问时从磁盘恢复） */
    var lastResult: ScanResult?
        get() {
            if (resultBacking == null) {
                loadPersisted()
            }
            return resultBacking
        }
        set(value) {
            resultBacking = value
        }

    val isRunning: Boolean
        get() = running

    fun pause() {
        lock.lock()
        try {
            paused = true
        } finally {
            lock.unlock()
        }
    }

    fun resume() {
        lock.lock()
        try {
            paused = false
            resumeCondition.signalAll()
        } finally {
            lock.unlock()
        }
    }

    /** 终止当前扫描：唤醒等待中的队列并杀掉正在运行的命令进程树 */
    fun cancel() {
        lock.lock()
        try {
            cancelled = true
            paused = false
            resumeCondition.signalAll()
        } finally {
            lock.unlock()
        }
        Exec.killAll()
    }

    private fun awaitResume() {
        lock.lock()
        try {
            while (paused && !cancelled) {
                resumeCondition.await()
            }
        } finally {
            lock.unlock()
        }
    }

    private fun outputDir(): File {
        val base = cacheFile?.parentFile ?: File(System.getProperty("java.io.tmpdir"), "quality-center")
        return File(File(base, "reports"), root.name)
    }

    /** 采集目录下符合条件的文件状态，用于判断扫描结果是否还能复用 */
    private fun collectStats(
        dir: File,
        depth: Int = 0,
        out: MutableList<FileStat> = mutableListOf(),
        accept: (String) -> Boolean
    ): MutableList<FileStat> {
        val entries = dir.listFiles() ?: return out
        for (entry in entries) {
            if (entry.name == "node_modules" || entry.name == ".git") {
                continue
            }
            if (entry.isDirectory) {
                if (depth < 20) {
                    collectStats(entry, depth + 1, out, accept)
                }
            } else if (entry.isFile && accept(entry.name)) {
                runCatching {
                    out.add(FileStat(entry.path, entry.length(), entry.lastModified()))
                }
            }
        }
        return out
    }

    private fun statFile(file: File): List<FileStat> {
        return runCatching {
            if (file.exists()) {
                listOf(FileStat(file.path, file.length(), file.lastModified()))
            } else {
                emptyList()
            }
        }.getOrDefault(emptyList())
    }

    /** 把文件状态与配置拼成指纹，指纹一致即认为结果仍有效 */
    private fun fingerprint(stats: List<FileStat>, extras: List<String>): String {
        val digest = MessageDigest.getInstance("SHA-1")
        stats.sortedBy { it.rel }.forEach { item ->
            digest.update("${item.rel}|${item.size}|${item.mtime}\n".toByteArray(Charsets.UTF_8))
        }
        extras.forEach { item ->
            digest.update("$item\n".toByteArray(Charsets.UTF_8))
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** 与原实现的 JSON.stringify(trivyOptions) 保持一致的配置签名 */
    private fun trivySignature(options: TrivyScanner.TrivyOptions): String {
        val obj = JsonObject().apply {
            addProperty("executable", options.executable)
            addProperty("scanTarget", options.scanTarget ?: "")
            addProperty("dbRepository", options.dbRepository ?: "")
            addProperty("javaDbRepository", options.javaDbRepository ?: "")
            addProperty("preferMirror", options.preferMirror)
            addProperty("minSeverity", options.minSeverity)
            addProperty("onlyFixed", options.onlyFixed)
        }
        return gson.toJson(obj)
    }

    private fun cacheRootPath(): String = root.absoluteFile.path

    /** 载入上一次扫描结果与扫描器缓存，打开面板即可先看到旧结果 */
    private fun loadPersisted() {
        if (cacheLoaded) {
            return
        }
        cacheLoaded = true
        val file = cacheFile ?: return
        if (!file.exists()) {
            return
        }
        try {
            val payload = JsonParser.parseString(file.readText(Charsets.UTF_8)).asJsonObject
            val storedRoot = payload.get("root")?.takeIf { it.isJsonPrimitive }?.asString
            if (storedRoot != cacheRootPath()) {
                return
            }
            val resultElement = payload.get("result")
            if (resultElement != null && !resultElement.isJsonNull) {
                resultBacking = gson.fromJson(resultElement, ScanResult::class.java)
            }
            val scanners = payload.getAsJsonObject("scanners")
            scanners?.entrySet()?.forEach { (key, value) ->
                val obj = value.takeIf { it.isJsonObject }?.asJsonObject ?: return@forEach
                val sig = obj.get("sig")?.takeIf { it.isJsonPrimitive }?.asString ?: return@forEach
                val valueElement = obj.get("value")
                val parsed: Any? = when (key) {
                    "checkstyle" -> gson.fromJson(valueElement, CheckstyleScanner.CheckstyleResult::class.java)
                    "trivy" -> gson.fromJson(valueElement, TrivyScanner.TrivyResult::class.java)
                    "spotbugs" -> gson.fromJson(valueElement, SpotbugsScanner.SpotbugsResult::class.java)
                    else -> null
                }
                if (parsed != null) {
                    caches[key] = CacheEntry(sig, parsed)
                }
            }
        } catch (_: Exception) {
            // 缓存损坏时忽略，按无缓存处理
        }
    }

    private fun persist() {
        val file = cacheFile ?: return
        val result = resultBacking ?: return
        try {
            file.parentFile?.mkdirs()
            val scanners = JsonObject()
            caches.forEach { (key, entry) ->
                scanners.add(
                    key,
                    JsonObject().apply {
                        addProperty("sig", entry.sig)
                        add("value", gson.toJsonTree(entry.value))
                    }
                )
            }
            val payload = JsonObject().apply {
                addProperty("root", cacheRootPath())
                add("result", gson.toJsonTree(result))
                add("scanners", scanners)
            }
            file.writeText(gson.toJson(payload), Charsets.UTF_8)
        } catch (_: Exception) {
            // 缓存写入失败不影响扫描
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T> cached(key: String, sig: String): T? {
        val entry = caches[key] ?: return null
        if (entry.sig != sig) {
            return null
        }
        return entry.value as? T
    }

    private fun remember(key: String, sig: String, value: Any) {
        caches[key] = CacheEntry(sig, value)
    }

    /**
     * 执行一次完整扫描（阻塞）。最多 2 个扫描器并行；
     * 暂停时在当前扫描器结束后停下，恢复后继续；取消会杀掉正在运行的命令。
     */
    fun scan(onProgress: (ScanProgress) -> Unit = {}): ScanResult {
        if (running) {
            return resultBacking ?: ScanResult(System.currentTimeMillis(), System.currentTimeMillis())
        }

        running = true
        cancelled = false
        val startedAt = System.currentTimeMillis()
        val issues: MutableList<Issue> = Collections.synchronizedList(mutableListOf<Issue>())
        val errors: MutableList<ScanError> = Collections.synchronizedList(mutableListOf<ScanError>())
        val skipped: MutableList<SkippedSource> = Collections.synchronizedList(mutableListOf<SkippedSource>())
        val outDir = outputDir()
        val buildHint = AtomicReference<String?>(null)

        try {
            Maven.useChinaMirror = options.mavenUseChinaMirror
            val jobs = mutableListOf<Job>()

            if (options.checkstyleEnabled) {
                val configPath = CheckstyleScanner.resolveConfig(root, options.checkstyleConfig, options.bundledCheckstyle)
                if (configPath == null) {
                    skipped.add(SkippedSource(IssueSource.CHECKSTYLE, "未找到 Checkstyle 规则文件"))
                } else {
                    val sig = fingerprint(
                        collectStats(File(root, "src")) { it.endsWith(".java") } +
                            statFile(configPath) +
                            statFile(File(root, "pom.xml")),
                        listOf("checkstyle-v1", configPath.path)
                    )
                    val hit = cached<CheckstyleScanner.CheckstyleResult>("checkstyle", sig)
                    if (hit != null) {
                        issues.addAll(hit.issues)
                        hit.error?.takeIf { it.isNotEmpty() }?.let {
                            errors.add(ScanError(IssueSource.CHECKSTYLE, it))
                        }
                    } else {
                        jobs.add(Job("Checkstyle") {
                            val res = CheckstyleScanner.scan(root, configPath, File(outDir, "checkstyle.xml"))
                            issues.addAll(res.issues)
                            val error = res.error
                            if (error != null && error.isNotEmpty()) {
                                errors.add(ScanError(IssueSource.CHECKSTYLE, error))
                            } else {
                                remember("checkstyle", sig, res)
                            }
                        })
                    }
                }
            } else {
                skipped.add(SkippedSource(IssueSource.CHECKSTYLE, "已在设置中关闭"))
            }

            if (options.gitleaksEnabled) {
                val localConfig = File(root, ".gitleaks.toml")
                val gitleaksConfig = if (localConfig.exists()) localConfig else options.bundledGitleaks
                jobs.add(Job("Gitleaks") {
                    val res = GitleaksScanner.scan(
                        root,
                        options.gitleaksPath,
                        File(outDir, "gitleaks.json"),
                        gitleaksConfig
                    )
                    if (res.missing) {
                        skipped.add(SkippedSource(IssueSource.GITLEAKS, "未找到 gitleaks 可执行文件"))
                    } else {
                        issues.addAll(res.issues)
                        res.error?.takeIf { it.isNotEmpty() }?.let {
                            errors.add(ScanError(IssueSource.GITLEAKS, it))
                        }
                    }
                })
            } else {
                skipped.add(SkippedSource(IssueSource.GITLEAKS, "已在设置中关闭"))
            }

            if (options.trivyEnabled) {
                val trivyOptions = options.trivyOptions
                // 依赖漏洞只受 pom 与构建产物影响，改代码不需要重跑 trivy
                val sig = fingerprint(
                    statFile(File(root, "pom.xml")) +
                        collectStats(File(root, "target")) {
                            Regex("\\.(jar|pom)$", RegexOption.IGNORE_CASE).containsMatchIn(it)
                        },
                    listOf("trivy-v1", trivySignature(trivyOptions), LocalDate.now(ZoneOffset.UTC).toString())
                )
                val hit = cached<TrivyScanner.TrivyResult>("trivy", sig)
                if (hit != null) {
                    if (hit.missing) {
                        skipped.add(SkippedSource(IssueSource.TRIVY, "未找到 trivy 可执行文件"))
                    } else {
                        issues.addAll(hit.issues)
                        val error = hit.error
                        if (error != null && error.isNotEmpty()) {
                            errors.add(ScanError(IssueSource.TRIVY, error))
                        } else if (hit.usedBuildArtifacts == false) {
                            buildHint.set(TRIVY_BUILD_HINT)
                        }
                    }
                } else {
                    jobs.add(Job("Trivy") {
                        val res = TrivyScanner.scan(root, trivyOptions)
                        if (res.missing) {
                            skipped.add(SkippedSource(IssueSource.TRIVY, "未找到 trivy 可执行文件"))
                        } else {
                            issues.addAll(res.issues)
                            val error = res.error
                            if (error != null && error.isNotEmpty()) {
                                errors.add(ScanError(IssueSource.TRIVY, error))
                            } else {
                                if (res.usedBuildArtifacts == false) {
                                    buildHint.set(TRIVY_BUILD_HINT)
                                }
                                remember("trivy", sig, res)
                            }
                        }
                    })
                }
            } else {
                skipped.add(SkippedSource(IssueSource.TRIVY, "已在设置中关闭"))
            }

            if (options.spotbugsEnabled) {
                // 字节码没变就不需要再启动一次 Maven + SpotBugs（单次约 30 秒）
                val sig = fingerprint(
                    collectStats(File(root, "target${File.separator}classes")) { it.endsWith(".class") } +
                        statFile(File(root, "pom.xml")),
                    listOf("spotbugs-v1", "4.7.3.0", "findsecbugs-1.12.0", "Max", "Low")
                )
                val hit = cached<SpotbugsScanner.SpotbugsResult>("spotbugs", sig)
                if (hit != null) {
                    if (hit.needsBuild) {
                        skipped.add(SkippedSource(IssueSource.SPOTBUGS, "未找到 target/classes，需要先构建项目"))
                        buildHint.updateAndGet { it ?: SPOTBUGS_BUILD_HINT }
                    } else {
                        issues.addAll(hit.issues)
                        hit.error?.takeIf { it.isNotEmpty() }?.let {
                            errors.add(ScanError(IssueSource.SPOTBUGS, it))
                        }
                    }
                } else {
                    jobs.add(Job("SpotBugs") {
                        val res = SpotbugsScanner.scan(root)
                        if (res.needsBuild) {
                            skipped.add(SkippedSource(IssueSource.SPOTBUGS, "未找到 target/classes，需要先构建项目"))
                            buildHint.updateAndGet { it ?: SPOTBUGS_BUILD_HINT }
                        } else {
                            issues.addAll(res.issues)
                            val error = res.error
                            if (error != null && error.isNotEmpty()) {
                                errors.add(ScanError(IssueSource.SPOTBUGS, error))
                            } else {
                                remember("spotbugs", sig, res)
                            }
                        }
                    })
                }
            } else {
                skipped.add(SkippedSource(IssueSource.SPOTBUGS, "已在设置中关闭"))
            }

            val total = jobs.size
            val active = ConcurrentHashMap.newKeySet<String>()
            active.addAll(jobs.map { it.label })
            val doneCounter = AtomicInteger(0)
            val nextIndex = AtomicInteger(0)
            onProgress(ScanProgress(0, total, active.toList()))

            // 最多同时跑两个扫描器：既保留并行速度，又让「暂停」能在扫描器边界生效
            val workerCount = minOf(2, jobs.size)
            val workers = (0 until workerCount).map { index ->
                thread(name = "quality-center-scan-$index", isDaemon = true) {
                    while (true) {
                        awaitResume()
                        if (cancelled) {
                            return@thread
                        }
                        val jobIndex = nextIndex.getAndIncrement()
                        if (jobIndex >= jobs.size) {
                            return@thread
                        }
                        val job = jobs[jobIndex]
                        try {
                            job.run()
                        } catch (_: Exception) {
                            // 单个扫描器异常不阻断其它扫描器
                        }
                        active.remove(job.label)
                        val done = doneCounter.incrementAndGet()
                        onProgress(ScanProgress(done, total, active.toList()))
                    }
                }
            }
            workers.forEach { it.join() }

            if (cancelled) {
                // 终止扫描时，被杀进程会返回非零退出码，这里清掉由此产生的误报
                errors.clear()
                buildHint.set(null)
            }
        } finally {
            running = false
        }

        val sortedIssues = issues.toList().sortedBy { it.severity.ordinal }
        val split = Baseline.splitByBaseline(root, sortedIssues)
        val result = ScanResult(
            startedAt = startedAt,
            finishedAt = System.currentTimeMillis(),
            issues = split.active,
            ignored = split.ignored,
            errors = errors,
            skipped = skipped,
            suggestions = mutableListOf(),
            buildHint = buildHint.get()
        )
        result.suggestions = Suggestions.buildSuggestions(root, result)
        resultBacking = result
        persist()
        return result
    }

    /** 忽略某条问题并写入本地基线 */
    fun ignoreIssue(id: Int): Boolean {
        val result = lastResult ?: return false
        val index = id - 1
        if (index !in result.issues.indices) {
            return false
        }
        val issue = result.issues[index]
        Baseline.addToBaseline(root, issue)
        result.issues.removeAt(index)
        result.ignored.add(issue)
        result.suggestions = Suggestions.buildSuggestions(root, result)
        persist()
        return true
    }

    /** 从基线恢复某条已忽略问题 */
    fun unignoreIssue(id: Int): Boolean {
        val result = lastResult ?: return false
        val index = id - 1
        if (index !in result.ignored.indices) {
            return false
        }
        val issue = result.ignored[index]
        Baseline.removeFromBaseline(root, issue)
        result.ignored.removeAt(index)
        result.issues.add(issue)
        result.issues.sortBy { it.severity.ordinal }
        result.suggestions = Suggestions.buildSuggestions(root, result)
        persist()
        return true
    }

    private companion object {
        const val TRIVY_BUILD_HINT =
            "未找到可用的构建产物（target 下没有 jar/pom），当前基于源码离线解析，依赖版本可能不完整。" +
                "点击「构建并扫描」执行 mvn package 后可获得准确的依赖漏洞清单。"

        const val SPOTBUGS_BUILD_HINT =
            "未找到编译产物，字节码级静态缺陷扫描（SpotBugs）已跳过。点击「构建并扫描」执行 mvn package 后可获得完整结果。"
    }
}
