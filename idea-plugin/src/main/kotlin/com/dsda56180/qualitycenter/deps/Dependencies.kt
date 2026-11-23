package com.dsda56180.qualitycenter.deps

import com.dsda56180.qualitycenter.util.Exec
import com.dsda56180.qualitycenter.util.Maven
import java.io.File

/** dependency:tree 中的一个组件节点（同一 GA 多次出现会合并） */
data class DependencyNode(
    val packageName: String,
    var version: String,
    var direct: Boolean,
    val scope: String?,
    /** `(version managed from X)` 中声明的原始版本 */
    var managedFrom: String?,
    /** 被哪个 BOM 管理（`by groupId:artifactId:version` 形式） */
    var managedBy: String?,
    /** `(omitted for conflict with X)` 中其它分支选择的版本 */
    val conflicts: MutableList<String>,
    /** 依赖路径，形如 [root, 父 GA, ..., 当前 GA] */
    val paths: MutableList<List<String>>,
    /** 直接引用该节点的父节点 GA */
    val dependents: MutableList<String>
)

enum class BomKind(val id: String) {
    PARENT("parent"),
    BOM("bom")
}

data class BomRef(
    val groupId: String,
    val artifactId: String,
    val version: String,
    val kind: BomKind
)

data class ManagedEntry(
    /** 管理该版本的 BOM/父 POM，形如 groupId:artifactId */
    val bom: String,
    /** BOM/父 POM 自身的版本 */
    val version: String,
    val kind: BomKind
)

private val SCOPE = Regex("^(compile|runtime|provided|test|system|import)$")

private data class Coordinate(
    val groupId: String,
    val artifactId: String,
    val version: String,
    val scope: String?
)

private fun splitCoordinate(text: String): Coordinate? {
    val parts = text.trim().split(":")
    if (parts.size < 4) {
        return null
    }
    val groupId = parts[0]
    val artifactId = parts[1]
    var version = parts[parts.size - 1]
    var scope: String? = null
    if (SCOPE.matches(version) && parts.size >= 5) {
        scope = version
        version = parts[parts.size - 2]
    }
    if (groupId.isEmpty() || artifactId.isEmpty() || version.isEmpty()) {
        return null
    }
    return Coordinate(groupId, artifactId, version, scope)
}

private data class TreeLine(
    val depth: Int,
    val coordinate: String,
    val annotations: String
)

/**
 * 解析 `mvn dependency:tree -Dverbose` 的文本输出。
 * 兼容带 `[INFO]` 前缀、`-DoutputFile` 输出、以及 +-/\\- 树形连接符。
 */
