import * as fs from 'fs';
import * as path from 'path';
import { Issue, Severity } from '../model';
import { resolveBinary, run } from '../exec';

export interface TrivyOptions {
  executable: string;
  /** 自定义扫描目标，留空则自动：优先 target 目录，其次项目根目录 */
  scanTarget?: string;
  dbRepository?: string;
  javaDbRepository?: string;
  /** 未显式配置仓库时优先使用国内镜像，默认 true */
  preferMirror?: boolean;
  /** 低于该等级的漏洞不显示，默认 low（全部显示） */
  minSeverity?: Severity;
  /** 只显示有修复版本的漏洞，默认 true */
  onlyFixed?: boolean;
}

export interface TrivyResult {
  issues: Issue[];
  error?: string;
  missing?: boolean;
  /** 实际使用的扫描模式，便于界面展示 */
  mode?: string;
  /** 扫描的是否为真实构建产物；false 表示退回源码解析，依赖清单可能不完整 */
  usedBuildArtifacts?: boolean;
}

interface TrivyVulnerability {
  VulnerabilityID?: string;
  PkgName?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Severity?: string;
  Title?: string;
  Description?: string;
  PrimaryURL?: string;
  CweIDs?: string[];
  References?: string[];
  PublishedDate?: string;
  CVSS?: Record<string, { V3Score?: number; V3Vector?: string; V2Score?: number; V2Vector?: string }>;
}

interface TrivyReport {
  Results?: { Target?: string; Vulnerabilities?: TrivyVulnerability[] }[];
}

/** 国内网络下官方 ghcr.io 常不可达，默认改用 daocloud 镜像 */
const FALLBACK_DB = 'ghcr.m.daocloud.io/aquasecurity/trivy-db';
const FALLBACK_JAVA_DB = 'ghcr.m.daocloud.io/aquasecurity/trivy-java-db';
/** 漏洞库在这个时间内视为新鲜，直接跳过更新检查，避免联网阻塞 */
const DB_FRESH_MS = 12 * 3600 * 1000;

