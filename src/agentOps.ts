/**
 * CLI 与 MCP 共用的操作层：把「扫描 / 构建 / 工具 / 报告 / 修复」做成返回纯数据的函数，
 * 由 cli.ts（人读 + 退出码）和 mcp.ts（JSON-RPC 工具）各自做展示，
 * 保证同一条能力不会在两处实现出不同行为。
 */
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

export const PACKAGE_ROOT = path.resolve(__dirname, '..');

export const SOURCES: IssueSource[] = ['checkstyle', 'gitleaks', 'trivy', 'spotbugs'];
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
    onProgress: request.onProgress
  });

  const result = await runAgentScan(options);
  const exported =
    request.exportFiles === false
      ? undefined
      : {
          dir: path.join(request.root, '.quality-center'),
          jsonPath: path.join(request.root, '.quality-center', 'issues.json'),
          markdownPath: path.join(request.root, '.quality-center', 'report.md')
        };
  const payload = buildPayload(result, request.root, exported);
  const exitCode = payload.missingTools.length > 0 ? 2 : exitCodeFor(result, request.failOn ?? 'high');
  return {
    result,
    payload,
    exitCode,
    seconds: (result.finishedAt - result.startedAt) / 1000
  };
}

export interface BuildOutcome {
  ok: boolean;
  code: number;
  seconds: number;
  jars: string[];
  /** 失败时的末尾几行原因（已过滤进度条与 ANSI） */
  tail: string;
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

/** 执行 mvn package；onLine 收实时输出行（调用方自行过滤噪声） */
export async function buildProject(
  root: string,
  onLine?: (line: string) => void
): Promise<BuildOutcome> {
  const mvn = resolveBinary('mvn');
  if (!mvn) {
    return { ok: false, code: 2, seconds: 0, jars: [], tail: '没有找到 mvn，先执行 tools install mvn' };
  }
  const startedAt = Date.now();
  const handle = runStreaming(mvn, ['-B', '-DskipTests', 'package'], root, 30 * 60_000, {
    onLine: (line) => {
      if (onLine) {
        onLine(stripAnsi(line));
      }
    }
  });
  const outcome = await handle.result;
  const seconds = (Date.now() - startedAt) / 1000;
  if (outcome.code !== 0) {
    return { ok: false, code: outcome.code, seconds, jars: [], tail: tailLines(outcome.stdout, outcome.stderr) };
  }
  return { ok: true, code: 0, seconds, jars: artifactJars(root), tail: '' };
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
  const scan = await scanProject({ root, exportFiles: false, failOn: 'none', onProgress });
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
  let applied = 0;
  let skipped = 0;

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
    if (write) {
      fs.writeFileSync(file, outcome.content, 'utf8');
    }
    files.push({
      file,
      rel: path.relative(root, file).split(path.sep).join('/'),
      applied: outcome.applied,
      skipped: outcome.skipped,
      changes: outcome.changes
    });
  }

  return {
    mode: write ? 'write' : 'dry-run',
    targets: targets.length,
    applied,
    skipped,
    files,
    note:
      targets.length === 0
        ? '没有命中可确定性修复的规则（UnusedImports / RedundantImport / ModifierOrder / SimplifyBooleanExpression）'
        : ''
  };
}
