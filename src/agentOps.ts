/**
 * CLI 与 MCP 共用的操作层：把「扫描 / 构建 / 工具 / 报告 / 修复」做成返回纯数据的函数，
 * 由 cli.ts（人读 + 退出码）和 mcp.ts（JSON-RPC 工具）各自做展示，
 * 保证同一条能力不会在两处实现出不同行为。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  AgentPayload,
  AgentScanEvent,
  buildPayload,
  exitCodeFor,
  optionsFromProject,
  runAgentScan,
  ToolStatus,
  toolStatuses
} from './agentApi';
import { resolveBinary, runStreaming, stripAnsi } from './exec';
import { applyFixesToContent, FIXABLE_RULES } from './fixerCore';
import { Issue, IssueSource, ScanResult, Severity } from './model';
import { EXTERNAL_TOOLS, installLocation, installPlan, ToolId } from './tools';
import { loadPolicy } from './upgradePolicy';
import { readRunState, recordBuild as recordRunBuild, recordFix as recordRunFix, recordScan as recordRunScan } from './runState';
import { ensureScanBaseline } from './scanDigest';

export const PACKAGE_ROOT = path.resolve(__dirname, '..');

export const SOURCES: IssueSource[] = ['checkstyle', 'gitleaks', 'trivy', 'spotbugs', 'qcsec', 'astgrep'];
export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 解析 --fail-on：非法取值返回 undefined */
export function parseFailOn(raw?: string): Severity | 'none' | undefined {
  const value = raw ?? 'high';
  if (value === 'none') {
    return 'none';
  }
  return SEVERITIES.includes(value as Severity) ? (value as Severity) : undefined;
}

/** 解析 --only：非法扫描器名返回 undefined */
export function parseOnly(raw?: string): IssueSource[] | undefined {
  if (!raw) {
    return undefined;
  }
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const unknown = items.filter((item) => !SOURCES.includes(item as IssueSource));
  if (unknown.length > 0) {
    return undefined;
  }
  return items as IssueSource[];
}

export interface ScanRequest {
  root: string;
  only?: IssueSource[];
  failOn?: Severity | 'none';
  outDir?: string;
  exportFiles?: boolean;
  /** 规则静音，覆盖配置里的 qualityCenter.rules.mute */
  mute?: string[];
  /** 同文件聚合（medium 及以下） */
  aggregate?: boolean;
  /** 内部预检（例如修复前只扫 checkstyle）不要记录运行状态/基线 */
  recordRun?: boolean;
  onProgress?: (event: AgentScanEvent) => void;
}

export interface ScanOutcome {
  result: ScanResult;
  payload: AgentPayload;
  /** 0 通过 / 1 达到阈值 / 2 缺工具 */
  exitCode: number;
  seconds: number;
}

export async function scanProject(request: ScanRequest): Promise<ScanOutcome> {
  const enabled: Partial<Record<IssueSource, boolean>> = {};
  if (request.only && request.only.length > 0) {
    for (const source of SOURCES) {
      enabled[source] = request.only.includes(source);
    }
  }
  const options = optionsFromProject(request.root, PACKAGE_ROOT, {
    enabled,
    outDir: request.outDir,
    exportFiles: request.exportFiles ?? true,
    mute: request.mute,
    aggregate: request.aggregate,
    onProgress: request.onProgress
  });

  const result = await runAgentScan(options);
  const exported =
    request.exportFiles === false
      ? undefined
      : {
          dir: path.join(request.root, '.quality-center'),
          jsonPath: path.join(request.root, '.quality-center', 'issues.json'),
          markdownPath: path.join(request.root, '.quality-center', 'report.md'),
          sarifPath: path.join(request.root, '.quality-center', 'report.sarif')
        };
  const payload = buildPayload(result, request.root, exported);
  const exitCode = payload.missingTools.length > 0 ? 2 : exitCodeFor(result, request.failOn ?? 'high');
  const runState = readRunState(request.root);
  if (request.recordRun !== false && runState && runState.status !== 'done') {
    ensureScanBaseline(request.root, payload);
    recordRunScan(request.root, {
      generatedAt: payload.generatedAt,
      total: payload.issues.length,
      bySource: Object.fromEntries(SOURCES.map((source) => [source, Number(payload.summary[source] ?? 0)]))
    });
  }
  return {
    result,
    payload,
    exitCode,
    seconds: (result.finishedAt - result.startedAt) / 1000
  };
}

