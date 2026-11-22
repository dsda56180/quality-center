package com.dsda56180.qualitycenter.upgrade

import com.dsda56180.qualitycenter.deps.BomKind
import com.dsda56180.qualitycenter.deps.DependencyNode
import com.dsda56180.qualitycenter.deps.ManagedEntry
import com.dsda56180.qualitycenter.deps.parseBomRefs
import com.dsda56180.qualitycenter.model.Issue
import com.dsda56180.qualitycenter.model.IssueSource
import java.io.File

data class DirectDependency(
    val groupId: String,
    val artifactId: String,
    /** pom 中的原始写法，可能是 ${xxx} */
    val version: String,
    /** 版本由属性管理时，属性名 */
    val property: String? = null
)

/**
 * 写回 pom 的方式（遵循「版本号统一由 properties 管理」的标准设计）：
 * - parent：升级 <parent> 版本
 * - bom：升级 dependencyManagement 中导入的 BOM 版本
 * - plugin：升级 <build><plugins> 中显式声明的插件版本
 * - property：依赖写的是 ${p} 且 p 只被这一处引用，直接改属性
 * - extract：把版本抽离成独立属性（硬编码、或属性被多处共用时）
 * - manage：传递依赖，在 dependencyManagement 中新增版本覆盖（同样使用属性）
 */
enum class UpgradeMode(val id: String) {
    PARENT("parent"),
    BOM("bom"),
    PLUGIN("plugin"),
    PROPERTY("property"),
    EXTRACT("extract"),
    MANAGE("manage")
}

enum class UpgradeSourceKind(val id: String) {
    PARENT("parent"),
    BOM("bom"),
    DECLARED("declared"),
    TRANSITIVE("transitive")
}

data class UpgradeCandidate(
    val packageName: String,
    val groupId: String,
    val artifactId: String,
    val from: String,
    val to: String,
    val cveCount: Int,
    val mode: UpgradeMode,
    /** 当前版本的来源说明，直接展示在预览里 */
    val source: String,
    val sourceKind: UpgradeSourceKind,
    val property: String? = null,
    /** 本次升级会一并解决的其它依赖 */
    val affects: List<String>? = null,
    /** 版本冲突说明（其它分支选择的版本、被 BOM 管理的声明差异） */
    val conflicts: List<String>? = null,
    /** 可选目标版本，多个时预览里给用户下拉选择 */
    val alternatives: List<String>? = null,
    val note: String? = null
)

data class SkippedUpgrade(
    val packageName: String,
    val reason: String
)

data class PlanResult(
    val candidates: List<UpgradeCandidate>,
    /** 无法自动升级的包及原因，用于界面解释 */
    val skipped: List<SkippedUpgrade>
)

/** 依赖树与 BOM 索引，用于判断版本来源与联动关系 */
data class UpgradeContext(
    val nodes: Map<String, DependencyNode>? = null,
    val managed: Map<String, ManagedEntry>? = null
)

data class UpgradeChange(
    val label: String,
    val old: String,
    val updated: String
)

data class ApplyResult(
    val text: String,
    val changes: List<UpgradeChange>
)

private const val SPRING_BOOT_TARGET = "2.7.18"

private val VERSION_TAG = Regex("<version>[\\s\\S]*?</version>")
private val DEPENDENCY_BLOCK = Regex("<dependency>([\\s\\S]*?)</dependency>")

private fun tagValue(block: String, tag: String): String {
    val match = Regex("<$tag>\\s*([^<]*?)\\s*</$tag>").find(block)
    return match?.groupValues?.get(1)?.trim() ?: ""
}

/** 返回若干段的 [start, endExclusive) 区间 */
private fun tagRanges(pom: String, tag: String): List<IntRange> =
    Regex("<$tag>[\\s\\S]*?</$tag>").findAll(pom)
        .map { it.range.first until (it.range.last + 1) }
        .toList()

private fun inRanges(index: Int, ranges: List<IntRange>): Boolean =
    ranges.any { index in it }

private fun propertyName(version: String): String? =
    Regex("^\\$\\{([^}]+)}$").find(version.trim())?.groupValues?.get(1)

private fun resolveProperty(pom: String, name: String): String? {
    val escaped = Regex.escape(name)
    val match = Regex("<$escaped>\\s*([^<]*?)\\s*</$escaped>").find(pom)
    return match?.groupValues?.get(1)?.trim()
}

