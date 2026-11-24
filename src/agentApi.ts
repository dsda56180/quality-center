/**
 * 给外部 agent 用的无界面扫描接口。
 *
 * 面板里那一套走的是 `ScanRunner`，它依赖 vscode API（工作区、配置、存储目录），
 * 无法在纯 Node 进程里跑。这里用同一批扫描器 + 同一套基线 / 建议逻辑，
 * 用一个显式传入的配置对象把「IDE 里的行为」复刻出来，供 CLI / MCP / SDK 调用。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exportForAgent, AgentExport } from './agentExport';
import { splitByBaseline } from './baseline';
import { resolveBinary } from './exec';
import { Issue, IssueSource, ScanResult, SEVERITY_LABEL, SEVERITY_ORDER, Severity } from './model';
import { resolveConfig, scanCheckstyle } from './scanners/checkstyle';
import { scanGitleaks } from './scanners/gitleaks';
import { scanQcsec } from './scanners/qcsec';
import { scanSpotbugs } from './scanners/spotbugs';
import { scanTrivy, TrivyOptions } from './scanners/trivy';
import { buildSuggestions } from './suggest';
import { EXTERNAL_TOOLS, installPlan, ToolId } from './tools';

/** 与 package.json 的默认值保持一致 */
const DEFAULT_ENABLED: Record<IssueSource, boolean> = {
  checkstyle: true,
  gitleaks: true,
  trivy: true,
  spotbugs: true,
  qcsec: true
};

export interface AgentScanOptions {
  root: string;
  /**
   * 扩展 / 包根目录：用来找内置的 checkstyle 规则与 gitleaks 规则。
   * CLI 在仓库根运行时传 `path.dirname(__dirname)`，装成扩展后就是扩展安装目录。
   */
  packageRoot: string;
  enabled?: Partial<Record<IssueSource, boolean>>;
  checkstyle?: { config?: string; mvn?: string };
  gitleaks?: { path?: string };
  trivy?: TrivyOptions;
  /** 中间报告目录，缺省 <root>/.quality-center/scans */
  outDir?: string;
  /** 是否写 .quality-center/issues.json 与 report.md，默认 true */
  exportFiles?: boolean;
  /** 进度回调，CLI 打到 stderr */
  onProgress?: (event: AgentScanEvent) => void;
  /** 供调用方决定是否继续（例如 Ctrl+C） */
  cancelled?: () => boolean;
}

export type AgentScanEvent =
  | { type: 'start'; source: IssueSource }
  | { type: 'done'; source: IssueSource; issues: number; skipped?: string; error?: string }
  | { type: 'finish' };

/** 从项目 .vscode/settings.json 读取 qualityCenter.* 配置，读不到就用默认值 */
export function loadProjectSettings(root: string): Record<string, unknown> {
  const candidates = [
    path.join(root, '.vscode', 'settings.json'),
    path.join(root, '.quality-center', 'settings.json')
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) {
      continue;
    }
    try {
      const raw = fs
        .readFileSync(file, 'utf8')
        // 允许 JSONC：去掉整行注释与尾逗号，够覆盖 .vscode/settings.json 的常见写法
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/,(\s*[}\]])/g, '$1');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const scoped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (key.startsWith('qualityCenter.')) {
          scoped[key.slice('qualityCenter.'.length)] = value;
        }
      }
      if (Object.keys(scoped).length > 0) {
        return scoped;
      }
    } catch {
      // 配置写坏了不影响 CLI，按默认值继续
    }
  }
  return {};
}