/** 从 `trivy --version` 输出中解析某个库的本地下载时间 */
function dbDownloadedAt(text: string, block: string): number | undefined {
  const start = text.indexOf(block);
  if (start < 0) {
    return undefined;
  }
  const match = /DownloadedAt:\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/.exec(text.slice(start));
  if (!match) {
    return undefined;
  }
  const timestamp = Date.parse(`${match[1]}T${match[2]}Z`);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isFreshDb(text: string, block: string): boolean {
  const timestamp = dbDownloadedAt(text, block);
  return timestamp !== undefined && Date.now() - timestamp < DB_FRESH_MS;
}

function toSeverity(severity: string | undefined): Severity {
  switch ((severity || '').toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MEDIUM':
      return 'medium';
    case 'LOW':
      return 'low';
    default:
      return 'info';
  }
}

const SEVERITY_LABEL_ZH: Record<Severity, string> = {
  critical: '严重',
  high: '高危',
  medium: '中危',
  low: '低危',
  info: '提示'
};

function pickCvss(vuln: TrivyVulnerability): { score?: number; vector?: string } {
  const entries = Object.entries(vuln.CVSS || {});
  const v3 = entries
    .map(([, value]) => ({ score: value.V3Score, vector: value.V3Vector }))
    .filter((item) => typeof item.score === 'number')
    .sort((a, b) => (b.score as number) - (a.score as number));
  if (v3.length > 0) {
    return { score: v3[0].score, vector: v3[0].vector };
  }
  const v2 = entries
    .map(([, value]) => ({ score: value.V2Score, vector: value.V2Vector }))
    .filter((item) => typeof item.score === 'number');
  return v2.length > 0 ? { score: v2[0].score, vector: v2[0].vector } : {};
}

/** 把 CVSS 向量翻译成中文，避免整段描述都是英文 */
function describeVector(vector?: string): string {
  if (!vector) {
    return '';
  }
  const parts = new Map(
    vector.split('/').map((segment) => {
      const [key, value] = segment.split(':');
      return [key, value];
    })
  );
  const attack = { N: '可远程网络攻击', A: '需同一局域网', L: '需本地访问', P: '需物理接触' }[
    parts.get('AV') || ''
  ];
  const privilege = { N: '无需认证', L: '需普通账号权限', H: '需管理员权限' }[parts.get('PR') || ''];
  const interaction = { N: '无需用户交互', R: '需用户交互' }[parts.get('UI') || ''];
  const impacts: string[] = [];
  if ((parts.get('C') || 'N') !== 'N') {
    impacts.push('机密性');
  }
  if ((parts.get('I') || 'N') !== 'N') {
    impacts.push('完整性');
  }
  if ((parts.get('A') || 'N') !== 'N') {
    impacts.push('可用性');
  }
  const impact = impacts.length > 0 ? `影响${impacts.join('/')}` : '';
  return [attack, privilege, interaction, impact].filter(Boolean).join('，');
}

function buildZhSummary(
  vuln: TrivyVulnerability,
  severity: Severity,
  score?: number,
  vector?: string
): string {
  const parts: string[] = [];
  parts.push(
    `${vuln.PkgName || ''} ${vuln.InstalledVersion || ''} 命中${SEVERITY_LABEL_ZH[severity]}漏洞`
  );
  if (typeof score === 'number') {
    parts.push(`CVSS ${score}`);
  }
  const described = describeVector(vector);
  if (described) {
    parts.push(described);
  }
  return `${parts.join('，')}。`;
}

function buildAdvice(vuln: TrivyVulnerability): string {
  const fixed = vuln.FixedVersion || '';
  if (!fixed) {
    return (
      '官方暂未发布修复版本。建议确认项目是否真正使用受影响功能，' +
      '采取隔离、访问控制或关闭相关端点等缓解措施，并持续关注上游更新。'
    );
  }
  return (
    `升级到 ${fixed}。若是传递依赖，可在 <dependencyManagement> 中显式声明该版本覆盖；` +
    '若受框架 BOM 锁定，需整体升级框架版本。无法立即升级时，请确认是否启用受影响功能，' +
    '必要时关闭相关端点或限制访问来源。'
  );
}

function truncate(text: string | undefined, limit: number): string {
  const value = (text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

const SEVERITY_RANK_RAW: Record<string, number> = {
  UNKNOWN: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4
};

/** 判断目录是否是真实的构建产物（含 jar/pom），避免只残留 site、cachefile 的空 target 被误用 */
function hasBuildArtifacts(dir: string): boolean {
  try {
    const stack: { path: string; depth: number }[] = [{ path: dir, depth: 0 }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of fs.readdirSync(current.path, { withFileTypes: true })) {
        if (entry.isFile() && /\.(jar|pom)$/i.test(entry.name)) {
          return true;
        }
        if (entry.isDirectory() && current.depth < 2) {
          stack.push({ path: path.join(current.path, entry.name), depth: current.depth + 1 });
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

function pickTarget(root: string, configured?: string): { target: string; mode: 'rootfs' | 'fs' } {
  if (configured) {
    const target = path.isAbsolute(configured) ? configured : path.join(root, configured);
    const usable = fs.existsSync(target) && fs.statSync(target).isDirectory() && hasBuildArtifacts(target);
    return { target: usable ? target : root, mode: usable ? 'rootfs' : 'fs' };
  }
  const buildDir = path.join(root, 'target');
  if (fs.existsSync(buildDir) && hasBuildArtifacts(buildDir)) {
    return { target: buildDir, mode: 'rootfs' };
  }
  return { target: root, mode: 'fs' };
}

async function invoke(
  exe: string,
  mode: 'rootfs' | 'fs',
  target: string,
  root: string,
  dbRepository?: string,
  javaDbRepository?: string,
  skip?: { vuln: boolean; java: boolean }
) {
  const args = [mode, '--format', 'json', '--quiet', '--scanners', 'vuln', '--timeout', '4m'];
  // 本地漏洞库还新鲜时不要检查更新：连不上 ghcr.io 会让扫描阻塞数分钟
  if (skip?.vuln) {
    args.push('--skip-db-update');
  }
  if (skip?.java) {
    args.push('--skip-java-db-update');
  }
  if (dbRepository) {
    args.push('--db-repository', dbRepository);
  }
  if (javaDbRepository) {
    args.push('--java-db-repository', javaDbRepository);
  }
  if (mode === 'fs') {
    args.push('--skip-dirs', '.git', '--skip-dirs', 'node_modules');
    // 源码模式下 trivy 会联网向 Maven 中央仓库解析 pom 依赖，公共网络下极易触发 429 限流。
    // 加 --offline-scan 后只用本地缓存与本地文件，不再发起任何 API 请求。
    args.push('--offline-scan');
  }
  args.push(target);
  // cwd 设为项目根目录：trivy 自动加载根目录的 .trivyignore 忽略清单
  return run(exe, args, root, 300_000);
}

/**
 * 后台更新漏洞库（不阻塞扫描）。国内镜像本身可达，但漏洞库体积很大（解压后约 1.8GB），
 * 下载通常需要数分钟，只能放到扫描结束后在后台做。
 */
async function refreshDb(
  exe: string,
  root: string,
  repository: string | undefined,
  flag: '--download-db-only' | '--download-java-db-only'
): Promise<void> {
  const args = ['rootfs', flag, '--quiet'];
  if (repository) {
    args.push(flag === '--download-db-only' ? '--db-repository' : '--java-db-repository', repository);
  }
  await run(exe, args, root, 10 * 60_000);
}

/** 本进程内最近一次尝试更新漏洞库的时间：6 小时内不再重试，避免每次扫描都触发一次大文件下载 */
let lastDbRefresh = 0;
const DB_REFRESH_RETRY_MS = 6 * 3600 * 1000;

export async function scanTrivy(root: string, options: TrivyOptions): Promise<TrivyResult> {
  const exe = resolveBinary('trivy', options.executable);
  if (!exe) {
    return { issues: [], missing: true };
  }

  const version = await run(exe, ['--version'], root, 30_000);
  if (version.code !== 0) {
    return { issues: [], missing: true };
  }

  // 本地库 12 小时内下载过就直接跳过更新检查，避免 ghcr.io 不可达时长时间等待
  const versionText = `${version.stdout}\n${version.stderr}`;
  const stale = {
    vuln: !isFreshDb(versionText, 'Vulnerability DB'),
    java: !isFreshDb(versionText, 'Java DB')
  };

  const { target, mode } = pickTarget(root, options.scanTarget);
  const useMirror = options.preferMirror !== false;
  const dbRepository = options.dbRepository || (useMirror ? FALLBACK_DB : undefined);
  const javaDbRepository = options.javaDbRepository || (useMirror ? FALLBACK_JAVA_DB : undefined);

  // 扫描阶段一律离线使用本地库，绝不等待数据库下载
  const result = await invoke(exe, mode, target, root, dbRepository, javaDbRepository, {
    vuln: true,
    java: true
  });

  // 扫描结束后再在后台更新过期库，下次扫描自动使用新数据
  if ((stale.vuln || stale.java) && Date.now() - lastDbRefresh > DB_REFRESH_RETRY_MS) {
    lastDbRefresh = Date.now();
    if (stale.vuln) {
      void refreshDb(exe, root, dbRepository, '--download-db-only');
    }
    if (stale.java) {
      void refreshDb(exe, root, javaDbRepository, '--download-java-db-only');
    }
  }

  const throttled = /429|too many requests/i.test(`${result.stderr}\n${result.stdout}`);
  if (result.code !== 0) {
    if (throttled) {
      return {
        issues: [],
        mode,
        usedBuildArtifacts: mode === 'rootfs',
        error:
          '依赖仓库限流（HTTP 429），已停止联网解析。请先在项目根目录执行 mvn package 生成 target 目录后重新扫描，' +
          '或等待约 30 分钟解除封禁；期间代码质量与密钥检查不受影响。'
      };
    }
    const detail = result.stderr.split(/\r?\n/).filter(Boolean).slice(-4).join('\n');
    const networkIssue = /download|connect|timeout|deadline|no such host/i.test(
      `${result.stderr}\n${result.stdout}`
    );
    const hint = networkIssue
      ? '\n提示：漏洞库下载/更新失败，通常是网络无法访问 ghcr.io。可保持 trivy.preferMirror 开启，' +
        '或在终端执行 trivy --download-db-only --db-repository ghcr.m.daocloud.io/aquasecurity/trivy-db 预热本地库。'
      : mode === 'fs'
        ? '\n提示：先在项目里执行 mvn package 生成 target 目录，可避免联网解析依赖。'
        : '';
    return {
      issues: [],
      error: (detail || `trivy 退出码 ${result.code}`) + hint,
      mode,
      usedBuildArtifacts: mode === 'rootfs'
    };
  }

  let report: TrivyReport;
  try {
    report = JSON.parse(result.stdout) as TrivyReport;
  } catch (err) {
    return {
      issues: [],
      error: `解析 trivy 输出失败：${(err as Error).message}`,
      mode,
      usedBuildArtifacts: mode === 'rootfs'
    };
  }

  const issues: Issue[] = [];
  const seen = new Set<string>();
  const minRank = SEVERITY_RANK[(options.minSeverity || 'low').toLowerCase()] ?? 1;
  const onlyFixed = options.onlyFixed !== false;

  for (const section of report.Results || []) {
    for (const vuln of section.Vulnerabilities || []) {
      const rawRank = SEVERITY_RANK_RAW[(vuln.Severity || '').toUpperCase()] ?? 0;
      if (rawRank < minRank) {
        continue;
      }
      if (onlyFixed && !vuln.FixedVersion) {
        continue;
      }
      // 按 CVE + 组件去重（同一组件可能出现在多个路径）
      const key = `${vuln.VulnerabilityID}|${vuln.PkgName}|${vuln.InstalledVersion}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const sectionTarget = section.Target || '';
      const candidate = sectionTarget ? path.resolve(target, sectionTarget) : '';
      const hasFile = candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
      const fixed = vuln.FixedVersion || '';
      const severity = toSeverity(vuln.Severity);
      const { score, vector } = pickCvss(vuln);
      issues.push({
        source: 'trivy',
        severity,
        file: hasFile ? candidate : undefined,
        rule: vuln.VulnerabilityID || 'CVE',
        message: truncate(vuln.Title || vuln.Description, 200) || vuln.VulnerabilityID || 'CVE',
        packageName: vuln.PkgName,
        installedVersion: vuln.InstalledVersion,
        fixedVersion: fixed,
        link: vuln.PrimaryURL,
        zhSummary: buildZhSummary(vuln, severity, score, vector),
        advice: buildAdvice(vuln),
        title: truncate(vuln.Title, 300),
        description: truncate(vuln.Description, 800),
        cvss: score,
        cvssVector: vector,
        cwe: (vuln.CweIDs || []).slice(0, 5),
        references: (vuln.References || []).slice(0, 3),
        publishedAt: vuln.PublishedDate
      });
    }
  }

  return {
    issues,
    mode: mode === 'rootfs' ? `target 目录（已构建产物）` : `项目根目录（源码解析）`,
    usedBuildArtifacts: mode === 'rootfs'
  };
}