/** 统计属性在 pom 中的引用次数，多处引用时改动会波及其他依赖 */
private fun propertyUsages(pom: String, name: String): Int =
    pom.split("\${$name}").size - 1

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

private val versionComparator = Comparator<String> { a, b -> compareVersion(a, b) }

private fun versionPair(version: String): Pair<Int, Int> {
    val match = Regex("^(\\d+)\\.(\\d+)").find(version.trim())
    return if (match != null) {
        (match.groupValues[1].toIntOrNull() ?: 0) to (match.groupValues[2].toIntOrNull() ?: 0)
    } else {
        0 to 0
    }
}

private fun flattenVersions(values: List<String>): List<String> =
    values.flatMap { it.split(",") }
        .map { it.trim() }
        .filter { it.isNotEmpty() }

private fun uniqueVersions(values: List<String>): List<String> {
    val seen = mutableSetOf<String>()
    val result = mutableListOf<String>()
    for (value in values) {
        if (!seen.contains(value)) {
            seen.add(value)
            result.add(value)
        }
    }
    return result
}

/** Spring 生态组件：版本通常由 Spring Boot BOM 统一管理 */
private fun isSpringFamily(packageName: String): Boolean {
    val parts = packageName.split(":")
    val groupId = parts.getOrNull(0) ?: return false
    val artifactId = parts.getOrNull(1) ?: return false
    if (artifactId.isEmpty()) {
        return false
    }
    if (groupId == "org.springframework") {
        return true
    }
    return listOf(
        "spring-",
        "tomcat-embed",
        "jackson-",
        "snakeyaml",
        "logback-",
        "log4j",
        "netty-",
        "hibernate-"
    ).any { artifactId.startsWith(it) }
}

/**
 * 解析 pom 中显式声明版本的直接依赖。
 * `<dependencyManagement>` 与 `<build>` 里的依赖不参与升级：
 * 前者是 BOM 统一管版本，后者属于插件依赖。
 */
fun parseDirectDependencies(pom: String): List<DirectDependency> {
    val excluded = tagRanges(pom, "dependencyManagement") + tagRanges(pom, "build")
    val deps = mutableListOf<DirectDependency>()
    for (match in DEPENDENCY_BLOCK.findAll(pom)) {
        if (inRanges(match.range.first, excluded)) {
            continue
        }
        val body = match.groupValues[1]
        val groupId = tagValue(body, "groupId")
        val artifactId = tagValue(body, "artifactId")
        val version = tagValue(body, "version")
        if (groupId.isNotEmpty() && artifactId.isNotEmpty()) {
            deps.add(DirectDependency(groupId, artifactId, version, propertyName(version)))
        }
    }
    return deps
}

/** 选择升级目标版本：优先同一主次版本号，避免跨大版本升级带来的破坏性变更 */
private fun pickFixedVersion(installed: String, fixedValues: List<String>): String {
    val all = uniqueVersions(flattenVersions(fixedValues))
    if (all.isEmpty()) {
        return ""
    }
    val (installedMajor, installedMinor) = versionPair(installed)
    val sameLine = all.filter {
        val (major, minor) = versionPair(it)
        major == installedMajor && minor == installedMinor
    }
    if (sameLine.isNotEmpty()) {
        return sameLine.sortedWith(versionComparator).last()
    }
    val sameMajor = all.filter { versionPair(it).first == installedMajor }
    if (sameMajor.isNotEmpty()) {
        return sameMajor.sortedWith(versionComparator).last()
    }
    return all.sortedWith(versionComparator).last()
}

