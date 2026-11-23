package com.dsda56180.qualitycenter.project

import java.io.File

/**
 * 项目画像：从根 pom.xml 推断出的技术栈版本。
 * junit 取值 "junit4" / "junit5"，junit4 时才会推荐 JUnit 4 → 5 迁移。
 */
data class ProjectProfile(
    val javaVersion: Int? = null,
    val springBootVersion: String? = null,
    val junit: String? = null
)

private val PLACEHOLDER = Regex("\\$\\{([^}]+)}")

private val JAVA_PATTERNS = listOf(
    Regex("<java\\.version>\\s*([^<]+?)\\s*</java\\.version>", RegexOption.IGNORE_CASE),
    Regex("<maven\\.compiler\\.source>\\s*([^<]+?)\\s*</maven\\.compiler\\.source>", RegexOption.IGNORE_CASE),
    Regex("<maven\\.compiler\\.target>\\s*([^<]+?)\\s*</maven\\.compiler\\.target>", RegexOption.IGNORE_CASE),
    Regex("<source>\\s*([^<]+?)\\s*</source>", RegexOption.IGNORE_CASE),
    Regex("<target>\\s*([^<]+?)\\s*</target>", RegexOption.IGNORE_CASE)
)

private val SPRING_BOOT_PATTERNS = listOf(
    Regex(
        "<artifactId>\\s*spring-boot-starter-parent\\s*</artifactId>\\s*<version>\\s*([^<]+?)\\s*</version>",
        RegexOption.IGNORE_CASE
    ),
    Regex(
        "<artifactId>\\s*spring-boot-dependencies\\s*</artifactId>\\s*<version>\\s*([^<]+?)\\s*</version>",
        RegexOption.IGNORE_CASE
    )
)

private fun firstMatch(text: String, patterns: List<Regex>): String? {
    for (pattern in patterns) {
        val match = pattern.find(text) ?: continue
        return match.groupValues[1].trim()
    }
    return null
}

private fun normalizeJava(raw: String?): Int? {
    if (raw.isNullOrEmpty()) {
        return null
    }
    val value = raw.trim().lowercase()
    if (value.startsWith("1.")) {
        return value.substring(2).toIntOrNull()
    }
    return value.filter { it.isDigit() }.toIntOrNull()
}

/** 识别 JUnit 版本倾向：优先 JUnit 4，便于提示迁移 */
private fun detectJunit(text: String): String? {
    val vintage = Regex("junit-vintage-engine").containsMatchIn(text)
    val junit4 = Regex("<artifactId>\\s*junit\\s*</artifactId>").containsMatchIn(text) || vintage
    if (junit4) {
        return "junit4"
    }
    if (Regex("junit-jupiter|org\\.junit\\.jupiter").containsMatchIn(text)) {
        return "junit5"
    }
    return null
}

/** 展开简单属性占位符，便于识别 ${java.version} 这类写法 */
private fun expandPlaceholders(text: String): String =
    PLACEHOLDER.replace(text) { match ->
        val name = match.groupValues[1]
        val prop = Regex("<${Regex.escape(name)}>\\s*([^<]+?)\\s*</${Regex.escape(name)}>").find(text)
        prop?.groupValues?.get(1) ?: match.value
    }

/** 解析项目根 pom，识别 Java 与 Spring Boot 版本；失败时返回空画像 */
fun detectProjectProfile(root: File): ProjectProfile {
    val pomFile = File(root, "pom.xml")
    val raw = try {
        pomFile.readText()
    } catch (e: Exception) {
        return ProjectProfile()
    }

    val text = expandPlaceholders(raw)
    val javaRaw = firstMatch(text, JAVA_PATTERNS)
    val springBootVersion = firstMatch(text, SPRING_BOOT_PATTERNS)

    return ProjectProfile(
        javaVersion = normalizeJava(javaRaw),
        springBootVersion = springBootVersion,
        junit = detectJunit(text)
    )
}

/** 根据项目画像给出配方与升级提示；低风险配方已由插件自动启用 */
fun recipeAdvice(profile: ProjectProfile): List<String> {
    val advice = mutableListOf<String>()
    val java = profile.javaVersion
    if (java != null && java >= 8) {
        advice.add(
            "低风险配方已按当前项目自动启用（等价改写），配方库内置于插件、无需配置 Maven 坐标，可在面板「设置」中调整"
        )
    }
    val parts = (profile.springBootVersion ?: "").split(".")
    val major = parts.getOrNull(0)?.trim()?.toIntOrNull()
    val minor = parts.getOrNull(1)?.trim()?.toIntOrNull()
    if (major == 2 && minor != null && minor < 7) {
        advice.add(
            "检测到 Spring Boot ${profile.springBootVersion}（已停止维护）：可在「升级依赖」中一次升级到 2.7.18，再执行代码级迁移"
        )
    } else if (major == 3) {
        advice.add("Spring Boot 3.x：可在设置里手动启用代码迁移配方（高风险，默认不勾选）")
    }
    return advice
}
