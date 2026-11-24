package com.dsda56180.qualitycenter.util

import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * 命令执行工具：统一走 shell（Windows 上 mvn / gitleaks / trivy 多为 .cmd），
 * 超时后结束整棵进程树并立即返回，避免子进程占住输出流导致调用方永远等不到结果。
 */
object Exec {
    data class Result(val code: Int, val stdout: String, val stderr: String)

    private val running = ConcurrentHashMap.newKeySet<Process>()
    private val drainer = Executors.newCachedThreadPool { r ->
        Thread(r, "quality-center-exec-drain").apply { isDaemon = true }
    }

    fun run(
        command: String,
        args: List<String>,
        cwd: File,
        timeoutMs: Long = 180_000,
        env: Map<String, String> = emptyMap()
    ): Result {
        val line = (listOf(command) + args.map(::quote)).joinToString(" ")
        val builder = if (isWindows()) {
            ProcessBuilder("cmd.exe", "/d", "/s", "/c", line)
        } else {
            ProcessBuilder("/bin/sh", "-c", line)
        }
        builder.directory(cwd)
        builder.environment().putAll(env)
        val process = try {
            builder.start()
        } catch (e: Exception) {
            return Result(1, "", e.message ?: "无法启动命令：$command")
        }
        running.add(process)

        var stdout = ""
        var stderr = ""
        val outTask = drainer.submit { stdout = TextIO.decode(process.inputStream.readBytes()) }
        val errTask = drainer.submit { stderr = TextIO.decode(process.errorStream.readBytes()) }

        val finished = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
        if (!finished) {
            killTree(process)
            process.waitFor(3, TimeUnit.SECONDS)
            runCatching { outTask.get(2, TimeUnit.SECONDS) }
            runCatching { errTask.get(2, TimeUnit.SECONDS) }
            running.remove(process)
            val tip = "命令执行超过 ${timeoutMs / 1000} 秒，已终止"
            return Result(124, stdout, if (stderr.isBlank()) tip else "$stderr\n$tip")
        }

        runCatching { outTask.get(5, TimeUnit.SECONDS) }
        runCatching { errTask.get(5, TimeUnit.SECONDS) }
        running.remove(process)
        val code = runCatching { process.exitValue() }.getOrDefault(1)
        return Result(code, stdout, stderr)
    }

    /** 结束所有仍在运行的命令（终止扫描时调用） */
    fun killAll() {
        running.forEach { killTree(it) }
        running.clear()
    }

    private fun killTree(process: Process) {
        val pid = runCatching { process.pid() }.getOrNull() ?: return
        runCatching {
            if (isWindows()) {
                ProcessBuilder("taskkill", "/T", "/F", "/PID", pid.toString())
                    .redirectErrorStream(true)
                    .start()
                    .waitFor(5, TimeUnit.SECONDS)
            } else {
                process.descendants().forEach { it.destroyForcibly() }
                process.destroyForcibly()
            }
        }
        runCatching { process.destroyForcibly() }
    }

    /** 定位可执行文件：显式配置 → where/which → WinGet / Chocolatey / Scoop 常见目录 */
    fun resolveBinary(name: String, configured: String? = null): String? {
        if (!configured.isNullOrBlank()) {
            return configured
        }
        val probe = run(if (isWindows()) "where" else "which", listOf(name), File("."), 15_000)
        if (probe.code == 0) {
            probe.stdout.lineSequence()
                .map { it.trim() }
                .firstOrNull { it.isNotEmpty() && File(it).exists() }
                ?.let { return it }
        }
        if (!isWindows()) {
            return null
        }
        val candidates = mutableListOf<String>()
        System.getenv("LOCALAPPDATA")?.let {
            candidates += File(it, "Microsoft/WinGet/Links/$name.exe").path
        }
        candidates += File("C:/ProgramData/chocolatey/bin/$name.exe").path
        System.getenv("USERPROFILE")?.let {
            candidates += File(it, "scoop/shims/$name.exe").path
        }
        return candidates.firstOrNull { File(it).exists() }
    }

    fun isWindows(): Boolean = System.getProperty("os.name").lowercase().contains("win")

    private fun quote(arg: String): String {
        if (!arg.any { it == ' ' || it == '"' || it == '&' || it == '|' || it == '<' || it == '>' || it == '^' || it == '(' || it == ')' }) {
            return arg
        }
        return "\"${arg.replace("\"", "\"\"")}\""
    }
}