/** 汇总扫描结果（可选结合依赖树/BOM 索引），得出可自动升级的清单 */
fun planUpgrades(root: File, issues: List<Issue>, context: UpgradeContext = UpgradeContext()): PlanResult {
    val pomFile = File(root, "pom.xml")
    if (!pomFile.isFile) {
        return PlanResult(emptyList(), emptyList())
    }
    val pom = try {
        pomFile.readText()
    } catch (e: Exception) {
        return PlanResult(emptyList(), emptyList())
    }
    val deps = parseDirectDependencies(pom)
    val managed = context.managed
    val nodes = context.nodes

    val byPackage = LinkedHashMap<String, MutableList<Issue>>()
    for (issue in issues) {
        if (issue.source != IssueSource.TRIVY) {
            continue
        }
        val packageName = issue.packageName?.takeIf { it.isNotEmpty() } ?: continue
        byPackage.getOrPut(packageName) { mutableListOf() }.add(issue)
    }

    val candidates = mutableListOf<UpgradeCandidate>()
    val skipped = mutableListOf<SkippedUpgrade>()
    /** 已被框架层升级覆盖的依赖 → 覆盖它的候选包名 */
    val coveredBy = mutableMapOf<String, String>()

    // 1. Spring Boot 2.x 升级：一次提升整组 BOM 管理的版本，不再逐个固定
    val bootRefs = parseBomRefs(pom).filter { it.groupId == "org.springframework.boot" }
    for (ref in bootRefs) {
        val (major, minor) = versionPair(ref.version)
        if (major != 2 || minor >= 7) {
            continue
        }
        if (compareVersion(ref.version, SPRING_BOOT_TARGET) >= 0) {
            continue
        }
        val bomKey = "${ref.groupId}:${ref.artifactId}"
        // 显式写了版本的依赖不会被 BOM 升级影响，仍需单独处理
        val declaredWithVersion = deps
            .filter { it.version.isNotEmpty() }
            .map { "${it.groupId}:${it.artifactId}" }
            .toSet()
        val affected = mutableListOf<String>()
        for (packageName in byPackage.keys) {
            val entry = managed?.get(packageName)
            val fromBom = if (entry != null) entry.bom == bomKey else isSpringFamily(packageName)
            if (!fromBom || declaredWithVersion.contains(packageName)) {
                continue
            }
            affected.add(packageName)
        }
        val cveCount = affected.sumOf { byPackage[it]?.size ?: 0 }
        if (cveCount == 0) {
            continue
        }
        val mode = if (ref.kind == BomKind.PARENT) UpgradeMode.PARENT else UpgradeMode.BOM
        val sourceKind = if (ref.kind == BomKind.PARENT) UpgradeSourceKind.PARENT else UpgradeSourceKind.BOM
        candidates.add(
            UpgradeCandidate(
                packageName = bomKey,
                groupId = ref.groupId,
                artifactId = ref.artifactId,
                from = ref.version,
                to = SPRING_BOOT_TARGET,
                cveCount = cveCount,
                mode = mode,
                source = if (ref.kind == BomKind.PARENT) {
                    "项目 <parent>，Spring 生态组件版本都由它管理"
                } else {
                    "<dependencyManagement> 中 scope=import 的 BOM"
                },
                sourceKind = sourceKind,
                affects = affected,
                alternatives = listOf(SPRING_BOOT_TARGET),
                note = "升级后 spring-*、tomcat-embed-*、jackson-*、logback-* 等版本会一起对齐到 " +
                    "$SPRING_BOOT_TARGET，不再逐个固定；spring-boot-maven-plugin 的版本也随父 POM 对齐。" +
                    "代码级适配可继续执行「Spring Boot 2.7 代码迁移」（rewrite-spring）。"
            )
        )
        for (name in affected) {
            coveredBy[name] = bomKey
        }
    }

    // 2. 显式固定了 Spring Boot 插件版本时，插件也必须同步到同一版本
    val hasBootUpgrade = candidates.any {
        it.groupId == "org.springframework.boot" &&
            (it.mode == UpgradeMode.PARENT || it.mode == UpgradeMode.BOM)
    }
    if (hasBootUpgrade) {
        for (match in Regex("<plugin>([\\s\\S]*?)</plugin>").findAll(pom)) {
            val body = match.groupValues[1]
            if (
                tagValue(body, "groupId") != "org.springframework.boot" ||
                tagValue(body, "artifactId") != "spring-boot-maven-plugin"
            ) {
                continue
            }
            val version = tagValue(body, "version")
            if (version.isEmpty() || version.contains("\${") || compareVersion(version, SPRING_BOOT_TARGET) >= 0) {
                continue
            }
            candidates.add(
                UpgradeCandidate(
                    packageName = "org.springframework.boot:spring-boot-maven-plugin",
                    groupId = "org.springframework.boot",
                    artifactId = "spring-boot-maven-plugin",
                    from = version,
                    to = SPRING_BOOT_TARGET,
                    cveCount = 0,
                    mode = UpgradeMode.PLUGIN,
                    source = "<build><plugins> 中显式声明，未跟随父 POM",
                    sourceKind = UpgradeSourceKind.DECLARED,
                    alternatives = listOf(SPRING_BOOT_TARGET),
                    note = "Spring Boot $SPRING_BOOT_TARGET 对应同版本的 spring-boot-maven-plugin，避免构建期版本错配。"
                )
            )
        }
    }

    // 3. 其余依赖逐个处理
    for ((packageName, items) in byPackage) {
        if (coveredBy.containsKey(packageName)) {
            continue
        }
        val parts = packageName.split(":")
        val groupId = parts.getOrNull(0)
        val artifactId = parts.getOrNull(1)
        if (groupId.isNullOrEmpty() || artifactId.isNullOrEmpty()) {
            continue
        }
        val node = nodes?.get(packageName)
        val installed = node?.version?.takeIf { it.isNotEmpty() }
            ?: items.firstOrNull { !it.installedVersion.isNullOrEmpty() }?.installedVersion
            ?: ""
        val dep = deps.firstOrNull { "${it.groupId}:${it.artifactId}" == packageName }
        val managedEntry = managed?.get(packageName)

        var from = ""
        var mode = UpgradeMode.MANAGE
        var property: String? = null
        var source = ""
        var sourceKind = UpgradeSourceKind.TRANSITIVE
        var note: String? = null

        if (dep != null && dep.version.isNotEmpty()) {
            sourceKind = UpgradeSourceKind.DECLARED
            val depProperty = dep.property
            if (depProperty != null) {
                val resolved = resolveProperty(pom, depProperty)
                if (resolved == null) {
                    skipped.add(SkippedUpgrade(packageName, "pom 中未找到版本属性 ${dep.version}"))
                    continue
                }
                from = resolved
                property = depProperty
                mode = if (propertyUsages(pom, depProperty) == 1) UpgradeMode.PROPERTY else UpgradeMode.EXTRACT
            } else {
                from = dep.version.trim()
                mode = UpgradeMode.EXTRACT
            }
            source = if (managedEntry != null) {
                "pom 直接声明 $from；${managedEntry.bom} ${managedEntry.version} 也管理该版本"
            } else {
                "pom 直接声明"
            }
            if (installed.isNotEmpty() && from != installed) {
                note = "pom 声明 $from，依赖树实际解析为 $installed（可能有更近的版本覆盖）"
                from = installed
            }
        } else if (dep != null) {
            sourceKind = UpgradeSourceKind.DECLARED
            from = installed
            mode = UpgradeMode.EXTRACT
            source = if (managedEntry != null) {
                "由 ${managedEntry.bom} ${managedEntry.version} 管理"
            } else {
                "未声明版本（由父 POM 或 BOM 管理）"
            }
            note = "该依赖由 BOM 统一管理，单独固定版本可能与同源组件不一致；建议优先升级 BOM。"
        } else {
            sourceKind = UpgradeSourceKind.TRANSITIVE
            from = installed
            mode = UpgradeMode.MANAGE
            source = if (managedEntry != null) {
                "传递依赖，由 ${managedEntry.bom} ${managedEntry.version} 管理"
            } else {
                "传递依赖（未在 pom 中声明）"
            }
        }

        if (from.isEmpty()) {
            skipped.add(SkippedUpgrade(packageName, "无法确定当前解析版本，需手动确认"))
            continue
        }

        val to = pickFixedVersion(from, flattenVersions(items.map { it.fixedVersion ?: "" }))
        if (to.isEmpty() || to == from) {
            skipped.add(SkippedUpgrade(packageName, "没有可用的同版本线修复版本，跨大版本升级需人工评估"))
            continue
        }

        val alternatives = uniqueVersions(
            listOf(to) + flattenVersions(items.map { it.fixedVersion ?: "" })
        )
            .sortedWith(versionComparator)
            .reversed()
            .take(6)

        val conflicts = mutableListOf<String>()
        if (node != null) {
            for (value in node.conflicts) {
                conflicts.add("其它分支选择了 $value，升级后需要一并确认")
            }
            if (node.managedFrom != null && node.managedFrom != node.version) {
                conflicts.add("依赖树中被 ${node.managedBy ?: "BOM"} 从 ${node.managedFrom} 调整为 ${node.version}")
            }
            if (node.paths.size > 1) {
                val trail = node.paths.first().joinToString(" → ")
                conflicts.add("在 ${node.paths.size} 条依赖路径中出现（例如 $trail）")
            }
        }

        candidates.add(
            UpgradeCandidate(
                packageName = packageName,
                groupId = groupId,
                artifactId = artifactId,
                from = from,
                to = to,
                cveCount = items.size,
                mode = mode,
                source = source,
                sourceKind = sourceKind,
                property = property,
                conflicts = if (conflicts.isEmpty()) null else conflicts,
                alternatives = alternatives,
                note = note
            )
        )
    }

    val order = mapOf(
        UpgradeMode.PARENT to 0,
        UpgradeMode.BOM to 0,
        UpgradeMode.PLUGIN to 1,
        UpgradeMode.EXTRACT to 2,
        UpgradeMode.PROPERTY to 2,
        UpgradeMode.MANAGE to 3
    )
    val sorted = candidates.sortedWith(
        compareBy<UpgradeCandidate> { order[it.mode] ?: 3 }.thenByDescending { it.cveCount }
    )
    return PlanResult(sorted, skipped)
}