export interface BuildError {
  file: string;
  line: number;
  column?: number;
  message: string;
}

export interface TestSummary {
  state: 'executed' | 'skipped' | 'none';
  total: number;
  failures: number;
  errors: number;
  skipped: number;
}

export interface BuildOutcome {
  ok: boolean;
  code: number;
  seconds: number;
  jars: string[];
  /** 失败时的末尾几行原因（已过滤进度条与 ANSI） */
  tail: string;
  /** 从完整输出解析出的编译错误（文件/行号/列/消息），AI 不用自己扒日志 */
  errors?: BuildError[];
  /** 完整构建日志落盘位置 */
  logFile?: string;
  /** 本次实际使用的门禁（compile / package / test） */
  gate?: string;
  /** 测试是否真的执行；skipped 时不能把构建成功当作测试通过 */
  tests?: TestSummary;
  /** pom 已偏离活动计划时拒绝构建，防止手工改 pom 被“构建成功”洗白 */
  drift?: boolean;
  planId?: string;
}

/** 把 Maven 输出拆成结构化编译错误，便于定向修复 */
export function parseBuildErrors(text: string, limit = 20): BuildError[] {
  const errors: BuildError[] = [];
  const pattern = /\[ERROR\]\s+([^\s\[]+\.java):\[(\d+)(?:,(\d+))?\]\s*(.*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null && errors.length < limit) {
    errors.push({
      file: match[1],
      line: Number.parseInt(match[2], 10),
      column: match[3] ? Number.parseInt(match[3], 10) : undefined,
      message: match[4]?.trim() ?? ''
    });
  }
  return errors;
}

export function artifactJars(root: string): string[] {
  const target = path.join(root, 'target');
  if (!fs.existsSync(target)) {
    return [];
  }
  return fs
    .readdirSync(target)
    .filter(
      (name) =>
        name.endsWith('.jar') &&
        !/-sources\.jar$/.test(name) &&
        !/-javadoc\.jar$/.test(name) &&
        !name.startsWith('original-')
    );
}

export function tailLines(stdout: string, stderr: string, count = 6): string {
  return stripAnsi(stderr || stdout)
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^[#.\s|-]+$/.test(line))
    .slice(-count)
    .join('\n');
}

/** 项目 pom 的当前哈希：构建台账用它判断「这次结果是不是针对当前 pom」 */
function pomHashOf(root: string): string {
  try {
    const text = fs.readFileSync(path.join(root, 'pom.xml'), 'utf8');
    return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
  } catch {
    return '';
  }
}

/** 每次构建都把结果写进 build-result.json：成功也写，避免 next 只能靠 build.log 的时间猜 */
function recordBuild(root: string, outcome: BuildOutcome, gate: string, args: string[]): BuildOutcome {
  try {
    const file = path.join(root, '.quality-center', 'build-result.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify(
        {
          ok: outcome.ok,
          code: outcome.code,
          at: new Date().toISOString(),
          seconds: Number(outcome.seconds.toFixed(2)),
          pomHash: pomHashOf(root),
          gate,
          args,
          planId: outcome.planId,
          drift: outcome.drift === true,
          tests: outcome.tests,
          logFile: outcome.logFile ? path.relative(root, outcome.logFile) : undefined
        },
        null,
        2
      )}\n`,
      'utf8'
    );
  } catch {
    // 台账写不进去不影响构建本身
  }
  recordRunBuild(root, {
    ok: outcome.ok,
    planId: outcome.planId,
    drift: outcome.drift === true,
    tests: outcome.tests?.state,
    seconds: outcome.seconds,
    gate
  });
  return outcome;
}

/** 读 surefire 报告，确定测试到底跑了没有 */
function readTestSummary(root: string, expectedSkip: boolean): TestSummary {
  if (expectedSkip) {
    return { state: 'skipped', total: 0, failures: 0, errors: 0, skipped: 0 };
  }
  const dir = path.join(root, 'target', 'surefire-reports');
  if (!fs.existsSync(dir)) {
    return { state: 'none', total: 0, failures: 0, errors: 0, skipped: 0 };
  }
  let total = 0;
  let failures = 0;
  let errors = 0;
  let skipped = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.xml')) {
      continue;
    }
    try {
      const xml = fs.readFileSync(path.join(dir, entry.name), 'utf8').slice(0, 4000);
      const attr = (name: string): number => {
        const match = new RegExp(`\\b${name}="(\\d+)"`).exec(xml);
        return match ? Number(match[1]) : 0;
      };
      total += attr('tests');
      failures += attr('failures');
      errors += attr('errors');
      skipped += attr('skipped');
    } catch {
      // 单个报告坏掉不影响整体
    }
  }
  return { state: total > 0 || failures > 0 || errors > 0 ? 'executed' : 'none', total, failures, errors, skipped };
}

/** 执行构建门禁；门禁级别与 mavenArgs 来自 .quality-center/upgrade-policy.json */
export async function buildProject(
  root: string,
  onLine?: (line: string) => void
): Promise<BuildOutcome> {
  const loaded = loadPolicy(root);
  const gate = loaded.policy.buildGate;
  const goal = gate === 'compile' ? 'compile' : gate === 'test' ? 'test' : 'package';
  const testsEnabled = loaded.policy.runTests && goal !== 'compile';
  const args = ['-B', ...loaded.policy.mavenArgs];
  if (testsEnabled) {
    // 项目 pom 可能自己写了 maven.test.skip=true，必须显式覆盖
    args.push('-Dmaven.test.skip=false', '-DskipTests=false');
  } else {
    args.push('-DskipTests');
  }
  args.push(goal);
  if (testsEnabled) {
    // 先清掉上一轮 surefire，避免旧报告把“本次没跑测试”伪装成 executed
    try {
      fs.rmSync(path.join(root, 'target', 'surefire-reports'), { recursive: true, force: true });
    } catch {
      // target 不可写时交给构建本身报错
    }
  }

  let planId: string | undefined;
  let drift = false;
  try {
    const { checkUpgradePlan } = await import('./upgradePlanFile');
    const check = checkUpgradePlan(root);
    planId = check.planId;
    drift = check.state === 'drift';
  } catch {
    // 没有计划：普通构建
  }
  if (drift) {
    return recordBuild(
      root,
      {
        ok: false,
        code: 2,
        seconds: 0,
        jars: [],
        tail: `pom 已偏离活动计划 ${planId ?? ''}：拒绝构建，先 upgrade check / revert / plan --replace`,
        gate,
        drift: true,
        planId,
        tests: readTestSummary(root, !testsEnabled)
      },
      gate,
      args
    );
  }

  const mvn = resolveBinary('mvn');
  if (!mvn) {
    return recordBuild(
      root,
      {
        ok: false,
        code: 2,
        seconds: 0,
        jars: [],
        tail: '没有找到 mvn，先执行 tools install mvn',
        gate,
        drift,
        planId,
        tests: readTestSummary(root, !testsEnabled)
      },
      gate,
      args
    );
  }
  const startedAt = Date.now();
  const handle = runStreaming(mvn, args, root, 30 * 60_000, {
    onLine: (line) => {
      if (onLine) {
        onLine(stripAnsi(line));
      }
    }
  });
  const outcome = await handle.result;
  const seconds = (Date.now() - startedAt) / 1000;
  if (outcome.code !== 0) {
    const full = stripAnsi([outcome.stdout, outcome.stderr].filter(Boolean).join('\n'));
    const errors = parseBuildErrors(full);
    let logFile: string | undefined;
    try {
      const dir = path.join(root, '.quality-center');
      fs.mkdirSync(dir, { recursive: true });
      logFile = path.join(dir, 'build.log');
      // 超大日志只留尾部，避免把磁盘写爆
      const kept = full.length > 2 * 1024 * 1024 ? full.slice(-2 * 1024 * 1024) : full;
      fs.writeFileSync(logFile, kept, 'utf8');
    } catch {
      logFile = undefined;
    }
    return recordBuild(
      root,
      {
        ok: false,
        code: outcome.code,
        seconds,
        jars: [],
        tail: tailLines(outcome.stdout, outcome.stderr, 8),
        errors,
        logFile,
        gate,
        drift,
        planId,
        tests: readTestSummary(root, !testsEnabled)
      },
      gate,
      args
    );
  }
  return recordBuild(
    root,
    {
      ok: true,
      code: 0,
      seconds,
      jars: artifactJars(root),
      tail: '',
      gate,
      drift,
      planId,
      tests: readTestSummary(root, !testsEnabled)
    },
    gate,
    args
  );
}

export interface ToolsStatusPayload {
  schemaVersion: '2';
  tools: ToolStatus[];
}

export function toolsStatusPayload(): ToolsStatusPayload {
  return { schemaVersion: '2', tools: toolStatuses() };
}

export interface InstallOutcome {
  ok: boolean;
  tool: ToolId;
  label: string;
  message: string;
  /** 安装后解析到的可执行文件路径 */
  path?: string;
  /** 需要管理员权限，未执行 */
  requiresRoot?: boolean;
}

/** 无界面安装：需要 root 的只返回命令，不执行 */
export async function installToolHeadless(
  id: ToolId,
  cwd: string,
  onLine?: (line: string) => void
): Promise<InstallOutcome> {
  const tool = EXTERNAL_TOOLS[id];
  if (!tool) {
    return { ok: false, tool: id, label: id, message: `未知工具：${id}` };
  }
  const plan = installPlan(tool);
  if (plan.requiresRoot) {
    return {
      ok: false,
      tool: id,
      label: tool.label,
      requiresRoot: true,
      message: `${tool.label} 需要管理员权限，未自动执行。请在终端手动运行：\n${plan.command ?? plan.hint}`
    };
  }
  if (!plan.command && !plan.script) {
    return {
      ok: false,
      tool: id,
      label: tool.label,
      message: `${tool.label} 需要手动安装：${plan.hint}\n${tool.docs}`
    };
  }

  const found = resolveBinary(tool.bin);
  if (found) {
    return {
      ok: true,
      tool: id,
      label: tool.label,
      path: found,
      message: `${tool.bin} 已存在：${found}`
    };
  }

  let command = plan.command ?? '';
  let cleanupDir: string | undefined;
  if (!plan.command && plan.script) {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'quality-center-cli-'));
    cleanupDir = dir;
    const file = path.join(dir, plan.scriptShell === 'powershell' ? 'install.ps1' : 'install.sh');
    // PowerShell 5.1 无 BOM 时按 ANSI 解析，中文会破坏引号
    const body = plan.scriptShell === 'powershell' ? `\uFEFF${plan.script}` : plan.script;
    fs.writeFileSync(file, body, 'utf8');
    command =
      plan.scriptShell === 'powershell'
        ? `"${path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${file}"`
        : `bash "${file}"`;
  }

  const handle = runStreaming(command, [], cwd, 15 * 60_000, {
    onLine: (line) => {
      if (onLine) {
        onLine(stripAnsi(line));
      }
    }
  });
  const outcome = await handle.result;
  if (cleanupDir) {
    try {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响结果
    }
  }

  const resolved = resolveBinary(tool.bin);
  if (outcome.code === 0 || resolved) {
    return {
      ok: true,
      tool: id,
      label: tool.label,
      path: resolved,
      message: `已安装 ${tool.label}${resolved ? `：${resolved}` : `（目标目录 ${installLocation(tool, plan) ?? '见日志'}）`}`
    };
  }
  return {
    ok: false,
    tool: id,
    label: tool.label,
    message: `安装失败（退出码 ${outcome.code}）：\n${tailLines(outcome.stdout, outcome.stderr, 5) || plan.describe}`
  };
}

export type ReportFormat = 'summary' | 'json' | 'markdown';

export interface ReportOutcome {
  ok: boolean;
  format: ReportFormat;
  text: string;
  file?: string;
}

export function readReport(root: string, format: ReportFormat): ReportOutcome {
  const jsonFile = path.join(root, '.quality-center', 'issues.json');
  const mdFile = path.join(root, '.quality-center', 'report.md');
  if (format === 'markdown') {
    if (!fs.existsSync(mdFile)) {
      return { ok: false, format, text: `还没有报告：${mdFile}，先执行 scan` };
    }
    return { ok: true, format, file: mdFile, text: fs.readFileSync(mdFile, 'utf8') };
  }
  if (!fs.existsSync(jsonFile)) {
    return { ok: false, format, text: `还没有结构化结果：${jsonFile}，先执行 scan` };
  }
  const raw = fs.readFileSync(jsonFile, 'utf8');
  if (format === 'json') {
    return { ok: true, format, file: jsonFile, text: raw };
  }
  let summary: Record<string, number> = { total: 0 };
  try {
    summary = (JSON.parse(raw) as { summary?: Record<string, number> }).summary ?? summary;
  } catch {
    // 文件损坏时只报总数
  }
  const pairs = SEVERITIES.map((severity) => `${severity} ${summary[severity] ?? 0}`).join(' / ');
  return {
    ok: true,
    format,
    file: jsonFile,
    text: `${jsonFile}\n共 ${summary.total ?? 0} 个问题（${pairs}）`
  };
}

export interface FileFix {
  /** 绝对路径 */
  file: string;
  /** 相对项目根，便于展示 */
  rel: string;
  applied: number;
  skipped: number;
  changes: { line: number; rule: string; kind: 'replace' | 'delete' }[];
}

export interface FixOutcome {
  mode: 'dry-run' | 'write';
  /** 命中可确定性修复规则的问题数 */
  targets: number;
  applied: number;
  skipped: number;
  files: FileFix[];
  /** 拍平后的提示，例如没有可修项 */
  note: string;
  /** 写入后的审计目录；dry-run 没有 */
  fixId?: string;
  auditFile?: string;
}

interface FixFileRecord {
  file: string;
  rel: string;
  beforeCopy: string;
  beforeHash: string;
  afterHash: string;
  applied: number;
  skipped: number;
  changes: { line: number; rule: string; kind: 'replace' | 'delete' }[];
}

interface FixAudit {
  fixId: string;
  at: string;
  mode: 'write';
  applied: number;
  skipped: number;
  files: FixFileRecord[];
}

function hashText(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** 只做审计用的行级差异摘要，不替代 git diff，但能看出改了哪几行 */
function renderPatch(rel: string, before: string, after: string): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const lines = [`--- a/${rel}`, `+++ b/${rel}`];
  const max = Math.max(beforeLines.length, afterLines.length);
  let changed = 0;
  for (let index = 0; index < max && changed < 40; index += 1) {
    const oldLine = beforeLines[index];
    const newLine = afterLines[index];
    if (oldLine === newLine) {
      continue;
    }
    changed += 1;
    lines.push(`@@ ${index + 1} @@`);
    if (oldLine !== undefined) {
      lines.push(`-${oldLine}`);
    }
    if (newLine !== undefined) {
      lines.push(`+${newLine}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function absoluteIssueFile(root: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(root, file);
}

/**
 * 应用确定性修复（删无用导入 / 调整修饰符顺序 / 简化布尔比较）。
 * write=false 只预览，不落盘。
 */
export async function fixProject(
  root: string,
  write: boolean,
  onProgress?: (event: AgentScanEvent) => void
): Promise<FixOutcome> {
  const scan = await scanProject({
    root,
    only: ['checkstyle'],
    exportFiles: false,
    failOn: 'none',
    recordRun: false,
    onProgress
  });
  const targets = scan.result.issues.filter(
    (issue: Issue) => FIXABLE_RULES.has(issue.rule) && issue.file && (issue.line ?? 0) > 0
  );

  const byFile = new Map<string, Issue[]>();
  for (const issue of targets) {
    const key = absoluteIssueFile(root, issue.file as string);
    const list = byFile.get(key) ?? [];
    list.push(issue);
    byFile.set(key, list);
  }

  const files: FileFix[] = [];
  const records: FixFileRecord[] = [];
  let applied = 0;
  let skipped = 0;
  const fixId = `fix-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  const fixDir = path.join(root, '.quality-center', 'fix', fixId);

  for (const [file, list] of byFile) {
    if (!fs.existsSync(file)) {
      skipped += list.length;
      continue;
    }
    const original = fs.readFileSync(file, 'utf8');
    const outcome = applyFixesToContent(original, list);
    applied += outcome.applied;
    skipped += outcome.skipped;
    if (outcome.applied === 0) {
      continue;
    }
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (write) {
      const before = path.join(fixDir, 'before', rel);
      fs.mkdirSync(path.dirname(before), { recursive: true });
      fs.writeFileSync(before, original, 'utf8');
      fs.writeFileSync(path.join(fixDir, 'patches', `${rel.replace(/[\\/]/g, '__')}.patch`), renderPatch(rel, original, outcome.content), 'utf8');
      fs.writeFileSync(file, outcome.content, 'utf8');
      records.push({
        file,
        rel,
        beforeCopy: path.relative(root, before).split(path.sep).join('/'),
        beforeHash: hashText(original),
        afterHash: hashText(outcome.content),
        applied: outcome.applied,
        skipped: outcome.skipped,
        changes: outcome.changes
      });
    }
    files.push({
      file,
      rel,
      applied: outcome.applied,
      skipped: outcome.skipped,
      changes: outcome.changes
    });
  }

  if (write && records.length > 0) {
    const audit: FixAudit = {
      fixId,
      at: new Date().toISOString(),
      mode: 'write',
      applied,
      skipped,
      files: records
    };
    const auditFile = path.join(fixDir, 'fix-result.json');
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.writeFileSync(auditFile, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(root, '.quality-center', 'fix-result.json'), `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
  }

  recordRunFix(root, {
    applied,
    skipped,
    files: files.length,
    mode: write ? 'write' : 'dry-run',
    fixId: write && records.length > 0 ? fixId : undefined
  });
  return {
    mode: write ? 'write' : 'dry-run',
    targets: targets.length,
    applied,
    skipped,
    files,
    fixId: write && records.length > 0 ? fixId : undefined,
    auditFile: write && records.length > 0 ? `.quality-center/fix/${fixId}/fix-result.json` : undefined,
    note:
      targets.length === 0
        ? '没有命中可确定性修复的规则（UnusedImports / RedundantImport / ModifierOrder / SimplifyBooleanExpression）'
        : ''
  };
}

export interface FixRollbackResult {
  ok: boolean;
  fixId: string;
  restored: string[];
  refused: { file: string; reason: string }[];
  reason?: string;
}

/**
 * 回滚确定性修复：当前文件必须仍是修复后的内容才允许覆盖，手工改过的文件拒绝，
 * 避免“回滚”把用户/AI 后续的修改一起抹掉。
 */
export function rollbackFixProject(root: string, fixId: string): FixRollbackResult {
  const dir = path.join(root, '.quality-center', 'fix', fixId);
  const result: FixRollbackResult = { ok: false, fixId, restored: [], refused: [] };
  try {
    const audit = JSON.parse(fs.readFileSync(path.join(dir, 'fix-result.json'), 'utf8')) as FixAudit;
    for (const entry of audit.files) {
      const currentFile = path.resolve(root, entry.rel);
      const beforeFile = path.resolve(root, entry.beforeCopy);
      if (!fs.existsSync(beforeFile)) {
        result.refused.push({ file: entry.rel, reason: '缺少修复前快照' });
        continue;
      }
      const before = fs.readFileSync(beforeFile, 'utf8');
      if (fs.existsSync(currentFile)) {
        const current = fs.readFileSync(currentFile, 'utf8');
        if (hashText(current) !== entry.afterHash && hashText(current) !== entry.beforeHash) {
          result.refused.push({ file: entry.rel, reason: '文件在修复后又被改动，拒绝覆盖' });
          continue;
        }
        if (hashText(current) === entry.beforeHash) {
          result.restored.push(entry.rel);
          continue;
        }
      }
      fs.mkdirSync(path.dirname(currentFile), { recursive: true });
      fs.writeFileSync(currentFile, before, 'utf8');
      result.restored.push(entry.rel);
    }
    result.ok = result.refused.length === 0;
    result.reason = result.ok ? undefined : '部分文件已被后续修改，未回滚；请手工处理 refused 列表';
    fs.writeFileSync(
      path.join(dir, 'rollback-result.json'),
      `${JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    result.reason = `回滚失败：${error instanceof Error ? error.message : String(error)}`;
  }
  return result;
}