fun parseDependencyTree(output: String): Map<String, DependencyNode> {
    val nodes = LinkedHashMap<String, DependencyNode>()
    val stack = mutableListOf<String>()

    fun visit(line: TreeLine) {
        val coordinate = splitCoordinate(line.coordinate) ?: return
        val packageName = "${coordinate.groupId}:${coordinate.artifactId}"
        val annotations = line.annotations
        val conflict = Regex("\\(omitted for conflict with ([^)]+)\\)").find(annotations)
        val duplicate = Regex("\\(omitted for duplicate\\)").containsMatchIn(annotations)
        val managed = Regex("\\(version managed from ([^\\s)]+)(?:\\s+by\\s+([^)]+))?\\)").find(annotations)
        val isRoot = line.depth == 0

        val parent = if (line.depth > 0) stack.getOrNull(line.depth - 1)?.takeIf { it.isNotEmpty() } else null
        val pathGAs = if (line.depth > 0) stack.take(line.depth) else emptyList()

        if (!isRoot) {
            while (stack.size > line.depth) {
                stack.removeAt(stack.size - 1)
            }
            while (stack.size < line.depth) {
                stack.add("")
            }
            stack.add(packageName)
        } else {
            stack.clear()
            stack.add(packageName)
            return
        }

        var node = nodes[packageName]
        if (node == null) {
            val created = DependencyNode(
                packageName = packageName,
                version = coordinate.version,
                direct = line.depth == 1,
                scope = coordinate.scope,
                managedFrom = null,
                managedBy = null,
                conflicts = mutableListOf(),
                paths = mutableListOf(),
                dependents = mutableListOf()
            )
            node = created
            nodes[packageName] = created
        }
        if (!duplicate) {
            node.direct = node.direct || line.depth == 1
            if (node.version.isEmpty()) {
                node.version = coordinate.version
            }
        }
        if (managed != null) {
            node.managedFrom = managed.groupValues[1]
            val by = managed.groupValues[2]
            if (by.isNotEmpty()) {
                node.managedBy = by.split(":").take(2).joinToString(":")
            }
        }
        if (conflict != null) {
            val raw = conflict.groupValues[1].trim()
            val value = raw.split(":").lastOrNull()?.takeIf { it.isNotEmpty() } ?: raw
            if (!node.conflicts.contains(value)) {
                node.conflicts.add(value)
            }
        }
        if (parent != null && !node.dependents.contains(parent)) {
            node.dependents.add(parent)
        }
        val trail = pathGAs + packageName
        val trailKey = trail.joinToString(">")
        if (node.paths.none { it.joinToString(">") == trailKey }) {
            node.paths.add(trail)
        }
    }

    for (raw in output.split(Regex("\\r?\\n"))) {
        val line = raw.replace(Regex("^\\[(INFO|WARNING|ERROR)\\]\\s?"), "").trimEnd()
        if (line.trim().isEmpty()) {
            continue
        }
        val branch = Regex("^((?:[| ]{3})*)([+\\\\-])\\s+(\\S.*)$").find(line)
        if (branch != null) {
            val tokens = branch.groupValues[3].split(Regex("\\s+"))
            visit(
                TreeLine(
                    depth = branch.groupValues[1].length / 3 + 1,
                    coordinate = tokens.first(),
                    annotations = tokens.drop(1).joinToString(" ")
                )
            )
            continue
        }
        // 根节点：没有树形连接符，但形如 groupId:artifactId:type:version
        if (Regex("^[\\w.\\-]+:[\\w.\\-]+:[\\w.\\-]+:[\\w.\\-]+").containsMatchIn(line)) {
            val tokens = line.split(Regex("\\s+"))
            visit(
                TreeLine(
                    depth = 0,
                    coordinate = tokens.first(),
                    annotations = tokens.drop(1).joinToString(" ")
                )
            )
        }
    }

    for (node in nodes.values) {
        if (node.paths.isEmpty()) {
            node.paths.add(listOf(node.packageName))
        }
    }
    return nodes
}

@Volatile
private var repositoryCache: Pair<String, File?>? = null

/** 读取 Maven 本地仓库位置（可能是自定义 settings.xml 指定的目录） */
fun localRepository(root: File): File? {
    val cached = repositoryCache
    if (cached != null && cached.first == root.path) {
        return cached.second
    }
    val home = System.getenv("USERPROFILE") ?: System.getenv("HOME") ?: System.getProperty("user.home")
    var value = File(File(home), ".m2/repository")

    val probe = Exec.run(
        "mvn",
        listOf("-B", "-q") + Maven.mirrorArgs() +
            listOf("help:evaluate", "-Dexpression=settings.localRepository", "-DforceStdout"),
        root,
        60_000
    )
    val text = probe.stdout.split(Regex("\\r?\\n"))
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .lastOrNull()
    if (probe.code == 0 && text != null && !text.contains("[ERROR]")) {
        val candidate = File(text)
        if (candidate.exists()) {
            value = candidate
        }
    }

    val result = value.takeIf { it.exists() }
    repositoryCache = root.path to result
    return result
}

private fun tagValue(block: String, tag: String): String {
    val match = Regex("<$tag>\\s*([^<]*?)\\s*</$tag>").find(block)
    return match?.groupValues?.get(1)?.trim() ?: ""
}