/** 用项目配置 + 显式覆盖，组装出一次扫描所需的全部参数 */
export function optionsFromProject(
  root: string,
  packageRoot: string,
  overrides: Partial<AgentScanOptions> = {}
): AgentScanOptions {
  const settings = loadProjectSettings(root);
  const bool = (key: string, fallback: boolean): boolean =>
    typeof settings[key] === 'boolean' ? (settings[key] as boolean) : fallback;
  const str = (key: string, fallback: string): string =>
    typeof settings[key] === 'string' ? (settings[key] as string) : fallback;

  const enabled: Record<IssueSource, boolean> = {
    checkstyle: bool('checkstyle.enabled', DEFAULT_ENABLED.checkstyle),
    gitleaks: bool('gitleaks.enabled', DEFAULT_ENABLED.gitleaks),
    trivy: bool('trivy.enabled', DEFAULT_ENABLED.trivy),
    spotbugs: bool('spotbugs.enabled', DEFAULT_ENABLED.spotbugs),
    qcsec: bool('qcsec.enabled', DEFAULT_ENABLED.qcsec),
    ...overrides.enabled
  };

  return {
    root,
    packageRoot,
    enabled,
    checkstyle: {
      config: overrides.checkstyle?.config ?? str('checkstyle.config', ''),
      mvn: overrides.checkstyle?.mvn
    },
    gitleaks: { path: overrides.gitleaks?.path ?? str('gitleaks.path', '') },
    trivy: {
      executable: overrides.trivy?.executable ?? str('trivy.path', ''),
      scanTarget: overrides.trivy?.scanTarget ?? str('trivy.scanTarget', ''),
      dbRepository: overrides.trivy?.dbRepository ?? str('trivy.dbRepository', ''),
      javaDbRepository: overrides.trivy?.javaDbRepository ?? str('trivy.javaDbRepository', ''),
      preferMirror: overrides.trivy?.preferMirror ?? bool('trivy.preferMirror', true),
      minSeverity: (overrides.trivy?.minSeverity ??
        (str('trivy.minSeverity', 'low') as Severity)) as Severity,
      onlyFixed: overrides.trivy?.onlyFixed ?? bool('trivy.onlyFixed', true)
    },
    outDir: overrides.outDir ?? path.join(root, '.quality-center', 'scans'),
    exportFiles: overrides.exportFiles ?? true,
    onProgress: overrides.onProgress,
    cancelled: overrides.cancelled
  };
}

/** 跑一遍五类扫描，返回与面板同构的 ScanResult（已按基线拆分） */
export async function runAgentScan(options: AgentScanOptions): Promise<ScanResult> {
  const root = options.root;
  const packageRoot = options.packageRoot;
  const enabled = { ...DEFAULT_ENABLED, ...options.enabled };
  const outDir = options.outDir ?? path.join(root, '.quality-center', 'scans');
  fs.mkdirSync(outDir, { recursive: true });

  const startedAt = Date.now();
  const issues: Issue[] = [];
  const errors: ScanResult['errors'] = [];
  const skipped: ScanResult['skipped'] = [];
  const missing = new Set<ToolId>();
  let buildHint: string | undefined;

  const skip = (source: IssueSource, reason: string, tool?: ToolId): void => {
    if (tool) {
      missing.add(tool);
    }
    skipped.push({ source, reason, tool });
    options.onProgress?.({ type: 'done', source, issues: 0, skipped: reason });
  };
  const emit = (source: IssueSource, result: { issues: Issue[]; error?: string }): void => {
    issues.push(...result.issues);
    if (result.error) {
      errors.push({ source, message: result.error });
    }
    options.onProgress?.({
      type: 'done',
      source,
      issues: result.issues.length,
      error: result.error
    });
  };

  const mvn = options.checkstyle?.mvn || resolveBinary('mvn');

  if (enabled.checkstyle) {
    if (!mvn) {
      skip('checkstyle', '未找到 mvn 可执行文件，Checkstyle 需要 Maven 才能运行', 'mvn');
    } else {
      const bundled = path.join(packageRoot, 'media', 'checkstyle-default.xml');
      const configPath = resolveConfig(root, options.checkstyle?.config ?? '', bundled);
      if (!configPath) {
        skip('checkstyle', '未找到 Checkstyle 规则文件');
      } else {
        options.onProgress?.({ type: 'start', source: 'checkstyle' });
        const result = await scanCheckstyle(
          root,
          configPath,
          path.join(outDir, 'checkstyle.xml'),
          mvn
        );
        emit('checkstyle', result);
      }
    }
  } else {
    skip('checkstyle', '已在配置中关闭');
  }

  if (enabled.gitleaks) {
    const localConfig = path.join(root, '.gitleaks.toml');
    const configFile = fs.existsSync(localConfig)
      ? localConfig
      : path.join(packageRoot, 'media', 'gitleaks.toml');
    options.onProgress?.({ type: 'start', source: 'gitleaks' });
    const result = await scanGitleaks(
      root,
      options.gitleaks?.path ?? '',
      path.join(outDir, 'gitleaks.json'),
      configFile
    );
    if (result.missing) {
      skip('gitleaks', '未找到 gitleaks 可执行文件', 'gitleaks');
    } else {
      emit('gitleaks', result);
    }
  } else {
    skip('gitleaks', '已在配置中关闭');
  }

  if (enabled.trivy) {
    options.onProgress?.({ type: 'start', source: 'trivy' });
    const result = await scanTrivy(root, {
      executable: options.trivy?.executable ?? '',
      scanTarget: options.trivy?.scanTarget ?? '',
      dbRepository: options.trivy?.dbRepository ?? '',
      javaDbRepository: options.trivy?.javaDbRepository ?? '',
      preferMirror: options.trivy?.preferMirror ?? true,
      minSeverity: options.trivy?.minSeverity ?? 'low',
      onlyFixed: options.trivy?.onlyFixed ?? true
    });
    if (result.missing) {
      skip('trivy', '未找到 trivy 可执行文件', 'trivy');
    } else {
      emit('trivy', result);
      if (result.usedBuildArtifacts === false && !result.error) {
        buildHint =
          '未找到构建产物（target 下没有 jar/pom），依赖清单基于源码解析，可能不完整；' +
          '先执行 `quality-center build` 再扫描可得准确结果。';
      }
    }
  } else {
    skip('trivy', '已在配置中关闭');
  }

  if (enabled.spotbugs) {
    if (!mvn) {
      skip('spotbugs', '未找到 mvn 可执行文件，SpotBugs 需要 Maven 才能运行', 'mvn');
    } else {
      options.onProgress?.({ type: 'start', source: 'spotbugs' });
      const result = await scanSpotbugs(root, mvn);
      if (result.needsBuild) {
        skip('spotbugs', '未找到 target/classes，需要先构建项目');
        buildHint =
          buildHint ??
          '未找到编译产物，SpotBugs 已跳过；先执行 `quality-center build` 再扫描可得完整结果。';
      } else {
        emit('spotbugs', result);
      }
    }
  } else {
    skip('spotbugs', '已在配置中关闭');
  }

  if (enabled.qcsec) {
    options.onProgress?.({ type: 'start', source: 'qcsec' });
    const result = await scanQcsec(root);
    emit('qcsec', result);
  } else {
    skip('qcsec', '已在配置中关闭');
  }

  issues.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const split = splitByBaseline(root, issues);
  const result: ScanResult = {
    startedAt,
    finishedAt: Date.now(),
    issues: split.active,
    ignored: split.ignored,
    errors,
    skipped,
    missingTools: missing.size > 0 ? Array.from(missing) : undefined,
    suggestions: [],
    buildHint
  };
  result.suggestions = buildSuggestions(root, result);

  if (options.exportFiles !== false) {
    try {
      exportForAgent(root, result);
    } catch {
      // 写文件失败不影响命令行输出
    }
  }

  options.onProgress?.({ type: 'finish' });
  return result;
}