/** 在依赖块内插入版本标签，保持原有缩进 */
private fun insertVersion(body: String, version: String): String {
    val indent = Regex("\\n([ \\t]*)<artifactId>").find(body)?.groupValues?.get(1) ?: "      "
    val trailing = body.takeLastWhile { it.isWhitespace() }
    val content = body.dropLast(trailing.length)
    return "$content\n$indent<version>$version</version>$trailing"
}

/** 依赖块中的版本表达式：已有 <version> 则替换，没有则补一行 */
private fun withVersion(body: String, expression: String): String =
    if (VERSION_TAG.containsMatchIn(body)) {
        VERSION_TAG.replaceFirst(body, Regex.escapeReplacement("<version>$expression</version>"))
    } else {
        insertVersion(body, expression)
    }

private data class LocatedBlock(
    val start: Int,
    val end: Int,
    val body: String
)

/** 定位普通 <dependencies> 中的直接依赖块 */
private fun locateDirectDependency(pom: String, groupId: String, artifactId: String): LocatedBlock? {
    val excluded = tagRanges(pom, "dependencyManagement") + tagRanges(pom, "build")
    for (match in DEPENDENCY_BLOCK.findAll(pom)) {
        if (inRanges(match.range.first, excluded)) {
            continue
        }
        val body = match.groupValues[1]
        if (tagValue(body, "groupId") == groupId && tagValue(body, "artifactId") == artifactId) {
            return LocatedBlock(match.range.first, match.range.last + 1, body)
        }
    }
    return null
}

