package com.dsda56180.qualitycenter.util

import java.io.File

/**
 * Maven Central 在国内网络下经常很慢或不可达。
 * 用户没有自己的 ~/.m2/settings.xml 时，生成一份仅包含阿里云公共仓库镜像的
 * settings.xml，并通过 `-s` 传给 mvn；用户已有 settings.xml（企业私服、代理等）时不干预。
 */
object Maven {
    private const val SETTINGS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.0.0 https://maven.apache.org/xsd/settings-1.0.0.xsd">
  <mirrors>
    <mirror>
      <id>aliyun-public</id>
      <name>Aliyun Maven Public</name>
      <url>https://maven.aliyun.com/repository/public</url>
      <mirrorOf>central</mirrorOf>
    </mirror>
  </mirrors>
</settings>
"""

    /** 插件存储目录，对应原扩展的 extensionStorage */
    private var storageDir: File? = null

    /** 是否启用国内镜像，由设置项 qualityCenter.maven.useChinaMirror 同步过来 */
    @Volatile
    var useChinaMirror: Boolean = true

    fun init(storage: String?) {
        storageDir = storage?.takeIf { it.isNotBlank() }?.let(::File)
    }

    private fun userSettingsPath(): File = File(System.getProperty("user.home"), ".m2${File.separator}settings.xml")

    /**
     * 返回需要追加到 mvn 命令行的参数。
     * 已有用户级 settings.xml 或关闭镜像开关时返回空列表。
     */
    fun mirrorArgs(enabled: Boolean = useChinaMirror): List<String> {
        if (!enabled) {
            return emptyList()
        }
        // 用户已有自己的 Maven 配置时不动它，避免覆盖私服、代理或本地仓库设置
        if (userSettingsPath().exists()) {
            return emptyList()
        }
        val dir = storageDir ?: File(System.getProperty("java.io.tmpdir"), "quality-center")
        val file = File(dir, "maven-settings.xml")
        return try {
            dir.mkdirs()
            if (!file.exists()) {
                file.writeText(SETTINGS_XML, Charsets.UTF_8)
            }
            listOf("-s", file.path)
        } catch (_: Exception) {
            emptyList()
        }
    }

    /** 执行 mvn 命令（阻塞），参数由调用方决定是否追加镜像参数 */
    fun runMvn(
        root: File,
        args: List<String>,
        timeoutMs: Long = 180_000,
        env: Map<String, String> = emptyMap()
    ): Exec.Result = Exec.run("mvn", args, root, timeoutMs, env)
}