export interface AgentSummary {
  total: number;
  [key: string]: number;
}

export function summarize(result: ScanResult): AgentSummary {
  const summary: AgentSummary = { total: result.issues.length };
  for (const severity of SEVERITY_ORDER) {
    summary[severity] = result.issues.filter((issue) => issue.severity === severity).length;
  }
  summary.ignored = result.ignored.length;
  for (const source of ['checkstyle', 'gitleaks', 'trivy', 'spotbugs', 'qcsec'] as const) {
    summary[source] = result.issues.filter((issue) => issue.source === source).length;
  }
  return summary;
}

/** 可确定性修复的规则：与 IDE 面板「一键修复」共用同一份定义 */
import { FIXABLE_RULES } from './fixerCore';

export interface AgentIssue {
  id: number;
  source: IssueSource;
  severity: Severity;
  severityLabel: string;
  rule: string;
  file: string;
  abs: string;
  line: number;
  column: number;
  message: string;
  zhSummary: string;
  advice: string;
  /** 面板「一键修复」能直接改的规则 */
  fixable: boolean;
  package: string;
  installedVersion: string;
  fixedVersion: string;
  cvss: number;
  cwe: string[];
  link: string;
}

/**
 * 给 agent 的稳定输出结构（schemaVersion 固定，字段只增不减）。
 * issues 里同时给相对路径与绝对路径：相对路径用于讲解，绝对路径用于直接编辑。
 */
export interface AgentPayload {
  schemaVersion: '2';
  generatedAt: string;
  projectRoot: string;
  summary: AgentSummary;
  issues: AgentIssue[];
  ignored: AgentIssue[];
  suggestions: ScanResult['suggestions'];
  errors: ScanResult['errors'];
  skipped: ScanResult['skipped'];
  missingTools: ToolId[];
  buildHint: string;
  /** 输出文件位置，便于 agent 二次读取 */
  files: { issuesJson?: string; reportMarkdown?: string };
  /** 给 agent 的下一步建议，避免它自己猜流程 */
  nextActions: string[];
}

