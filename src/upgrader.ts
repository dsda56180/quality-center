import * as fs from 'fs';
import * as path from 'path';
import { Issue } from './model';
import { pickFixedVersion } from './suggest';
import { DependencyNode, ManagedEntry, parseBomRefs } from './dependencies';

export interface DirectDependency {
  groupId: string;
  artifactId: string;
  /** pom 中的原始写法，可能是 ${xxx} */
  version: string;
  /** 版本由属性管理时，属性名 */
  property?: string;
}

/**
 * 写回 pom 的方式（遵循「版本号统一由 properties 管理」的标准设计）：
 * - parent：升级 <parent> 版本
 * - bom：升级 dependencyManagement 中导入的 BOM 版本
 * - plugin：升级 <build><plugins> 中显式声明的插件版本
 * - property：依赖写的是 ${p} 且 p 只被这一处引用，直接改属性
 * - extract：把版本抽离成独立属性（硬编码、或属性被多处共用时）
 * - manage：传递依赖，在 dependencyManagement 中新增版本覆盖（同样使用属性）
 */
export type UpgradeMode = 'parent' | 'bom' | 'plugin' | 'property' | 'extract' | 'manage';

export interface UpgradeCandidate {
  packageName: string;
  groupId: string;
  artifactId: string;
  from: string;
  to: string;
  cveCount: number;
  mode: UpgradeMode;
  /** 当前版本的来源说明，直接展示在预览里 */
  source: string;
  sourceKind: 'parent' | 'bom' | 'declared' | 'transitive';
  property?: string;
  /** 本次升级会一并解决的其它依赖 */
  affects?: string[];
  /** 版本冲突说明（其它分支选择的版本、被 BOM 管理的声明差异） */
  conflicts?: string[];
  /** 可选目标版本，多个时预览里给用户下拉选择 */
  alternatives?: string[];
  note?: string;
}

export interface UpgradePlan {
  candidates: UpgradeCandidate[];
  /** 无法自动升级的包及原因，用于界面解释 */
  skipped: { packageName: string; reason: string }[];
}

/** 依赖树与 BOM 索引，用于判断版本来源与联动关系 */
export interface UpgradeContext {
  nodes?: Map<string, DependencyNode>;
  managed?: Map<string, ManagedEntry>;
}

export interface UpgradeChange {
  label: string;
  old: string;
  new: string;
}

export interface UpgradeResult {
  text: string;
  changes: UpgradeChange[];
}

const SPRING_BOOT_TARGET = '2.7.18';

function tagValue(block: string, tag: string): string {
  const match = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(block);
  return match ? match[1].trim() : '';
}

function tagRanges(pom: string, tag: string): [number, number][] {
  const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g');
  const ranges: [number, number][] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(pom)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function inRanges(index: number, ranges: [number, number][]): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function propertyName(version: string): string | undefined {
  const match = /^\$\{([^}]+)\}$/.exec(version.trim());
  return match ? match[1] : undefined;
}

function resolveProperty(pom: string, name: string): string | undefined {
  const match = new RegExp(`<${escapeRegExp(name)}>\\s*([^<]*?)\\s*</${escapeRegExp(name)}>`).exec(pom);
  return match ? match[1].trim() : undefined;
}

/** 统计属性在 pom 中的引用次数，多处引用时改动会波及其他依赖 */
function propertyUsages(pom: string, name: string): number {
  return pom.split('${' + name + '}').length - 1;
}