/** 解析 pom 的父 POM 与 dependencyManagement 中 scope=import 的 BOM */
fun parseBomRefs(pom: String): List<BomRef> {
    val refs = mutableListOf<BomRef>()
    val parent = Regex("<parent>([\\s\\S]*?)</parent>").find(pom)
    if (parent != null) {
        val body = parent.groupValues[1]
        val groupId = tagValue(body, "groupId")
        val artifactId = tagValue(body, "artifactId")
        val version = tagValue(body, "version")
        if (groupId.isNotEmpty() && artifactId.isNotEmpty() && version.isNotEmpty() && !version.contains("\${")) {
            refs.add(BomRef(groupId, artifactId, version, BomKind.PARENT))
        }
    }
    val dm = Regex("<dependencyManagement>([\\s\\S]*?)</dependencyManagement>").find(pom)
    if (dm != null) {
        for (match in Regex("<dependency>([\\s\\S]*?)</dependency>").findAll(dm.groupValues[1])) {
            val body = match.groupValues[1]
            val type = tagValue(body, "type")
            val scope = tagValue(body, "scope")
            val groupId = tagValue(body, "groupId")
            val artifactId = tagValue(body, "artifactId")
            val version = tagValue(body, "version")
            if (type == "pom" && scope == "import" && groupId.isNotEmpty() && artifactId.isNotEmpty() && version.isNotEmpty()) {
                refs.add(BomRef(groupId, artifactId, version, BomKind.BOM))
            }
        }
    }
    return refs
}

private data class RawManaged(
    val groupId: String,
    val artifactId: String,
    val version: String,
    val type: String?,
    val scope: String?
)

private data class RawParent(
    val groupId: String,
    val artifactId: String,
    val version: String
)

private data class RawPom(
    val groupId: String?,
    val artifactId: String?,
    val version: String?,
    val parent: RawParent?,
    val properties: Map<String, String>,
    val managed: List<RawManaged>
)

private class Chain {
    val properties = LinkedHashMap<String, String>()
    val managed = mutableListOf<RawManaged>()
}

private fun readPomFile(repo: File, groupId: String, artifactId: String, version: String): RawPom? {
    var dir = repo
    for (part in groupId.split(".")) {
        dir = File(dir, part)
    }
    val file = File(File(File(dir, artifactId), version), "$artifactId-$version.pom")
    if (!file.isFile) {
        return null
    }
    val text = try {
        file.readText()
    } catch (e: Exception) {
        return null
    }

    val properties = LinkedHashMap<String, String>()
    val propsBlock = Regex("<properties>([\\s\\S]*?)</properties>").find(text)
    if (propsBlock != null) {
        for (match in Regex("""<([A-Za-z_][\w.\-]*)>\s*([^<]*?)\s*</\1>""").findAll(propsBlock.groupValues[1])) {
            properties[match.groupValues[1]] = match.groupValues[2].trim()
        }
    }

    val managed = mutableListOf<RawManaged>()
    val dm = Regex("<dependencyManagement>([\\s\\S]*?)</dependencyManagement>").find(text)
    if (dm != null) {
        for (match in Regex("<dependency>([\\s\\S]*?)</dependency>").findAll(dm.groupValues[1])) {
            val body = match.groupValues[1]
            val groupIdValue = tagValue(body, "groupId")
            val artifactIdValue = tagValue(body, "artifactId")
            val versionValue = tagValue(body, "version")
            if (groupIdValue.isNotEmpty() && artifactIdValue.isNotEmpty()) {
                managed.add(
                    RawManaged(
                        groupId = groupIdValue,
                        artifactId = artifactIdValue,
                        version = versionValue,
                        type = tagValue(body, "type").ifEmpty { null },
                        scope = tagValue(body, "scope").ifEmpty { null }
                    )
                )
            }
        }
    }

    val parentBlock = Regex("<parent>([\\s\\S]*?)</parent>").find(text)
    val parent = parentBlock?.let {
        val body = it.groupValues[1]
        val groupIdValue = tagValue(body, "groupId")
        val artifactIdValue = tagValue(body, "artifactId")
        val versionValue = tagValue(body, "version")
        if (groupIdValue.isNotEmpty() && artifactIdValue.isNotEmpty() && versionValue.isNotEmpty()) {
            RawParent(groupIdValue, artifactIdValue, versionValue)
        } else {
            null
        }
    }

    return RawPom(
        groupId = tagValue(text, "groupId").ifEmpty { null },
        artifactId = tagValue(text, "artifactId").ifEmpty { null },
        version = tagValue(text, "version").ifEmpty { null },
        parent = parent,
        properties = properties,
        managed = managed
    )
}