/** 选择依赖专属的版本属性名，避免与已有属性冲突 */
private fun pickPropertyName(pom: String, candidate: UpgradeCandidate): String {
    val base = candidate.artifactId.replace(Regex("[^A-Za-z0-9_.-]"), "")
    val groupTail = (candidate.groupId.split(".").lastOrNull() ?: "dep")
        .replace(Regex("[^A-Za-z0-9_.-]"), "")
    val options = listOf(
        "$base.version",
        "$groupTail.$base.version",
        "${candidate.groupId}.$base.version"
    )
    for (name in options) {
        if (!Regex("<${Regex.escape(name)}>").containsMatchIn(pom)) {
            return name
        }
    }
    return options.last()
}

private data class PropertyEdit(
    val text: String,
    val old: String,
    val updated: String
)

/** 更新或新增版本属性 */
private fun setProperty(pom: String, name: String, value: String): PropertyEdit? {
    val tag = "<$name>$value</$name>"
    val escaped = Regex.escape(name)
    val pattern = Regex("<$escaped>\\s*[^<]*?\\s*</$escaped>")
    val match = pattern.find(pom)
    if (match != null) {
        return PropertyEdit(
            text = pom.substring(0, match.range.first) + tag + pom.substring(match.range.last + 1),
            old = match.value,
            updated = tag
        )
    }

    val props = tagRanges(pom, "properties").firstOrNull()
    if (props != null) {
        val propsStart = props.first
        val propsEnd = props.last + 1
        val closeIdx = propsEnd - "</properties>".length
        val lineStart = pom.lastIndexOf('\n', closeIdx) + 1
        val closeIndent = pom.substring(lineStart, closeIdx)
        val childIndent = Regex("\\n([ \\t]*)<[A-Za-z_]")
            .find(pom.substring(propsStart, propsEnd))
            ?.groupValues
            ?.get(1)
        val line = "${childIndent ?: (closeIndent + "  ")}$tag"
        val text = pom.substring(0, lineStart) + line + "\n" + pom.substring(lineStart)
        return PropertyEdit(text, "", line.trim())
    }

    val at = tagRanges(pom, "parent").firstOrNull()?.let { it.last + 1 }
        ?: tagRanges(pom, "modelVersion").firstOrNull()?.let { it.last + 1 }
        ?: -1
    if (at < 0) {
        return null
    }
    val block = "\n  <properties>\n    $tag\n  </properties>"
    return PropertyEdit(pom.substring(0, at) + block + pom.substring(at), "", tag)
}