function compareVersion(a: string, b: string): number {
  const pa = a.split(/[.\-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(/[.\-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function versionPair(version: string): [number, number] {
  const match = /^(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

function flattenVersions(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function uniqueVersions(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

/** Spring 生态组件：版本通常由 Spring Boot BOM 统一管理 */
function isSpringFamily(packageName: string): boolean {
  const [groupId, artifactId] = packageName.split(':');
  if (!artifactId) {
    return false;
  }
  if (groupId === 'org.springframework') {
    return true;
  }
  return [
    'spring-',
    'tomcat-embed',
    'jackson-',
    'snakeyaml',
    'logback-',
    'log4j',
    'netty-',
    'hibernate-'
  ].some((prefix) => artifactId.startsWith(prefix));
}

/**
 * 解析 pom 中显式声明版本的直接依赖。
 * `<dependencyManagement>` 与 `<build>` 里的依赖不参与升级：
 * 前者是 BOM 统一管版本，后者属于插件依赖。
 */
export function parseDirectDependencies(pom: string): DirectDependency[] {
  const excluded = [...tagRanges(pom, 'dependencyManagement'), ...tagRanges(pom, 'build')];
  const deps: DirectDependency[] = [];
  const re = /<dependency>([\s\S]*?)<\/dependency>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pom)) !== null) {
    if (inRanges(match.index, excluded)) {
      continue;
    }
    const body = match[1];
    const groupId = tagValue(body, 'groupId');
    const artifactId = tagValue(body, 'artifactId');
    const version = tagValue(body, 'version');
    if (groupId && artifactId) {
      deps.push({ groupId, artifactId, version, property: propertyName(version) });
    }
  }
  return deps;
}

/** 汇总扫描结果（可选结合依赖树/BOM 索引），得出可自动升级的清单 */
export function planUpgrades(root: string, issues: Issue[], context?: UpgradeContext): UpgradePlan {
  const pomFile = path.join(root, 'pom.xml');
  if (!fs.existsSync(pomFile)) {
    return { candidates: [], skipped: [] };
  }
  const pom = fs.readFileSync(pomFile, 'utf8');
  const deps = parseDirectDependencies(pom);
  const managed = context?.managed;
  const nodes = context?.nodes;
  const byPackage = new Map<string, Issue[]>();
  for (const issue of issues) {
    if (issue.source !== 'trivy' || !issue.packageName) {
      continue;
    }
    if (!byPackage.has(issue.packageName)) {
      byPackage.set(issue.packageName, []);
    }
    byPackage.get(issue.packageName)!.push(issue);
  }

  const candidates: UpgradeCandidate[] = [];
  const skipped: { packageName: string; reason: string }[] = [];
  /** 已被框架层升级覆盖的依赖 → 覆盖它的候选包名 */
  const coveredBy = new Map<string, string>();

  // 1. Spring Boot 2.x 升级：一次提升整组 BOM 管理的版本，不再逐个固定
  const bootRefs = parseBomRefs(pom).filter((ref) => ref.groupId === 'org.springframework.boot');
  for (const ref of bootRefs) {
    const [major, minor] = versionPair(ref.version);
    if (major !== 2 || minor >= 7) {
      continue;
    }
    if (compareVersion(ref.version, SPRING_BOOT_TARGET) >= 0) {
      continue;
    }
    const bomKey = `${ref.groupId}:${ref.artifactId}`;
    // 显式写了版本的依赖不会被 BOM 升级影响，仍需单独处理
    const declaredWithVersion = new Set(
      deps.filter((dep) => dep.version).map((dep) => `${dep.groupId}:${dep.artifactId}`)
    );
    const affected: string[] = [];
    for (const packageName of byPackage.keys()) {
      const entry = managed?.get(packageName);
      const fromBom = entry ? entry.bom === bomKey : isSpringFamily(packageName);
      if (!fromBom || declaredWithVersion.has(packageName)) {
        continue;
      }
      affected.push(packageName);
    }
    const cveCount = affected.reduce((sum, name) => sum + (byPackage.get(name)?.length ?? 0), 0);
    if (cveCount === 0) {
      continue;
    }
    candidates.push({
      packageName: bomKey,
      groupId: ref.groupId,
      artifactId: ref.artifactId,
      from: ref.version,
      to: SPRING_BOOT_TARGET,
      cveCount,
      mode: ref.kind,
      source:
        ref.kind === 'parent'
          ? '项目 <parent>，Spring 生态组件版本都由它管理'
          : '<dependencyManagement> 中 scope=import 的 BOM',
      sourceKind: ref.kind,
      affects: affected,
      alternatives: [SPRING_BOOT_TARGET],
      note:
        `升级后 spring-*、tomcat-embed-*、jackson-*、logback-* 等版本会一起对齐到 ${SPRING_BOOT_TARGET}，` +
        `不再逐个固定；spring-boot-maven-plugin 的版本也随父 POM 对齐。` +
        `代码级适配可继续执行「Spring Boot 2.7 代码迁移」（rewrite-spring）。`
    });
    affected.forEach((name) => coveredBy.set(name, bomKey));
  }

  // 2. 显式固定了 Spring Boot 插件版本时，插件也必须同步到同一版本
  const hasBootUpgrade = candidates.some(
    (item) => item.groupId === 'org.springframework.boot' && (item.mode === 'parent' || item.mode === 'bom')
  );
  if (hasBootUpgrade) {
    const re = /<plugin>([\s\S]*?)<\/plugin>/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(pom)) !== null) {
      const body = match[1];
      if (
        tagValue(body, 'groupId') !== 'org.springframework.boot' ||
        tagValue(body, 'artifactId') !== 'spring-boot-maven-plugin'
      ) {
        continue;
      }
      const version = tagValue(body, 'version');
      if (!version || version.includes('${') || compareVersion(version, SPRING_BOOT_TARGET) >= 0) {
        continue;
      }
      candidates.push({
        packageName: 'org.springframework.boot:spring-boot-maven-plugin',
        groupId: 'org.springframework.boot',
        artifactId: 'spring-boot-maven-plugin',
        from: version,
        to: SPRING_BOOT_TARGET,
        cveCount: 0,
        mode: 'plugin',
        source: '<build><plugins> 中显式声明，未跟随父 POM',
        sourceKind: 'declared',
        alternatives: [SPRING_BOOT_TARGET],
        note: `Spring Boot ${SPRING_BOOT_TARGET} 对应同版本的 spring-boot-maven-plugin，避免构建期版本错配。`
      });
    }
  }

  // 3. 其余依赖逐个处理
  for (const [packageName, items] of byPackage) {
    if (coveredBy.has(packageName)) {
      continue;
    }
    const [groupId, artifactId] = packageName.split(':');
    if (!groupId || !artifactId) {
      continue;
    }
    const node = nodes?.get(packageName);
    const installed = node?.version || items.find((item) => item.installedVersion)?.installedVersion || '';
    const dep = deps.find((item) => `${item.groupId}:${item.artifactId}` === packageName);
    const managedEntry = managed?.get(packageName);

    let from = '';
    let mode: UpgradeMode = 'manage';
    let property: string | undefined;
    let source = '';
    let sourceKind: UpgradeCandidate['sourceKind'] = 'transitive';
    let note: string | undefined;

    if (dep && dep.version) {
      sourceKind = 'declared';
      if (dep.property) {
        const resolved = resolveProperty(pom, dep.property);
        if (!resolved) {
          skipped.push({ packageName, reason: `pom 中未找到版本属性 ${dep.version}` });
          continue;
        }
        from = resolved;
        property = dep.property;
        mode = propertyUsages(pom, dep.property) === 1 ? 'property' : 'extract';
      } else {
        from = dep.version.trim();
        mode = 'extract';
      }
      source = managedEntry
        ? `pom 直接声明 ${from}；${managedEntry.bom} ${managedEntry.version} 也管理该版本`
        : 'pom 直接声明';
      if (installed && from !== installed) {
        note = `pom 声明 ${from}，依赖树实际解析为 ${installed}（可能有更近的版本覆盖）`;
        from = installed;
      }
    } else if (dep) {
      sourceKind = 'declared';
      from = installed;
      mode = 'extract';
      source = managedEntry
        ? `由 ${managedEntry.bom} ${managedEntry.version} 管理`
        : '未声明版本（由父 POM 或 BOM 管理）';
      note = '该依赖由 BOM 统一管理，单独固定版本可能与同源组件不一致；建议优先升级 BOM。';
    } else {
      sourceKind = 'transitive';
      from = installed;
      mode = 'manage';
      source = managedEntry
        ? `传递依赖，由 ${managedEntry.bom} ${managedEntry.version} 管理`
        : '传递依赖（未在 pom 中声明）';
    }

    if (!from) {
      skipped.push({ packageName, reason: '无法确定当前解析版本，需手动确认' });
      continue;
    }

    const to = pickFixedVersion(from, flattenVersions(items.map((item) => item.fixedVersion || '')));
    if (!to || to === from) {
      skipped.push({ packageName, reason: '没有可用的同版本线修复版本，跨大版本升级需人工评估' });
      continue;
    }

    const alternatives = uniqueVersions([to, ...flattenVersions(items.map((item) => item.fixedVersion || ''))])
      .sort(compareVersion)
      .reverse()
      .slice(0, 6);

    const conflicts: string[] = [];
    if (node) {
      for (const value of node.conflicts) {
        conflicts.push(`其它分支选择了 ${value}，升级后需要一并确认`);
      }
      if (node.managedFrom && node.managedFrom !== node.version) {
        conflicts.push(`依赖树中被 ${node.managedBy ?? 'BOM'} 从 ${node.managedFrom} 调整为 ${node.version}`);
      }
      if (node.paths.length > 1) {
        const trail = node.paths[0].join(' → ');
        conflicts.push(`在 ${node.paths.length} 条依赖路径中出现（例如 ${trail}）`);
      }
    }

    candidates.push({
      packageName,
      groupId,
      artifactId,
      from,
      to,
      cveCount: items.length,
      mode,
      source,
      sourceKind,
      property,
      conflicts: conflicts.length ? conflicts : undefined,
      alternatives,
      note
    });
  }

  const order: Record<UpgradeMode, number> = {
    parent: 0,
    bom: 0,
    plugin: 1,
    extract: 2,
    property: 2,
    manage: 3
  };
  candidates.sort((a, b) => order[a.mode] - order[b.mode] || b.cveCount - a.cveCount);
  return { candidates, skipped };
}

/** 在依赖块内插入版本标签，保持原有缩进 */
function insertVersion(body: string, version: string): string {
  const indentMatch = /\n([ \t]*)<artifactId>/.exec(body);
  const indent = indentMatch ? indentMatch[1] : '      ';
  const trailing = /\s*$/.exec(body)?.[0] ?? '';
  const content = body.slice(0, body.length - trailing.length);
  return `${content}\n${indent}<version>${version}</version>${trailing}`;
}

/** 依赖块中的版本表达式：已有 <version> 则替换，没有则补一行 */
function withVersion(body: string, expression: string): string {
  return /<version>[\s\S]*?<\/version>/.test(body)
    ? body.replace(/<version>[\s\S]*?<\/version>/, `<version>${expression}</version>`)
    : insertVersion(body, expression);
}

interface LocatedBlock {
  start: number;
  end: number;
  body: string;
}

/** 定位普通 <dependencies> 中的直接依赖块 */
function locateDirectDependency(pom: string, groupId: string, artifactId: string): LocatedBlock | undefined {
  const excluded = [...tagRanges(pom, 'dependencyManagement'), ...tagRanges(pom, 'build')];
  const re = /<dependency>([\s\S]*?)<\/dependency>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pom)) !== null) {
    if (inRanges(match.index, excluded)) {
      continue;
    }
    const body = match[1];
    if (tagValue(body, 'groupId') === groupId && tagValue(body, 'artifactId') === artifactId) {
      return { start: match.index, end: match.index + match[0].length, body };
    }
  }
  return undefined;
}

/** 选择依赖专属的版本属性名，避免与已有属性冲突 */
function pickPropertyName(pom: string, candidate: UpgradeCandidate): string {
  const base = candidate.artifactId.replace(/[^A-Za-z0-9_.-]/g, '');
  const groupTail = (candidate.groupId.split('.').pop() || 'dep').replace(/[^A-Za-z0-9_.-]/g, '');
  const options = [`${base}.version`, `${groupTail}.${base}.version`, `${candidate.groupId}.${base}.version`];
  for (const name of options) {
    if (!new RegExp(`<${escapeRegExp(name)}>`).test(pom)) {
      return name;
    }
  }
  return options[options.length - 1];
}

/** 更新或新增版本属性 */
function setProperty(
  pom: string,
  name: string,
  value: string
): { text: string; old: string; new: string } | undefined {
  const tag = `<${name}>${value}</${name}>`;
  const pattern = new RegExp(`<${escapeRegExp(name)}>\\s*[^<]*?\\s*</${escapeRegExp(name)}>`);
  const match = pattern.exec(pom);
  if (match) {
    return {
      text: pom.slice(0, match.index) + tag + pom.slice(match.index + match[0].length),
      old: match[0],
      new: tag
    };
  }

  const props = tagRanges(pom, 'properties')[0];
  if (props) {
    const [propsStart, propsEnd] = props;
    const closeIdx = propsEnd - '</properties>'.length;
    const lineStart = pom.lastIndexOf('\n', closeIdx) + 1;
    const closeIndent = pom.slice(lineStart, closeIdx);
    const childIndent = /\n([ \t]*)<[A-Za-z_]/.exec(pom.slice(propsStart, propsEnd))?.[1];
    const line = `${childIndent ?? closeIndent + '  '}${tag}`;
    const text = pom.slice(0, lineStart) + line + '\n' + pom.slice(lineStart);
    return { text, old: '', new: line.trim() };
  }

  const parentBlock = tagRanges(pom, 'parent')[0];
  const modelVersion = tagRanges(pom, 'modelVersion')[0];
  const at = parentBlock ? parentBlock[1] : modelVersion ? modelVersion[1] : -1;
  if (at < 0) {
    return undefined;
  }
  const block = `\n  <properties>\n    ${tag}\n  </properties>`;
  const text = pom.slice(0, at) + block + pom.slice(at);
  return { text, old: '', new: tag };
}

/** 升级 <parent>、BOM 或插件块里的版本 */
function replaceBlockVersion(
  pom: string,
  kind: 'parent' | 'bom' | 'plugin',
  candidate: UpgradeCandidate,
  to: string
): UpgradeResult | undefined {
  if (kind === 'bom') {
    for (const [dmStart, dmEnd] of tagRanges(pom, 'dependencyManagement')) {
      const section = pom.slice(dmStart, dmEnd);
      const re = /<dependency>([\s\S]*?)<\/dependency>/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(section)) !== null) {
        const body = match[1];
        if (
          tagValue(body, 'groupId') !== candidate.groupId ||
          tagValue(body, 'artifactId') !== candidate.artifactId
        ) {
          continue;
        }
        const oldTag = /<version>[\s\S]*?<\/version>/.exec(body)?.[0];
        if (!oldTag) {
          return undefined;
        }
        const at = dmStart + match.index;
        return {
          text: pom.slice(0, at) + `<dependency>${withVersion(body, to)}</dependency>` + pom.slice(at + match[0].length),
          changes: [{ label: 'BOM 版本', old: oldTag, new: `<version>${to}</version>` }]
        };
      }
    }
    return undefined;
  }

  const tag = kind === 'parent' ? 'parent' : 'plugin';
  for (const [start, end] of tagRanges(pom, tag)) {
    const body = pom.slice(start + tag.length + 2, end - tag.length - 3);
    if (
      tagValue(body, 'groupId') !== candidate.groupId ||
      tagValue(body, 'artifactId') !== candidate.artifactId
    ) {
      continue;
    }
    const oldTag = /<version>[\s\S]*?<\/version>/.exec(body)?.[0];
    if (!oldTag) {
      continue;
    }
    return {
      text: pom.slice(0, start) + `<${tag}>${withVersion(body, to)}</${tag}>` + pom.slice(end),
      changes: [
        {
          label: kind === 'parent' ? '父 POM 版本' : '插件版本',
          old: oldTag,
          new: `<version>${to}</version>`
        }
      ]
    };
  }
  return undefined;
}

