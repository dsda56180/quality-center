package com.dsda56180.qualitycenter.recipes

import com.dsda56180.qualitycenter.project.ProjectProfile

enum class RecipeRisk(val id: String, val label: String) {
    LOW("low", "低风险"),
    MEDIUM("medium", "中风险"),
    HIGH("high", "高风险")
}

/**
 * 配方的适用条件，全部为普通数据，便于随快照下发给界面做项目级过滤。
 * 未声明的条件视为不限制；声明了条件但项目画像缺失时按「不适用」处理。
 */
data class RecipeCondition(
    /** 仅当 Java 版本 >= 该值 */
    val javaMin: Int? = null,
    /** 仅当 Java 版本 <= 该值 */
    val javaMax: Int? = null,
    /** 仅当 Spring Boot 为该主版本 */
    val springBootMajor: Int? = null,
    /** 仅当 Spring Boot 版本低于该值（如 2.7） */
    val springBootBelow: String? = null,
    /** 仅当项目直接使用 JUnit 4 */
    val junit4: Boolean? = null
)

data class RecipeDefinition(
    /** OpenRewrite 配方全名 */
    val id: String,
    val label: String,
    val risk: RecipeRisk,
    val description: String,
    /** 配方所在包；插件会在运行时通过 -Drewrite.recipeArtifactCoordinates 临时引入 */
    val artifact: String? = null,
    /** 该配方要求的最低 rewrite-maven-plugin 版本 */
    val pluginVersion: String? = null,
    /** 项目满足条件时才在设置里展示 */
    val appliesTo: RecipeCondition? = null,
    /** 来自 discover 动态发现，而非内置精选清单 */
    val discovered: Boolean = false
)

data class DiscoveredRecipe(
    val id: String,
    /** OpenRewrite 官方 displayName（英文） */
    val displayName: String? = null,
    /** OpenRewrite 官方 description（英文） */
    val description: String? = null
)

private const val STATIC_ANALYSIS = "org.openrewrite.recipe:rewrite-static-analysis:2.1.0"
private const val REWRITE_SPRING = "org.openrewrite.recipe:rewrite-spring:6.0.2"
private const val MIGRATE_JAVA = "org.openrewrite.recipe:rewrite-migrate-java:3.1.0"
private const val TESTING_FRAMEWORKS = "org.openrewrite.recipe:rewrite-testing-frameworks:3.1.0"

/** 以上配方包都基于 rewrite 8.44.1，对应插件 6.0.5，混用不会出现类路径冲突 */
private const val PLUGIN_FOR_LIBRARY = "6.0.5"

/** discover 时加载的配方包；也是配方库覆盖的官方包范围 */
val DEFAULT_RECIPE_ARTIFACTS: List<String> = listOf(
    STATIC_ANALYSIS,
    REWRITE_SPRING,
    MIGRATE_JAVA,
    TESTING_FRAMEWORKS
)

/** 配方库统一使用的插件版本 */
const val RECIPE_PLUGIN_VERSION: String = "6.0.5"

val RISK_LABEL: Map<RecipeRisk, String> = RecipeRisk.entries.associateWith { it.label }

/**
 * 插件内置配方库。
 * 配方会按项目画像过滤：例如 Spring Boot 迁移只在检测到对应版本时出现，
 * Java 升级只在当前 Java 版本低于目标时出现，JUnit 迁移只在用 JUnit 4 时出现。
 */
