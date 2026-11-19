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
  /** 需要修改的属性名（版本写成 ${xxx} 时） */
  property?: string;
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
    if (groupId && artifactId && version) {
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
    if (!dep) {
      skipped.push({
        packageName,
        reason: 'pom 中没有显式声明版本（由 BOM 管理或为传递依赖），需手动覆盖版本'
      });
      continue;
    }

    let declared = dep.version;
    if (dep.property) {
      const resolved = resolveProperty(pom, dep.property);
      if (!resolved) {
        skipped.push({ packageName, reason: `pom 中未找到版本属性 ${dep.version}` });
        continue;
      }
      if (propertyUsages(pom, dep.property) > 1) {
        skipped.push({
          packageName,
          reason: `版本属性 ${dep.version} 被多处引用，改动会波及其他依赖，需手动确认`
        });
        continue;
      }
      declared = resolved;
    }

    if (installed && declared !== installed) {
      skipped.push({
        packageName,
        reason: `pom 声明 ${declared}，与扫描到的 ${installed} 不一致，需手动确认`
      });
      continue;
    }
    const to = pickFixedVersion(
      declared,
      items.map((item) => item.fixedVersion || '')
    );
    if (!to || to === declared) {
      skipped.push({ packageName, reason: '没有可用的同版本线修复版本，跨大版本升级需人工评估' });
      continue;
    }
    candidates.push({
      packageName,
      groupId: dep.groupId,
      artifactId: dep.artifactId,
      from: declared,
      to,
      cveCount: items.length,
      property: dep.property
    });
  }

  candidates.sort((a, b) => b.cveCount - a.cveCount);
  return { candidates, skipped };
}

/**
 * 把指定依赖的版本替换为新版本，返回新的 pom 文本。
 * 只在未声明版本的块不匹配、或版本已变化时返回 undefined，避免误改。
 */
export function applyUpgrade(pom: string, candidate: UpgradeCandidate): string | undefined {
  if (candidate.property) {
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
      tagValue(body, 'artifactId') !== candidate.artifactId ||
      tagValue(body, 'version') !== candidate.from
    ) {
      continue;
    }
    if (!/<version>[\s\S]*?<\/version>/.test(body)) {
      return undefined;
    }
    const newBody = body.replace(/<version>[\s\S]*?<\/version>/, `<version>${candidate.to}</version>`);
    return pom.slice(0, match.index) + `<dependency>${newBody}</dependency>` + pom.slice(match.index + match[0].length);
  }
  return undefined;
}
