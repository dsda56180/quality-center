import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run } from './exec';
import { mavenMirrorArgs } from './maven';

/** dependency:tree 中的一个组件节点（同一 GA 多次出现会合并） */
export interface DependencyNode {
  packageName: string;
  version: string;
  direct: boolean;
  scope?: string;
  /** `(version managed from X)` 中声明的原始版本 */
  managedFrom?: string;
  /** 被哪个 BOM 管理（`by groupId:artifactId:version` 形式） */
  managedBy?: string;
  /** `(omitted for conflict with X)` 中其它分支选择的版本 */
  conflicts: string[];
  /** 依赖路径，形如 [root, 父 GA, ..., 当前 GA] */
  paths: string[][];
  /** 直接引用该节点的父节点 GA */
  dependents: string[];
}

export interface BomRef {
  groupId: string;
  artifactId: string;
  version: string;
  kind: 'parent' | 'bom';
}

export interface ManagedEntry {
  /** 管理该版本的 BOM/父 POM，形如 groupId:artifactId */
  bom: string;
  /** BOM/父 POM 自身的版本 */
  version: string;
  kind: 'parent' | 'bom';
}

const SCOPE = /^(compile|runtime|provided|test|system|import)$/;

function splitCoordinate(text: string): {
  groupId: string;
  artifactId: string;
  version: string;
  scope?: string;
} | undefined {
  const parts = text.trim().split(':');
  if (parts.length < 4) {
    return undefined;
  }
  const groupId = parts[0];
  const artifactId = parts[1];
  let version = parts[parts.length - 1];
  let scope: string | undefined;
  if (SCOPE.test(version) && parts.length >= 5) {
    scope = version;
    version = parts[parts.length - 2];
  }
  if (!groupId || !artifactId || !version) {
    return undefined;
  }
  return { groupId, artifactId, version, scope };
}

interface TreeLine {
  depth: number;
  coordinate: string;
  annotations: string;
}

/**
 * 解析 `mvn dependency:tree -Dverbose` 的文本输出。
 * 兼容带 `[INFO]` 前缀、`-DoutputFile` 输出、以及 +-/\- 树形连接符。
 */
export function parseDependencyTree(output: string): Map<string, DependencyNode> {
  const nodes = new Map<string, DependencyNode>();
  const stack: string[] = [];

  const visit = (line: TreeLine): void => {
    const coordinate = splitCoordinate(line.coordinate);
    if (!coordinate) {
      return;
    }
    const packageName = `${coordinate.groupId}:${coordinate.artifactId}`;
    const annotations = line.annotations;
    const conflict = /\(omitted for conflict with ([^)]+)\)/.exec(annotations);
    const duplicate = /\(omitted for duplicate\)/.test(annotations);
    const managed = /\(version managed from ([^\s)]+)(?:\s+by\s+([^)]+))?\)/.exec(annotations);
    const isRoot = line.depth === 0;

    const parent = line.depth > 0 ? stack[line.depth - 1] : undefined;
    const pathGAs = stack.slice(0, line.depth);

    if (!isRoot) {
      stack[line.depth] = packageName;
      stack.length = line.depth + 1;
    } else {
      stack.length = 0;
      stack[0] = packageName;
      return;
    }

    let node = nodes.get(packageName);
    if (!node) {
      node = {
        packageName,
        version: coordinate.version,
        direct: line.depth === 1,
        scope: coordinate.scope,
        conflicts: [],
        paths: [],
        dependents: []
      };
      nodes.set(packageName, node);
    }
    if (!duplicate) {
      node.direct = node.direct || line.depth === 1;
      if (!node.version) {
        node.version = coordinate.version;
      }
    }
    if (managed) {
      node.managedFrom = managed[1];
      if (managed[2]) {
        node.managedBy = managed[2].split(':').slice(0, 2).join(':');
      }
    }
    if (conflict) {
      const value = conflict[1].trim().split(':').pop() || conflict[1].trim();
      if (!node.conflicts.includes(value)) {
        node.conflicts.push(value);
      }
    }
    if (parent && !node.dependents.includes(parent)) {
      node.dependents.push(parent);
    }
    const trail = [...pathGAs, packageName];
    if (!node.paths.some((item) => item.join('>') === trail.join('>'))) {
      node.paths.push(trail);
    }
  };

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/^\[(INFO|WARNING|ERROR)\]\s?/, '').trimEnd();
    if (!line.trim()) {
      continue;
    }
    const branch = /^((?:[| ]{3})*)([+\\]-)\s+(\S.*)$/.exec(line);
    if (branch) {
      const [coordinate, ...tail] = branch[3].split(/\s+/);
      visit({
        depth: branch[1].length / 3 + 1,
        coordinate,
        annotations: tail.join(' ')
      });
      continue;
    }
    // 根节点：没有树形连接符，但形如 groupId:artifactId:type:version
    if (/^[\w.\-]+:[\w.\-]+:[\w.\-]+:[\w.\-]+/.test(line)) {
      const [coordinate, ...tail] = line.split(/\s+/);
      visit({ depth: 0, coordinate, annotations: tail.join(' ') });
    }
  }

  // annotations 与 coordinate 是同一串文本，统一从整行里提取
  for (const node of nodes.values()) {
    if (node.paths.length === 0) {
      node.paths.push([node.packageName]);
    }
  }
  return nodes;
}

