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
}

interface TrivyReport {
  Results?: { Target?: string; Vulnerabilities?: TrivyVulnerability[] }[];
}

/** 国内网络下官方 ghcr.io 常不可达，失败时自动回退到 daocloud 镜像 */
const FALLBACK_DB = 'ghcr.m.daocloud.io/aquasecurity/trivy-db';
const FALLBACK_JAVA_DB = 'ghcr.m.daocloud.io/aquasecurity/trivy-java-db';

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
  javaDbRepository?: string
) {
  const args = [mode, '--format', 'json', '--quiet', '--scanners', 'vuln', '--timeout', '15m'];
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
  return run(exe, args, root, 900_000);
}

export async function scanTrivy(root: string, options: TrivyOptions): Promise<TrivyResult> {
  const exe = resolveBinary('trivy', options.executable);
  if (!exe) {
    return { issues: [], missing: true };
  }

  const version = await run(exe, ['--version'], root, 30_000);
  if (version.code !== 0) {
    return { issues: [], missing: true };
  }

  const { target, mode } = pickTarget(root, options.scanTarget);

  let result = await invoke(exe, mode, target, root, options.dbRepository, options.javaDbRepository);

  // 未显式配置仓库且首次失败时，自动回退到国内镜像；429 属于仓库限流，换镜像重试无意义
  const throttled = /429|too many requests/i.test(`${result.stderr}\n${result.stdout}`);
  const dbDownloadFailed = result.code !== 0 && !options.dbRepository && !throttled;
  if (dbDownloadFailed) {
    const retry = await invoke(exe, mode, target, root, FALLBACK_DB, FALLBACK_JAVA_DB);
    if (retry.code === 0) {
      result = retry;
    }
  }

  if (result.code !== 0) {
    if (throttled) {
      return {
        issues: [],
        mode,
        error:
          '依赖仓库限流（HTTP 429），已停止联网解析。请先在项目根目录执行 mvn package 生成 target 目录后重新扫描，' +
          '或等待约 30 分钟解除封禁；期间代码质量与密钥检查不受影响。'
      };
    }
    const detail = result.stderr.split(/\r?\n/).filter(Boolean).slice(-4).join('\n');
    const hint =
      mode === 'fs' ? '\n提示：先在项目里执行 mvn package 生成 target 目录，可避免联网解析依赖。' : '';
    return { issues: [], error: (detail || `trivy 退出码 ${result.code}`) + hint, mode };
  }

  let report: TrivyReport;
  try {
    report = JSON.parse(result.stdout) as TrivyReport;
  } catch (err) {
    return { issues: [], error: `解析 trivy 输出失败：${(err as Error).message}`, mode };
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
      issues.push({
        source: 'trivy',
        severity: toSeverity(vuln.Severity),
        file: hasFile ? candidate : undefined,
        rule: vuln.VulnerabilityID || 'CVE',
        message: `${vuln.PkgName || ''} ${vuln.InstalledVersion || ''} → ${
          fixed || '暂无修复版本'
        }：${vuln.Title || vuln.Description || ''}`.trim(),
        packageName: vuln.PkgName,
        installedVersion: vuln.InstalledVersion,
        fixedVersion: fixed,
        link: vuln.PrimaryURL
      });
    }
  }

  return { issues, mode: mode === 'rootfs' ? `target 目录（已构建产物）` : `项目根目录（源码解析）` };
}