/** 沿 parent 链收集属性与 dependencyManagement（子级优先） */
private fun collectChain(
    repo: File,
    groupId: String,
    artifactId: String,
    version: String,
    depth: Int = 0
): Chain {
    val result = Chain()
    if (depth > 4) {
        return result
    }
    val raw = readPomFile(repo, groupId, artifactId, version) ?: return result

    raw.parent?.let { parent ->
        val inherited = collectChain(repo, parent.groupId, parent.artifactId, parent.version, depth + 1)
        result.properties.putAll(inherited.properties)
        result.managed.addAll(inherited.managed)
    }
    result.properties.putAll(raw.properties)
    // 子级覆盖父级同名 GA
    for (item in raw.managed) {
        val index = result.managed.indexOfFirst { it.groupId == item.groupId && it.artifactId == item.artifactId }
        if (index >= 0) {
            result.managed[index] = item
        } else {
            result.managed.add(item)
        }
    }

    // scope=import 的 BOM 会把自己的版本继续下放（如 Spring Boot → spring-framework-bom）
    for (item in raw.managed) {
        if (item.type != "pom" || item.scope != "import" || depth >= 4) {
            continue
        }
        val resolvedVersion = resolvePlaceholders(item.version, result.properties)
        if (resolvedVersion.isEmpty() || resolvedVersion.contains("\${")) {
            continue
        }
        val nested = collectChain(repo, item.groupId, item.artifactId, resolvedVersion, depth + 1)
        for ((key, value) in nested.properties) {
            if (!result.properties.containsKey(key)) {
                result.properties[key] = value
            }
        }
        for (nestedItem in nested.managed) {
            val exists = result.managed.any {
                it.groupId == nestedItem.groupId && it.artifactId == nestedItem.artifactId
            }
            if (!exists) {
                result.managed.add(nestedItem)
            }
        }
    }
    return result
}

private fun resolvePlaceholders(
    value: String,
    properties: Map<String, String>,
    depth: Int = 0
): String {
    if (value.isEmpty() || depth > 5) {
        return value
    }
    return Regex("\\$\\{([^}]+)}").replace(value) { match ->
        val resolved = properties[match.groupValues[1]]
        if (resolved == null) match.value else resolvePlaceholders(resolved, properties, depth + 1)
    }
}

/**
 * 读取本地仓库中的父 POM / BOM，建立「GA → 由谁管理的哪个版本」索引。
 * 用于升级预览里说明版本来源，并判断哪些 CVE 可以由升级 BOM 一次解决。
 */
fun indexBomManagement(refs: List<BomRef>, repo: File): Map<String, ManagedEntry> {
    val index = LinkedHashMap<String, ManagedEntry>()
    for (ref in refs) {
        val chain = collectChain(repo, ref.groupId, ref.artifactId, ref.version)
        for (item in chain.managed) {
            val version = resolvePlaceholders(item.version, chain.properties)
            if (version.isEmpty() || version.contains("\${")) {
                continue
            }
            val packageName = "${item.groupId}:${item.artifactId}"
            if (!index.containsKey(packageName)) {
                index[packageName] = ManagedEntry(
                    bom = "${ref.groupId}:${ref.artifactId}",
                    version = ref.version,
                    kind = ref.kind
                )
            }
        }
    }
    return index
}