export function buildPayload(result: ScanResult, root: string, files?: AgentExport): AgentPayload {
  const toIssue = (issue: Issue, index: number): AgentIssue => ({
    id: index + 1,
    source: issue.source,
    severity: issue.severity,
    severityLabel: SEVERITY_LABEL[issue.severity],
    rule: issue.rule,
    file: issue.file ? path.relative(root, issue.file).split(path.sep).join('/') : '',
    abs: issue.file ?? '',
    line: issue.line ?? 0,
    column: issue.column ?? 0,
    message: issue.message,
    zhSummary: issue.zhSummary ?? '',
    advice: issue.advice ?? '',
    fixable: FIXABLE_RULES.has(issue.rule),
    package: issue.packageName ?? '',
    installedVersion: issue.installedVersion ?? '',
    fixedVersion: issue.fixedVersion ?? '',
    cvss: issue.cvss ?? 0,
    cwe: issue.cwe ?? [],
    link: issue.link ?? ''
  });

  const missing = result.missingTools ?? [];
  const nextActions: string[] = [];
  if (missing.length > 0) {
    nextActions.push(
      `先安装缺失工具：${missing
        .map((id) => `quality-center tools install ${id}`)
        .join('、')}（装完会自动进入 PATH 或插件工具目录）`
    );
  }
  if (result.buildHint) {
    nextActions.push('执行 `quality-center build` 生成 target 产物后重扫，可补齐 SpotBugs 与依赖清单');
  }
  if (result.issues.some((issue) => FIXABLE_RULES.has(issue.rule))) {
    nextActions.push('存在可确定性修复的问题（fixable=true）：在 IDE 面板点「一键修复」，或按其 rule 直接改代码');
  }
  if (result.issues.some((issue) => issue.source === 'trivy' && issue.fixedVersion)) {
    nextActions.push('依赖漏洞给出 fixedVersion：按建议升级 pom（BOM/父 POM 需整组对齐），改完重扫确认');
  }
  if (result.ignored.length > 0) {
    nextActions.push('.quality-center/baseline.json 中已有忽略项，重扫不会重复计入统计');
  }
  if (nextActions.length === 0) {
    nextActions.push('当前没有需要处理的问题，可直接提交或进入评审');
  }

  return {
    schemaVersion: '2',
    generatedAt: new Date(result.finishedAt).toISOString(),
    projectRoot: root,
    summary: summarize(result),
    issues: result.issues.map(toIssue),
    ignored: result.ignored.map(toIssue),
    suggestions: result.suggestions,
    errors: result.errors,
    skipped: result.skipped,
    missingTools: missing,
    buildHint: result.buildHint ?? '',
    files: files ? { issuesJson: files.jsonPath, reportMarkdown: files.markdownPath } : {},
    nextActions
  };
}

export interface ToolStatus {
  id: ToolId;
  bin: string;
  label: string;
  purpose: string;
  found: boolean;
  path: string;
  /** 当前系统是否有可执行的自动安装方案 */
  installable: boolean;
  plan: string;
  docs: string;
}

export function toolStatuses(): ToolStatus[] {
  return (Object.keys(EXTERNAL_TOOLS) as ToolId[]).map((id) => {
    const tool = EXTERNAL_TOOLS[id];
    const found = resolveBinary(tool.bin);
    const plan = installPlan(tool);
    return {
      id,
      bin: tool.bin,
      label: tool.label,
      purpose: tool.purpose,
      found: !!found,
      path: found ?? '',
      installable: !!(plan.command || plan.script) && !plan.requiresRoot,
      plan: plan.describe,
      docs: tool.docs
    };
  });
}

/** 缺工具时给一句人话提示，CLI 与 MCP 共用 */
export function missingToolsHint(missing: ToolId[]): string {
  if (missing.length === 0) {
    return '';
  }
  return `${missing.join('、')} 未安装，可用 \`quality-center tools install <id>\` 自动安装`;
}

/** 让 CLI 在 CI 上判断是否该失败：按严重度阈值 */
export function exitCodeFor(result: ScanResult, failOn: Severity | 'none'): number {
  if (failOn === 'none') {
    return 0;
  }
  const gate = SEVERITY_ORDER.indexOf(failOn);
  if (gate < 0) {
    return 0;
  }
  const hit = result.issues.some((issue) => SEVERITY_ORDER.indexOf(issue.severity) <= gate);
  return hit ? 1 : 0;
}

/** 报告目录（与 IDE 缓存分离，避免互相覆盖） */
export function reportDir(root: string): string {
  return path.join(root, '.quality-center');
}

export function tmpScanDir(root: string): string {
  return path.join(os.tmpdir(), 'quality-center-cli', path.basename(root));
}