val RECIPE_LIBRARY: List<RecipeDefinition> = listOf(
    RecipeDefinition(
        id = "org.openrewrite.java.RemoveUnusedImports",
        label = "清理无用导入",
        risk = RecipeRisk.LOW,
        description = "删除未被引用的 import，不改变运行行为"
    ),
    RecipeDefinition(
        id = "org.openrewrite.java.RemoveObjectsIsNull",
        label = "Objects.isNull 改为 == null",
        risk = RecipeRisk.LOW,
        description = "等价改写，便于阅读，不改变语义"
    ),
    RecipeDefinition(
        id = "org.openrewrite.java.ShortenFullyQualifiedTypeReferences",
        label = "缩短全限定类名",
        risk = RecipeRisk.LOW,
        description = "把已 import 的全限定类名替换为简单类名"
    ),
    RecipeDefinition(
        id = "org.openrewrite.java.OrderImports",
        label = "整理 import 顺序",
        risk = RecipeRisk.LOW,
        description = "按统一顺序排列 import，纯格式改动"
    ),
    RecipeDefinition(
        id = "org.openrewrite.staticanalysis.SimplifyBooleanExpression",
        label = "简化布尔表达式",
        risk = RecipeRisk.LOW,
        description = "合并冗余的布尔判断，等价改写",
        artifact = STATIC_ANALYSIS,
        pluginVersion = PLUGIN_FOR_LIBRARY
    ),
    RecipeDefinition(
        id = "org.openrewrite.staticanalysis.UnnecessaryParentheses",
        label = "去除多余括号",
        risk = RecipeRisk.LOW,
        description = "删除不影响优先级的括号，等价改写",
        artifact = STATIC_ANALYSIS,
        pluginVersion = PLUGIN_FOR_LIBRARY
    ),
    RecipeDefinition(
        id = "org.openrewrite.staticanalysis.RemoveExtraSemicolons",
        label = "去除多余分号",
        risk = RecipeRisk.LOW,
        description = "删除空语句分号，等价改写",
        artifact = STATIC_ANALYSIS,
        pluginVersion = PLUGIN_FOR_LIBRARY
    ),
    RecipeDefinition(
        id = "org.openrewrite.staticanalysis.UseDiamondOperator",
        label = "使用菱形泛型",
        risk = RecipeRisk.LOW,
        description = "把重复的泛型参数简化为 <>，等价改写",
        artifact = STATIC_ANALYSIS,
        pluginVersion = PLUGIN_FOR_LIBRARY
    ),
    RecipeDefinition(
        id = "org.openrewrite.java.format.AutoFormat",
        label = "统一代码格式",
        risk = RecipeRisk.MEDIUM,
        description = "按项目或默认风格重排缩进、空格与换行，只改格式"
    ),
    RecipeDefinition(
        id = "org.openrewrite.staticanalysis.EqualsAvoidsNull",
        label = "equals 常量左置",
        risk = RecipeRisk.MEDIUM,
        description = "把字面量放到 equals 左侧，避免潜在空指针",
        artifact = STATIC_ANALYSIS,
        pluginVersion = PLUGIN_FOR_LIBRARY
    ),
    RecipeDefinition(
        id = "org.openrewrite.staticanalysis.SimplifyBooleanReturn",
        label = "简化布尔返回",
        risk = RecipeRisk.MEDIUM,
        description = "把 if-return true/false 改写为直接返回条件",
        artifact = STATIC_ANALYSIS,
        pluginVersion = PLUGIN_FOR_LIBRARY
    ),
    RecipeDefinition(
        id = "org.openrewrite.staticanalysis.ReplaceLambdaWithMethodReference",
        label = "Lambda 改为方法引用",
        risk = RecipeRisk.MEDIUM,
        description = "把可直接引用的 Lambda 改写为方法引用",
        artifact = STATIC_ANALYSIS,
        pluginVersion = PLUGIN_FOR_LIBRARY
    ),
    RecipeDefinition(
        id = "org.openrewrite.staticanalysis.UseStandardCharset",
        label = "使用 StandardCharsets",
        risk = RecipeRisk.MEDIUM,
        description = "用 StandardCharsets 常量替换按名称获取字符集",
        artifact = STATIC_ANALYSIS,
        pluginVersion = PLUGIN_FOR_LIBRARY
    ),
    RecipeDefinition(
        id = "org.openrewrite.staticanalysis.SimplifyConstantIfBranchExecution",
        label = "简化常量条件分支",
        risk = RecipeRisk.MEDIUM,
        description = "折叠条件恒定的 if 分支，减少无效代码",
        artifact = STATIC_ANALYSIS,
        pluginVersion = PLUGIN_FOR_LIBRARY
    ),
    RecipeDefinition(
        id = "org.openrewrite.java.spring.boot2.UpgradeSpringBoot_2_7",
        label = "Spring Boot 2.7 代码迁移",
        risk = RecipeRisk.HIGH,
        description = "升级到 Spring Boot 2.7 所需的配置与 API 适配，会产生业务代码改动",
        artifact = REWRITE_SPRING,
        pluginVersion = PLUGIN_FOR_LIBRARY,
        appliesTo = RecipeCondition(springBootMajor = 2, springBootBelow = "2.7")
    ),
    RecipeDefinition(
        id = "org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_0",
        label = "Spring Boot 3.0 代码迁移",
        risk = RecipeRisk.HIGH,
        description = "升级到 Spring Boot 3.x：javax→jakarta、配置项与 API 适配，需 Java 17",
        artifact = REWRITE_SPRING,
        pluginVersion = PLUGIN_FOR_LIBRARY,
        appliesTo = RecipeCondition(springBootMajor = 2, javaMin = 17)
    ),
    RecipeDefinition(
        id = "org.openrewrite.java.migrate.Java8toJava11",
        label = "Java 8 → 11 迁移",
        risk = RecipeRisk.HIGH,
        description = "升级编译目标与移除的 JDK API，同时更新构建配置",
        artifact = MIGRATE_JAVA,
        pluginVersion = PLUGIN_FOR_LIBRARY,
        appliesTo = RecipeCondition(javaMax = 8)
    ),
    RecipeDefinition(
        id = "org.openrewrite.java.migrate.UpgradeToJava17",
        label = "升级代码到 Java 17",
        risk = RecipeRisk.HIGH,
        description = "升级编译目标并适配 Java 17 的 API 与语言变化",
        artifact = MIGRATE_JAVA,
        pluginVersion = PLUGIN_FOR_LIBRARY,
        appliesTo = RecipeCondition(javaMin = 11, javaMax = 16)
    ),
    RecipeDefinition(
        id = "org.openrewrite.java.testing.junit5.JUnit4to5Migration",
        label = "JUnit 4 → JUnit 5 迁移",
        risk = RecipeRisk.HIGH,
        description = "重写注解、断言与测试运行器，改为 JUnit 5",
        artifact = TESTING_FRAMEWORKS,
        pluginVersion = PLUGIN_FOR_LIBRARY,
        appliesTo = RecipeCondition(junit4 = true)
    )
)