let repositoryCache: { key: string; value: string } | undefined;

/** 读取 Maven 本地仓库位置（可能是自定义 settings.xml 指定的目录） */
export async function localRepository(root: string): Promise<string> {
  if (repositoryCache && repositoryCache.key === root) {
    return repositoryCache.value;
  }
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  let value = path.join(home, '.m2', 'repository');
  try {
    const probe = await run(
      'mvn',
      [
        '-B',
        '-q',
        ...mavenMirrorArgs(),
        'help:evaluate',
        '-Dexpression=settings.localRepository',
        '-DforceStdout'
      ],
      root,
      60_000
    );
    const text = probe.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();
    if (probe.code === 0 && text && !text.includes('[ERROR]') && fs.existsSync(text)) {
      value = text;
    }
  } catch {
    // 读不到时退回默认目录
  }
  repositoryCache = { key: root, value };
  return value;
}

function tagValue(block: string, tag: string): string {
  const match = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(block);
  return match ? match[1].trim() : '';
}

/** 解析 pom 的父 POM 与 dependencyManagement 中 scope=import 的 BOM */
export function parseBomRefs(pom: string): BomRef[] {
  const refs: BomRef[] = [];
  const parent = /<parent>([\s\S]*?)<\/parent>/.exec(pom);
  if (parent) {
    const groupId = tagValue(parent[1], 'groupId');
    const artifactId = tagValue(parent[1], 'artifactId');
    const version = tagValue(parent[1], 'version');
    if (groupId && artifactId && version && !version.includes('${')) {
      refs.push({ groupId, artifactId, version, kind: 'parent' });
    }
  }
  const dm = /<dependencyManagement>([\s\S]*?)<\/dependencyManagement>/.exec(pom);
  if (dm) {
    const re = /<dependency>([\s\S]*?)<\/dependency>/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(dm[1])) !== null) {
      const body = match[1];
      const type = tagValue(body, 'type');
      const scope = tagValue(body, 'scope');
      const groupId = tagValue(body, 'groupId');
      const artifactId = tagValue(body, 'artifactId');
      const version = tagValue(body, 'version');
      if (type === 'pom' && scope === 'import' && groupId && artifactId && version) {
        refs.push({ groupId, artifactId, version, kind: 'bom' });
      }
    }
  }
  return refs;
}

interface RawManaged {
  groupId: string;
  artifactId: string;
  version: string;
  type?: string;
  scope?: string;
}

interface RawPom {
  groupId?: string;
  artifactId?: string;
  version?: string;
  parent?: { groupId: string; artifactId: string; version: string };
  properties: Record<string, string>;
  managed: RawManaged[];
}

