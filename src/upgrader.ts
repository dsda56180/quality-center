import * as fs from 'fs';
import * as path from 'path';
import { Issue } from './model';
import { pickFixedVersion } from './suggest';

export interface DirectDependency {
  groupId: string;
  artifactId: string;
  /** pom 中的原始写法，可能是 ${xxx} */
  version: string;
  /** 版本由属性管理时，属性名 */
  property?: string;
}

export interface UpgradeCandidate {
  packageName: string;
  groupId: string;
  artifactId: string;
  from: string;
  to: string;
  cveCount: number;
  /** 需要修改的属性名（版本写成 ${xxx} 且仅此处引用时） */
  property?: string;
  /**
   * 写回 pom 的方式：
   * - property：修改版本属性
   * - pin：在直接依赖块上固定版本（依赖由 BOM 管理或属性被多处引用）
   * - manage：依赖未声明，写入 dependencyManagement 覆盖传递依赖
   */
  mode: 'property' | 'pin' | 'manage';
}

export interface UpgradePlan {
  candidates: UpgradeCandidate[];
  /** 无法自动升级的包及原因，用于界面解释 */
  skipped: { packageName: string; reason: string }[];
}

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

/** 汇总扫描结果，得出可以安全自动升级的依赖清单 */
export function planUpgrades(root: string, issues: Issue[]): UpgradePlan {
  const pomFile = path.join(root, 'pom.xml');
  if (!fs.existsSync(pomFile)) {
    return { candidates: [], skipped: [] };
  }
  const pom = fs.readFileSync(pomFile, 'utf8');
  const deps = parseDirectDependencies(pom);
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

  for (const [packageName, items] of byPackage) {
    const installed = items.find((item) => item.installedVersion)?.installedVersion || '';
    const dep = deps.find((item) => `${item.groupId}:${item.artifactId}` === packageName);
    const fixedVersions = items.map((item) => item.fixedVersion || '');
    const [groupId, artifactId] = packageName.split(':');
    if (!groupId || !artifactId) {
      continue;
    }

    let from = '';
    let mode: UpgradeCandidate['mode'] = 'pin';
    let property: string | undefined;

    if (dep && dep.version) {
      let declared = dep.version;
      if (dep.property) {
        const resolved = resolveProperty(pom, dep.property);
        if (!resolved) {
          skipped.push({ packageName, reason: `pom 中未找到版本属性 ${dep.version}` });
          continue;
        }
        declared = resolved;
        if (propertyUsages(pom, dep.property) === 1) {
          mode = 'property';
          property = dep.property;
        } else {
          // 属性被多处引用，直接给这个依赖固定版本，避免影响其它依赖
          mode = 'pin';
        }
      }
      if (installed && declared !== installed) {
        skipped.push({
          packageName,
          reason: `pom 声明 ${declared}，与扫描到的 ${installed} 不一致，需手动确认`
        });
        continue;
      }
      from = declared;
    } else if (dep) {
      // 依赖已声明但没有写版本：版本来自 BOM 或父 POM，可以固定一个显式版本来覆盖
      if (!installed) {
        skipped.push({ packageName, reason: '无法确定当前解析版本，需手动确认' });
        continue;
      }
      from = installed;
      mode = 'pin';
    } else {
      // 未在 pom 中声明（传递依赖）：通过 dependencyManagement 覆盖
      if (!installed) {
        skipped.push({ packageName, reason: '无法确定当前解析版本，需手动确认' });
        continue;
      }
      from = installed;
      mode = 'manage';
    }

    const to = pickFixedVersion(from, fixedVersions);
    if (!to || to === from) {
      skipped.push({ packageName, reason: '没有可用的同版本线修复版本，跨大版本升级需人工评估' });
      continue;
    }
    candidates.push({
      packageName,
      groupId,
      artifactId,
      from,
      to,
      cveCount: items.length,
      property,
      mode
    });
  }

  candidates.sort((a, b) => b.cveCount - a.cveCount);
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

/** 在直接依赖块上固定版本：已有版本则替换，没有则补一个 */
function pinDirectDependency(pom: string, candidate: UpgradeCandidate): string | undefined {
  const excluded = [...tagRanges(pom, 'dependencyManagement'), ...tagRanges(pom, 'build')];
  const re = /<dependency>([\s\S]*?)<\/dependency>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pom)) !== null) {
    if (inRanges(match.index, excluded)) {
      continue;
    }
    const body = match[1];
    if (
      tagValue(body, 'groupId') !== candidate.groupId ||
      tagValue(body, 'artifactId') !== candidate.artifactId
    ) {
      continue;
    }
    const newBody = /<version>[\s\S]*?<\/version>/.test(body)
      ? body.replace(/<version>[\s\S]*?<\/version>/, `<version>${candidate.to}</version>`)
      : insertVersion(body, candidate.to);
    return (
      pom.slice(0, match.index) + `<dependency>${newBody}</dependency>` + pom.slice(match.index + match[0].length)
    );
  }
  return undefined;
}

/** 在 dependencyManagement 中覆盖版本，必要时新建该区块 */
function manageDependency(pom: string, candidate: UpgradeCandidate): string | undefined {
  const range = tagRanges(pom, 'dependencyManagement')[0];
  if (range) {
    const [start, end] = range;
    const section = pom.slice(start, end);
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
      const newBody = /<version>[\s\S]*?<\/version>/.test(body)
        ? body.replace(/<version>[\s\S]*?<\/version>/, `<version>${candidate.to}</version>`)
        : insertVersion(body, candidate.to);
      const at = start + match.index;
      return pom.slice(0, at) + `<dependency>${newBody}</dependency>` + pom.slice(at + match[0].length);
    }
    const close = section.lastIndexOf('</dependencies>');
    if (close >= 0) {
      const at = start + close;
      const closeIndent = section.slice(section.lastIndexOf('\n', close) + 1, close);
      const depIndent = closeIndent + '  ';
      const entry =
        `  <dependency>\n` +
        `${depIndent}  <groupId>${candidate.groupId}</groupId>\n` +
        `${depIndent}  <artifactId>${candidate.artifactId}</artifactId>\n` +
        `${depIndent}  <version>${candidate.to}</version>\n` +
        `${depIndent}</dependency>\n` +
        `${closeIndent}`;
      return pom.slice(0, at) + entry + pom.slice(at);
    }
    return undefined;
  }

  // 没有 dependencyManagement：在顶层 <dependencies> 之前插入一节
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
    `${indent}      <version>${candidate.to}</version>\n` +
    `${indent}    </dependency>\n` +
    `${indent}  </dependencies>\n` +
    `${indent}</dependencyManagement>\n\n${indent}`;
  return pom.slice(0, at) + block + pom.slice(at);
}

/**
 * 把指定依赖的版本替换为新版本，返回新的 pom 文本。
 * 定位不到目标依赖或版本已被改动时返回 undefined，避免误改。
 */
export function applyUpgrade(pom: string, candidate: UpgradeCandidate): string | undefined {
  if (candidate.mode === 'property' && candidate.property) {
    if (propertyUsages(pom, candidate.property) !== 1) {
      return undefined;
    }
    const pattern = new RegExp(
      `(<${escapeRegExp(candidate.property)}>)\\s*${escapeRegExp(candidate.from)}\\s*(</${escapeRegExp(
        candidate.property
      )}>)`
    );
    if (!pattern.test(pom)) {
      return undefined;
    }
    return pom.replace(pattern, `$1${candidate.to}$2`);
  }
  if (candidate.mode === 'manage') {
    return manageDependency(pom, candidate);
  }
  return pinDirectDependency(pom, candidate);
}