private fun compareVersion(a: String, b: String): Int {
    val pa = a.split(Regex("[.\\-]")).map { it.toIntOrNull() ?: 0 }
    val pb = b.split(Regex("[.\\-]")).map { it.toIntOrNull() ?: 0 }
    for (i in 0 until maxOf(pa.size, pb.size)) {
        val diff = (pa.getOrNull(i) ?: 0) - (pb.getOrNull(i) ?: 0)
        if (diff != 0) {
            return diff
        }
    }
    return 0
}

/** 判断配方是否适用于当前项目；画像缺失时，带条件的配方不展示 */
fun recipeApplies(recipe: RecipeDefinition, profile: ProjectProfile): Boolean {
    val condition = recipe.appliesTo ?: return true
    val java = profile.javaVersion
    condition.javaMin?.let { min ->
        if (java == null || java < min) {
            return false
        }
    }
    condition.javaMax?.let { max ->
        if (java == null || java > max) {
            return false
        }
    }
    val boot = profile.springBootVersion
    condition.springBootMajor?.let { major ->
        if (boot == null || boot.split(".")[0].toIntOrNull() != major) {
            return false
        }
    }
    condition.springBootBelow?.let { below ->
        if (boot == null || compareVersion(boot, below) >= 0) {
            return false
        }
    }
    if (condition.junit4 == true && profile.junit != "junit4") {
        return false
    }
    return true
}

/** 当前项目可用的配方 */
fun applicableRecipes(profile: ProjectProfile): List<RecipeDefinition> =
    RECIPE_LIBRARY.filter { recipeApplies(it, profile) }

/** 自动启用的低风险配方（按项目过滤后） */
fun autoRecipeIds(profile: ProjectProfile): List<String> =
    applicableRecipes(profile)
        .filter { it.risk == RecipeRisk.LOW }
        .map { it.id }

fun recipeDefinition(id: String): RecipeDefinition? =
    RECIPE_LIBRARY.firstOrNull { it.id == id }

fun recipeLabel(id: String): String = recipeDefinition(id)?.label ?: id

/** 选中的配方里要求最高的 rewrite-maven-plugin 版本，保证配方可加载 */
fun requiredPluginVersion(recipeIds: List<String>): String? {
    var required: String? = null
    for (id in recipeIds) {
        val version = recipeDefinition(id)?.pluginVersion
            ?: (if (artifactForRecipeId(id) != null) RECIPE_PLUGIN_VERSION else null)
        if (version == null) {
            continue
        }
        val current = required
        if (current == null || compareVersion(version, current) > 0) {
            required = version
        }
    }
    return required
}

/** 选中配方所需的额外配方包坐标（去重，按配方库顺序） */
fun artifactsForRecipes(recipeIds: List<String>): List<String> {
    val artifacts = mutableListOf<String>()
    for (id in recipeIds) {
        val artifact = recipeDefinition(id)?.artifact ?: artifactForRecipeId(id)
        if (artifact != null && artifact !in artifacts) {
            artifacts.add(artifact)
        }
    }
    return artifacts
}

/** 按配方包名前缀判断它来自哪个官方配方包；核心配方返回 null */
fun artifactForRecipeId(id: String): String? {
    if (id.startsWith("org.openrewrite.staticanalysis.") || id.startsWith("org.openrewrite.analysis.")) {
        return STATIC_ANALYSIS
    }
    if (id.startsWith("org.openrewrite.java.spring.")) {
        return REWRITE_SPRING
    }
    if (id.startsWith("org.openrewrite.java.migrate.")) {
        return MIGRATE_JAVA
    }
    if (id.startsWith("org.openrewrite.java.testing.")) {
        return TESTING_FRAMEWORKS
    }
    return null
}