/** 把依赖版本抽离到 <properties>，依赖块改为引用属性 */
function extractVersion(pom: string, candidate: UpgradeCandidate, to: string): UpgradeResult | undefined {
  const located = locateDirectDependency(pom, candidate.groupId, candidate.artifactId);
  if (!located) {
    return undefined;
  }
  const property = pickPropertyName(pom, candidate);
  const expression = `\${${property}}`;
  const oldTag = /<version>[\s\S]*?<\/version>/.exec(located.body)?.[0] ?? '';
  const next =
    pom.slice(0, located.start) +
    `<dependency>${withVersion(located.body, expression)}</dependency>` +
    pom.slice(located.end);
  const propertyResult = setProperty(next, property, to);
  if (!propertyResult) {
    return undefined;
  }
  return {
    text: propertyResult.text,
    changes: [
      { label: 'properties', old: propertyResult.old, new: propertyResult.new },
      {
        label: `${candidate.groupId}:${candidate.artifactId}`,
        old: oldTag,
        new: `<version>${expression}</version>`
      }
    ]
  };
}

/** 在 dependencyManagement 中覆盖版本，必要时新建该区块；版本同样抽离到 properties */
function manageDependency(pom: string, candidate: UpgradeCandidate, to: string): UpgradeResult | undefined {
  const property = pickPropertyName(pom, candidate);
  const expression = `\${${property}}`;
  let text = pom;
  let oldTag = '';

  const dmRange = tagRanges(pom, 'dependencyManagement')[0];
  if (dmRange) {
    const [start] = dmRange;
    const section = pom.slice(start);
    const re = /<dependency>([\s\S]*?)<\/dependency>/g;
    let match: RegExpExecArray | null;
    let handled = false;
    while ((match = re.exec(section)) !== null) {
      const body = match[1];
      if (
        tagValue(body, 'groupId') !== candidate.groupId ||
        tagValue(body, 'artifactId') !== candidate.artifactId
      ) {
        continue;
      }
      oldTag = /<version>[\s\S]*?<\/version>/.exec(body)?.[0] ?? '';
      const at = start + match.index;
      text =
        pom.slice(0, at) +
        `<dependency>${withVersion(body, expression)}</dependency>` +
        pom.slice(at + match[0].length);
      handled = true;
      break;
    }
    if (!handled) {
      const [dmStart, dmEnd] = dmRange;
      const close = pom.lastIndexOf('</dependencies>', dmEnd);
      if (close < 0 || close < dmStart) {
        return undefined;
      }
      const lineStart = pom.lastIndexOf('\n', close) + 1;
      const closeIndent = pom.slice(lineStart, close);
      const section = pom.slice(dmStart, dmEnd);
      const depIndent = /\n([ \t]*)<dependency>/.exec(section)?.[1] ?? closeIndent + '  ';
      const innerIndent = depIndent + '    ';
      const entry =
        `${depIndent}<dependency>\n` +
        `${innerIndent}<groupId>${candidate.groupId}</groupId>\n` +
        `${innerIndent}<artifactId>${candidate.artifactId}</artifactId>\n` +
        `${innerIndent}<version>${expression}</version>\n` +
        `${depIndent}</dependency>\n`;
      text = pom.slice(0, lineStart) + entry + pom.slice(lineStart);
    }
  } else {
    const buildRanges = tagRanges(pom, 'build');
    const re = /<dependencies>/g;
    let match: RegExpExecArray | null;
    let at = -1;
    while ((match = re.exec(pom)) !== null) {
      if (!inRanges(match.index, buildRanges)) {
        at = match.index;
        break;
      }
    }
    if (at < 0) {
      at = pom.lastIndexOf('</project>');
      if (at < 0) {
        return undefined;
      }
    }
    const indent = /[ \t]*$/.exec(pom.slice(0, at))?.[0] ?? '';
    const block =
      `<dependencyManagement>\n` +
      `${indent}  <dependencies>\n` +
      `${indent}    <dependency>\n` +
      `${indent}      <groupId>${candidate.groupId}</groupId>\n` +
      `${indent}      <artifactId>${candidate.artifactId}</artifactId>\n` +
      `${indent}      <version>${expression}</version>\n` +
      `${indent}    </dependency>\n` +
      `${indent}  </dependencies>\n` +
      `${indent}</dependencyManagement>\n\n${indent}`;
    text = pom.slice(0, at) + block + pom.slice(at);
  }

  const propertyResult = setProperty(text, property, to);
  if (!propertyResult) {
    return undefined;
  }
  return {
    text: propertyResult.text,
    changes: [
      { label: 'properties', old: propertyResult.old, new: propertyResult.new },
      {
        label: `dependencyManagement · ${candidate.packageName}`,
        old: oldTag,
        new: `<version>${expression}</version>`
      }
    ]
  };
}

/**
 * 把候选依赖的版本写回 pom，返回新文本与逐条改动（供预览展示）。
 * 定位不到目标依赖或版本已被改动时返回 undefined，避免误改。
 */
export function applyUpgrade(
  pom: string,
  candidate: UpgradeCandidate,
  to = candidate.to
): UpgradeResult | undefined {
  if (to === candidate.from) {
    return undefined;
  }
  switch (candidate.mode) {
    case 'parent':
    case 'bom':
    case 'plugin':
      return replaceBlockVersion(pom, candidate.mode, candidate, to);
    case 'property': {
      if (!candidate.property || propertyUsages(pom, candidate.property) !== 1) {
        return undefined;
      }
      const result = setProperty(pom, candidate.property, to);
      return result
        ? { text: result.text, changes: [{ label: 'properties', old: result.old, new: result.new }] }
        : undefined;
    }
    case 'extract':
      return extractVersion(pom, candidate, to);
    case 'manage':
      return manageDependency(pom, candidate, to);
    default:
      return undefined;
  }
}