function readPomFile(repo: string, groupId: string, artifactId: string, version: string): RawPom | undefined {
  const file = path.join(
    repo,
    groupId.split('.').join(path.sep),
    artifactId,
    version,
    `${artifactId}-${version}.pom`
  );
  if (!fs.existsSync(file)) {
    return undefined;
  }
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const properties: Record<string, string> = {};
  const propsBlock = /<properties>([\s\S]*?)<\/properties>/.exec(text);
  if (propsBlock) {
    const re = /<([A-Za-z_][\w.\-]*)>\s*([^<]*?)\s*<\/\1>/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(propsBlock[1])) !== null) {
      properties[match[1]] = match[2].trim();
    }
  }
  const managed: RawPom['managed'] = [];
  const dm = /<dependencyManagement>([\s\S]*?)<\/dependencyManagement>/.exec(text);
  if (dm) {
    const re = /<dependency>([\s\S]*?)<\/dependency>/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(dm[1])) !== null) {
      const body = match[1];
      const groupIdValue = tagValue(body, 'groupId');
      const artifactIdValue = tagValue(body, 'artifactId');
      const versionValue = tagValue(body, 'version');
      if (groupIdValue && artifactIdValue) {
        managed.push({
          groupId: groupIdValue,
          artifactId: artifactIdValue,
          version: versionValue,
          type: tagValue(body, 'type') || undefined,
          scope: tagValue(body, 'scope') || undefined
        });
      }
    }
  }
  const parentBlock = /<parent>([\s\S]*?)<\/parent>/.exec(text);
  const parent = parentBlock
    ? {
        groupId: tagValue(parentBlock[1], 'groupId'),
        artifactId: tagValue(parentBlock[1], 'artifactId'),
        version: tagValue(parentBlock[1], 'version')
      }
    : undefined;
  return {
    groupId: tagValue(text, 'groupId') || undefined,
    artifactId: tagValue(text, 'artifactId') || undefined,
    version: tagValue(text, 'version') || undefined,
    parent: parent && parent.groupId && parent.artifactId && parent.version ? parent : undefined,
    properties,
    managed
  };
}

/** 沿 parent 链收集属性与 dependencyManagement（子级优先） */
function collectChain(
  repo: string,
  ref: { groupId: string; artifactId: string; version: string },
  depth = 0
): { properties: Record<string, string>; managed: RawManaged[] } {
  const result: { properties: Record<string, string>; managed: RawManaged[] } = {
    properties: {},
    managed: []
  };
  if (depth > 4) {
    return result;
  }
  const raw = readPomFile(repo, ref.groupId, ref.artifactId, ref.version);
  if (!raw) {
    return result;
  }
  const inherited = raw.parent ? collectChain(repo, raw.parent, depth + 1) : undefined;
  if (inherited) {
    Object.assign(result.properties, inherited.properties);
    result.managed.push(...inherited.managed);
  }
  Object.assign(result.properties, raw.properties);
  // 子级覆盖父级同名 GA
  for (const item of raw.managed) {
    const index = result.managed.findIndex(
      (existing) => existing.groupId === item.groupId && existing.artifactId === item.artifactId
    );
    if (index >= 0) {
      result.managed[index] = item;
    } else {
      result.managed.push(item);
    }
  }

  // scope=import 的 BOM 会把自己的版本继续下放（如 Spring Boot → spring-framework-bom）
  for (const item of raw.managed) {
    if (item.type !== 'pom' || item.scope !== 'import' || depth >= 4) {
      continue;
    }
    const version = resolvePlaceholders(item.version, result.properties);
    if (!version || version.includes('${')) {
      continue;
    }
    const nested = collectChain(repo, { groupId: item.groupId, artifactId: item.artifactId, version }, depth + 1);
    for (const [key, value] of Object.entries(nested.properties)) {
      if (!(key in result.properties)) {
        result.properties[key] = value;
      }
    }
    for (const nestedItem of nested.managed) {
      const exists = result.managed.some(
        (existing) =>
          existing.groupId === nestedItem.groupId && existing.artifactId === nestedItem.artifactId
      );
      if (!exists) {
        result.managed.push(nestedItem);
      }
    }
  }
  return result;
}

function resolvePlaceholders(value: string, properties: Record<string, string>, depth = 0): string {
  if (!value || depth > 5) {
    return value;
  }
  return value.replace(/\$\{([^}]+)\}/g, (all, name: string) => {
    const resolved = properties[name];
    return resolved === undefined ? all : resolvePlaceholders(resolved, properties, depth + 1);
  });
}

/**
 * 读取本地仓库中的父 POM / BOM，建立「GA → 由谁管理的哪个版本」索引。
 * 用于升级预览里说明版本来源，并判断哪些 CVE 可以由升级 BOM 一次解决。
 */
export async function indexBomManagement(
  refs: BomRef[],
  repo: string
): Promise<Map<string, ManagedEntry>> {
  const index = new Map<string, ManagedEntry>();
  for (const ref of refs) {
    const chain = collectChain(repo, ref);
    for (const item of chain.managed) {
      const version = resolvePlaceholders(item.version, chain.properties);
      if (!version || version.includes('${')) {
        continue;
      }
      const packageName = `${item.groupId}:${item.artifactId}`;
      if (!index.has(packageName)) {
        index.set(packageName, {
          bom: `${ref.groupId}:${ref.artifactId}`,
          version: ref.version,
          kind: ref.kind
        });
      }
    }
  }
  return index;
}