/** 升级 <parent>、BOM 或插件块里的版本 */
private fun replaceBlockVersion(
    pom: String,
    kind: UpgradeMode,
    candidate: UpgradeCandidate,
    to: String
): ApplyResult? {
    if (kind == UpgradeMode.BOM) {
        for (dmRange in tagRanges(pom, "dependencyManagement")) {
            val section = pom.substring(dmRange.first, dmRange.last + 1)
            for (match in DEPENDENCY_BLOCK.findAll(section)) {
                val body = match.groupValues[1]
                if (
                    tagValue(body, "groupId") != candidate.groupId ||
                    tagValue(body, "artifactId") != candidate.artifactId
                ) {
                    continue
                }
                val oldTag = VERSION_TAG.find(body)?.value ?: return null
                val at = dmRange.first + match.range.first
                return ApplyResult(
                    text = pom.substring(0, at) +
                        "<dependency>${withVersion(body, to)}</dependency>" +
                        pom.substring(at + match.value.length),
                    changes = listOf(UpgradeChange("BOM 版本", oldTag, "<version>$to</version>"))
                )
            }
        }
        return null
    }

    val tag = if (kind == UpgradeMode.PARENT) "parent" else "plugin"
    for (range in tagRanges(pom, tag)) {
        val body = pom.substring(range.first + tag.length + 2, range.last - tag.length - 2)
        if (
            tagValue(body, "groupId") != candidate.groupId ||
            tagValue(body, "artifactId") != candidate.artifactId
        ) {
            continue
        }
        val oldTag = VERSION_TAG.find(body)?.value ?: continue
        return ApplyResult(
            text = pom.substring(0, range.first) +
                "<$tag>${withVersion(body, to)}</$tag>" +
                pom.substring(range.last + 1),
            changes = listOf(
                UpgradeChange(
                    if (kind == UpgradeMode.PARENT) "父 POM 版本" else "插件版本",
                    oldTag,
                    "<version>$to</version>"
                )
            )
        )
    }
    return null
}

/** 把依赖版本抽离到 <properties>，依赖块改为引用属性 */
private fun extractVersion(pom: String, candidate: UpgradeCandidate, to: String): ApplyResult? {
    val located = locateDirectDependency(pom, candidate.groupId, candidate.artifactId) ?: return null
    val property = pickPropertyName(pom, candidate)
    val expression = "\${$property}"
    val oldTag = VERSION_TAG.find(located.body)?.value ?: ""
    val next = pom.substring(0, located.start) +
        "<dependency>${withVersion(located.body, expression)}</dependency>" +
        pom.substring(located.end)
    val propertyResult = setProperty(next, property, to) ?: return null
    return ApplyResult(
        text = propertyResult.text,
        changes = listOf(
            UpgradeChange("properties", propertyResult.old, propertyResult.updated),
            UpgradeChange(
                "${candidate.groupId}:${candidate.artifactId}",
                oldTag,
                "<version>$expression</version>"
            )
        )
    )
}

