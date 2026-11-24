import * as fs from 'fs';
import * as path from 'path';
import { Issue, ScanResult, Suggestion } from './model';

/** 框架层组件前缀：这些包大多由 Spring Boot BOM 统一管理，单独升级无效 */
const FRAMEWORK_PREFIXES = [
  'spring-',
  'tomcat-embed',
  'jackson-',
  'snakeyaml',
  'logback-',
  'log4j',
  'netty-',
  'hibernate-'
];

/** 能由插件直接改写的规则，其余需要语义判断 */
const AUTO_FIXABLE_RULES = [
  'UnusedImports',
  'RedundantImport',
  'ModifierOrder',
  'SimplifyBooleanExpression'
];

function readPom(root: string): string {
  const file = path.join(root, 'pom.xml');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

export function detectSpringBootVersion(pom: string): string | undefined {
  const patterns = [
    /<artifactId>\s*spring-boot-starter-parent\s*<\/artifactId>\s*<version>\s*([^<]+?)\s*<\/version>/,
    /<artifactId>\s*spring-boot-dependencies\s*<\/artifactId>\s*<version>\s*([^<]+?)\s*<\/version>/
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(pom);
    if (match) {
      return match[1].trim();
    }
  }
  return undefined;
}

function majorMinor(version: string): [number, number] {
  const match = /^(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

function compareVersions(a: string, b: string): number {
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

function highestFixed(versions: string[]): string {
  const parsed = versions
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  if (parsed.length === 0) {
    return '';
  }
  return parsed.sort(compareVersions)[parsed.length - 1];
}

/** 依赖包名形如 groupId:artifactId，框架前缀只对 artifactId 生效 */
function artifactOf(packageName: string): string {
  const index = packageName.lastIndexOf(':');
  return index >= 0 ? packageName.slice(index + 1) : packageName;
}

function isFrameworkPackage(packageName: string): boolean {
  const artifact = artifactOf(packageName);
  return FRAMEWORK_PREFIXES.some((prefix) => artifact.startsWith(prefix));
}

/**
 * 选择升级目标版本：优先同一主次版本号（如 9.0.41 → 9.0.x 最新），
 * 避免跨大版本升级带来的破坏性变更；无同线版本时退到同主版本，最后才取全局最高。
 */
export function pickFixedVersion(installed: string, fixedValues: string[]): string {
  const all = [...new Set(
    fixedValues
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean)
  )];
  if (all.length === 0) {
    return '';
  }
  const [installedMajor, installedMinor] = majorMinor(installed);
  const sameLine = all.filter((value) => {
    const [major, minor] = majorMinor(value);
    return major === installedMajor && minor === installedMinor;
  });
  if (sameLine.length > 0) {
    return highestFixed(sameLine);
  }
  const sameMajor = all.filter((value) => majorMinor(value)[0] === installedMajor);
  if (sameMajor.length > 0) {
    return highestFixed(sameMajor);
  }
  return highestFixed(all);
}

function cveSummary(issues: Issue[], limit = 3): string {
  return issues
    .slice(0, limit)
    .map((issue) => issue.rule)
    .join('、');
}

/**
 * 从扫描结果推导可执行的修复建议。
 * 与逐条问题不同，这里关注「一个动作能消掉一片问题」的根因，
 * 例如升级 Spring Boot 版本、迁移硬编码密钥、覆盖传递依赖版本。
 */
export function buildSuggestions(root: string, result: ScanResult): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const cves = result.issues.filter((issue) => issue.source === 'trivy');

  if (cves.length > 0) {
    const bootVersion = detectSpringBootVersion(readPom(root));
    const frameworkCves = bootVersion
      ? cves.filter((issue) => isFrameworkPackage(issue.packageName || ''))
      : [];

    if (bootVersion) {
      const [major, minor] = majorMinor(bootVersion);
      if (major === 2 && minor < 7) {
        suggestions.push({
          category: 'framework',
          title: `Spring Boot ${bootVersion} → 2.7.18`,
          detail:
            `当前 Spring Boot 版本已停止维护，内置的 Spring Framework / Tomcat / Jackson / Logback 均存在已知漏洞，` +
            `仅框架层就命中 ${frameworkCves.length} 条，单独升级子依赖无效（版本被 BOM 锁定）。` +
            `2.7.18 是最后一个支持 Java 8 的版本，升级后大部分框架层漏洞可一次消除。` +
            `升级前需跑通单元测试，并检查是否引入 springfox 等已停更组件。`,
          impact: frameworkCves.length || cves.length
        });
      } else if (major === 3) {
        suggestions.push({
          category: 'framework',
          title: `Spring Boot ${bootVersion} 建议升级到 3.2.x / 3.3.x 最新补丁`,
          detail:
            'Spring Boot 3 的小版本补丁会同步升级 Spring Framework、Tomcat、Jackson 等内置组件版本。' +
            `当前框架层命中 ${frameworkCves.length} 条漏洞，升级补丁版本可在不改动业务代码的前提下消除。`,
          impact: frameworkCves.length
        });
      }
    }

    const byPackage = new Map<string, Issue[]>();
    for (const issue of cves) {
      const key = issue.packageName || issue.rule;
      if (!byPackage.has(key)) {
        byPackage.set(key, []);
      }
      byPackage.get(key)!.push(issue);
    }

    const ranked = [...byPackage.entries()]
      .filter(([, items]) => items.length >= 2)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 4);

    for (const [packageName, items] of ranked) {
      const isFramework = isFrameworkPackage(packageName);
      if (isFramework && bootVersion) {
        // 已由上面的框架升级建议覆盖，避免重复
        continue;
      }
      const installed = items[0].installedVersion || '';
      const fixed = pickFixedVersion(
        installed,
        items.map((issue) => issue.fixedVersion || '')
      );
      if (!fixed) {
        continue;
      }
      suggestions.push({
        category: 'dependency',
        title: `${packageName} ${installed} → ${fixed}`,
        detail:
          `该组件命中 ${items.length} 条漏洞（${cveSummary(items)}）。` +
          `建议优先升到同一版本线内的 ${fixed}，避免跨大版本引入破坏性变更；` +
          `若是传递依赖，在 <dependencyManagement> 中显式声明该版本覆盖即可。` +
          `升级后用 mvn dependency:tree 确认实际生效版本。`,
        impact: items.length
      });
    }

    if (suggestions.length === 0) {
      suggestions.push({
        category: 'manual',
        title: `${cves.length} 条依赖漏洞需要人工评估`,
        detail:
          '漏洞分散在多个组件且无统一升级入口，建议先处理「严重 / 高危」条目，' +
          '逐条复制给 AI 或参考漏洞链接评估实际影响面（是否使用了受影响的 API）。',
        impact: cves.length
      });
    } else {
      const covered = suggestions.reduce((sum, item) => sum + item.impact, 0);
      const residual = cves.length - covered;
      if (residual > 0) {
        suggestions.push({
          category: 'manual',
          title: `剩余 ${residual} 条依赖漏洞需单独评估`,
          detail:
            '这些漏洞分散在低频组件中，无法用一次升级统一解决。' +
            '建议按「严重 / 高危」优先逐条复制给 AI，确认项目是否真正调用受影响的 API 后再决定是否升级。',
          impact: residual
        });
      }
    }
  }

  const leaks = result.issues.filter((issue) => issue.source === 'gitleaks');
  if (leaks.length > 0) {
    suggestions.push({
      category: 'secret',
      title: `硬编码密钥 ${leaks.length} 处`,
      detail:
        '先把密钥值轮换（已进入版本库即视为泄露），再迁移到环境变量或配置中心，' +
        '代码中只保留占位符。迁移完成前不要把密钥原值提交进任何分支。',
      impact: leaks.length
    });
  }

  const semantic = result.issues.filter(
    (issue) => issue.source === 'checkstyle' && !AUTO_FIXABLE_RULES.includes(issue.rule)
  );
  if (semantic.length > 0) {
    suggestions.push({
      category: 'manual',
      title: `${semantic.length} 项代码质量问题需要语义判断`,
      detail:
        `主要包括 ${cveSummary(semantic)}，改动虽小但要看上下文。` +
        '在面板中逐条点「复制」，把问题连同位置粘贴给 AI 处理，或人工确认后手动修改。',
      impact: semantic.length
    });
  }

  const defects = result.issues.filter((issue) => issue.source === 'spotbugs');
  if (defects.length > 0) {
    const security = defects.filter((issue) => issue.category === 'SECURITY');
    const high = defects.filter(
      (issue) => issue.severity === 'critical' || issue.severity === 'high'
    );
    suggestions.push({
      category: 'manual',
      title: `字节码级静态缺陷 ${defects.length} 项`,
      detail:
        (security.length > 0
          ? `其中 ${security.length} 项被 FindSecBugs 判定为安全风险（${cveSummary(security)}）。`
          : '') +
        (high.length > 0 ? `高危及以上 ${high.length} 项，建议优先处理。` : '') +
        '这类问题需要看调用上下文，可在「静态缺陷」页逐条复制给 AI 修复，修复后重新编译再扫描确认。',
      impact: defects.length
    });
  }

  return suggestions.sort((a, b) => b.impact - a.impact);
}