private val RECIPE_ID = Regex("^org\\.openrewrite\\.[\\w.\\$]+$")

/**
 * 解析 `rewrite-maven-plugin:discover` 的输出。
 * 带 -Ddetail=true 时会得到「显示名 / id / 描述 / options」，不带时只有 id 列表。
 */
fun parseDiscoverOutput(output: String): List<DiscoveredRecipe> {
    val lines = mutableListOf<String>()
    var collecting = false
    for (raw in output.split(Regex("\\r?\\n"))) {
        val line = raw.replace(Regex("^\\[INFO\\]\\s?"), "").trimEnd()
        if (Regex("Available Recipes:", RegexOption.IGNORE_CASE).containsMatchIn(line)) {
            collecting = true
            continue
        }
        if (!collecting) {
            continue
        }
        val trimmed = line.trim()
        if (
            Regex("^Found \\d+ available recipes", RegexOption.IGNORE_CASE).containsMatchIn(trimmed) ||
            Regex("^---").containsMatchIn(trimmed) ||
            Regex("^BUILD ").containsMatchIn(trimmed)
        ) {
            break
        }
        lines.add(trimmed)
    }

    val items = mutableListOf<DiscoveredRecipe>()
    val seen = mutableSetOf<String>()
    for (index in lines.indices) {
        val line = lines[index]
        if (!RECIPE_ID.matches(line) || seen.contains(line)) {
            continue
        }
        seen.add(line)
        val previous = lines.getOrNull(index - 1) ?: ""
        val next = lines.getOrNull(index + 1) ?: ""
        items.add(
            DiscoveredRecipe(
                id = line,
                displayName = if (isMeta(previous)) null else previous,
                description = if (isMeta(next)) null else next
            )
        )
    }
    return items
}

private fun isMeta(value: String): Boolean =
    value.isEmpty() ||
        RECIPE_ID.matches(value) ||
        Regex("^options:").containsMatchIn(value) ||
        Regex(":\\s+\\S").containsMatchIn(value) ||
        Regex("^Available Recipes:").containsMatchIn(value)

private val HIGH_RISK_DISCOVERED = Regex(
    "(\\.migrate\\.|UpgradeSpringBoot|\\.boot3\\.|\\.testing\\.|(^|\\.)junit|mockito|DeleteSourceFiles|" +
        "RemoveSourceFiles|ChangeType|ChangePackage|AddManagedDependency|UpgradeDependencyVersion|" +
        "RemoveDependency|AddDependency|AddCommentToMethod|ReplaceMethod)",
    RegexOption.IGNORE_CASE
)

/** 对 discover 出来的配方做启发式分级：迁移/测试/删除类为高风险，其余为需要确认的中风险 */
private fun inferRisk(id: String): RecipeRisk =
    if (HIGH_RISK_DISCOVERED.containsMatchIn(id)) RecipeRisk.HIGH else RecipeRisk.MEDIUM

/**
 * 把 discover 得到的配方转成可展示的配方定义。
 * 显示名与描述来自 OpenRewrite 官方 descriptor，风险等级按 id 启发式判断。
 */
fun classifyDiscoveredRecipes(items: List<DiscoveredRecipe>): List<RecipeDefinition> {
    val known = RECIPE_LIBRARY.map { it.id }.toSet()
    return items
        .filter { !known.contains(it.id) && it.id.contains(".") }
        .map { item ->
            val artifact = artifactForRecipeId(item.id)
            RecipeDefinition(
                id = item.id,
                label = item.displayName?.takeIf { it.isNotBlank() }
                    ?: item.id.split(".").lastOrNull()
                    ?: item.id,
                risk = inferRisk(item.id),
                description = item.description?.takeIf { it.isNotBlank() }
                    ?.let { "$it（OpenRewrite 官方描述）" }
                    ?: "OpenRewrite 官方配方；未内置中文说明与适用条件，应用前请先预览 diff",
                artifact = artifact,
                pluginVersion = if (artifact != null) PLUGIN_FOR_LIBRARY else null,
                discovered = true
            )
        }
}

/** 精选清单 + discover 结果，按 id 去重 */
fun mergeRecipeLibrary(discovered: List<RecipeDefinition>): List<RecipeDefinition> {
    val seen = RECIPE_LIBRARY.map { it.id }.toSet()
    return RECIPE_LIBRARY + discovered.filter { !seen.contains(it.id) }
}