/** 在 dependencyManagement 中覆盖版本，必要时新建该区块；版本同样抽离到 properties */
private fun manageDependency(pom: String, candidate: UpgradeCandidate, to: String): ApplyResult? {
    val property = pickPropertyName(pom, candidate)
    val expression = "\${$property}"
    var text = pom
    var oldTag = ""

    val dmRange = tagRanges(pom, "dependencyManagement").firstOrNull()
    if (dmRange != null) {
        val start = dmRange.first
        val section = pom.substring(start)
        var handled = false
        for (match in DEPENDENCY_BLOCK.findAll(section)) {
            val body = match.groupValues[1]
            if (
                tagValue(body, "groupId") != candidate.groupId ||
                tagValue(body, "artifactId") != candidate.artifactId
            ) {
                continue
            }
            oldTag = VERSION_TAG.find(body)?.value ?: ""
            val at = start + match.range.first
            text = pom.substring(0, at) +
                "<dependency>${withVersion(body, expression)}</dependency>" +
                pom.substring(at + match.value.length)
            handled = true
            break
        }
        if (!handled) {
            val dmEnd = dmRange.last + 1
            val close = pom.lastIndexOf("</dependencies>", minOf(dmEnd, pom.length - 1))
            if (close < 0 || close < dmRange.first) {
                return null
            }
            val lineStart = pom.lastIndexOf('\n', close) + 1
            val closeIndent = pom.substring(lineStart, close)
            val dmSection = pom.substring(dmRange.first, dmEnd)
            val depIndent = Regex("\\n([ \\t]*)<dependency>")
                .find(dmSection)
                ?.groupValues
                ?.get(1)
                ?: (closeIndent + "  ")
            val innerIndent = depIndent + "    "
            val entry = "$depIndent<dependency>\n" +
                "$innerIndent<groupId>${candidate.groupId}</groupId>\n" +
                "$innerIndent<artifactId>${candidate.artifactId}</artifactId>\n" +
                "$innerIndent<version>$expression</version>\n" +
                "$depIndent</dependency>\n"
            text = pom.substring(0, lineStart) + entry + pom.substring(lineStart)
        }
    } else {
        val buildRanges = tagRanges(pom, "build")
        var at = -1
        for (match in Regex("<dependencies>").findAll(pom)) {
            if (!inRanges(match.range.first, buildRanges)) {
                at = match.range.first
                break
            }
        }
        if (at < 0) {
            at = pom.lastIndexOf("</project>")
            if (at < 0) {
                return null
            }
        }
        val indent = pom.substring(0, at).takeLastWhile { it == ' ' || it == '\t' }
        val block = "<dependencyManagement>\n" +
            "${indent}  <dependencies>\n" +
            "${indent}    <dependency>\n" +
            "${indent}      <groupId>${candidate.groupId}</groupId>\n" +
            "${indent}      <artifactId>${candidate.artifactId}</artifactId>\n" +
            "${indent}      <version>$expression</version>\n" +
            "${indent}    </dependency>\n" +
            "${indent}  </dependencies>\n" +
            "${indent}</dependencyManagement>\n\n${indent}"
        text = pom.substring(0, at) + block + pom.substring(at)
    }

    val propertyResult = setProperty(text, property, to) ?: return null
    return ApplyResult(
        text = propertyResult.text,
        changes = listOf(
            UpgradeChange("properties", propertyResult.old, propertyResult.updated),
            UpgradeChange(
                "dependencyManagement · ${candidate.packageName}",
                oldTag,
                "<version>$expression</version>"
            )
        )
    )
}

/**
 * 把候选依赖的版本写回 pom，返回新文本与逐条改动（供预览展示）。
 * 定位不到目标依赖或版本已被改动时返回 null，避免误改。
 */
fun applyUpgrade(pom: String, candidate: UpgradeCandidate, version: String? = null): ApplyResult? {
    val to = version ?: candidate.to
    if (to == candidate.from) {
        return null
    }
    return when (candidate.mode) {
        UpgradeMode.PARENT, UpgradeMode.BOM, UpgradeMode.PLUGIN ->
            replaceBlockVersion(pom, candidate.mode, candidate, to)

        UpgradeMode.PROPERTY -> {
            val property = candidate.property
            if (property == null || propertyUsages(pom, property) != 1) {
                null
            } else {
                val result = setProperty(pom, property, to) ?: return null
                ApplyResult(result.text, listOf(UpgradeChange("properties", result.old, result.updated)))
            }
        }

        UpgradeMode.EXTRACT -> extractVersion(pom, candidate, to)
        UpgradeMode.MANAGE -> manageDependency(pom, candidate, to)
    }
}
