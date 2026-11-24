#!/usr/bin/env node
/**
 * 无界面入口：给 AI agent / CI 调用的命令行接口。
 *
 * 设计要点：
 * - stdout 只放结果（--json 时是 AgentPayload），进度与日志一律走 stderr，方便 agent 直接解析；
 * - 退出码有语义：0 通过、1 有达到阈值的问题、2 执行失败（工具缺失 / 命令出错）、3 用法错误；
 * - 不依赖 vscode API，可在任意 Node 环境运行（编辑器插件目录里同样可用）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildPayload,
  exitCodeFor,
  missingToolsHint,
  optionsFromProject,
  runAgentScan,
  summarize,
  toolStatuses
} from './agentApi';
import { resolveBinary, runStreaming, stripAnsi } from './exec';
import { IssueSource, Severity } from './model';
import { EXTERNAL_TOOLS, installLocation, installPlan, ToolId } from './tools';

const packageRoot = path.resolve(__dirname, '..');

function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const SOURCES: IssueSource[] = ['checkstyle', 'gitleaks', 'trivy', 'spotbugs'];
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

const HELP = `质量中心（quality-center）命令行 —— 给 AI agent 与 CI 用的无界面接口

用法:
  quality-center scan [目录] [选项]      跑四类扫描，输出结构化结果
  quality-center build [目录]            执行 mvn package 生成 target 产物
  quality-center tools status [--json]   查看外部工具安装状态
  quality-center tools install <id>      自动安装 mvn / gitleaks / trivy
  quality-center report [--json|--md]    复用 .quality-center/issues.json 输出结果
  quality-center help | version

scan 选项:
  --json                 以 JSON（AgentPayload, schemaVersion=2）输出到 stdout
  --only <a,b,c>         只跑指定扫描器（checkstyle,gitleaks,trivy,spotbugs）
  --fail-on <级别>       critical|high|medium|low|info|none，命中即退出码 1（默认 high）
  --out <目录>           中间报告目录（默认 <目录>/.quality-center/scans）
  --no-export            不写 .quality-center/issues.json 与 report.md
  --quiet                不输出进度（stderr）

退出码:
  0 通过    1 有达到阈值的问题    2 执行失败 / 工具缺失    3 用法错误
`;

interface Args {
  command: string;
  /** 命令之后的全部位置参数：scan 的第 1 个是目录，tools install 的第 2 个是工具 id */
  positionals: string[];
  root: string;
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  const takesValue = new Set(['--only', '--fail-on', '--out', '--path']);
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) {
      if (takesValue.has(item)) {
        flags[item] = argv[i + 1] ?? '';
        i += 1;
      } else {
        flags[item] = true;
      }
    } else {
      positional.push(item);
    }
  }
  const explicitPath = typeof flags['--path'] === 'string' ? String(flags['--path']) : '';
  return {
    command: positional[0] ?? 'help',
    positionals: positional.slice(1),
    root: path.resolve(explicitPath || process.cwd()),
    flags
  };
}

/** 目录取「命令后的第一个位置参数」，其次 --path，最后当前目录 */
function targetRoot(args: Args): string {
  const first = args.positionals[0];
  return first && !first.startsWith('-') ? path.resolve(first) : args.root;
}

const progress = (message: string): void => {
  process.stderr.write(`[quality-center] ${message}\n`);
};
const quiet = (args: Args): boolean => args.flags['--quiet'] === true;
const log = (args: Args, message: string): void => {
  if (!quiet(args)) {
    progress(message);
  }
};

function severityCounts(result: { summary: Record<string, number> }): string {
  const summary = result.summary;
  const pairs: string[] = [];
  for (const severity of SEVERITIES) {
    const count = summary[severity] ?? 0;
    if (count > 0) {
      pairs.push(`${severity} ${count}`);
    }
  }
  return pairs.length > 0 ? pairs.join(' / ') : '无';
}

async function scanCommand(args: Args): Promise<number> {
  const root = targetRoot(args);
  const only = typeof args.flags['--only'] === 'string' ? String(args.flags['--only']) : '';
  const enabled: Partial<Record<IssueSource, boolean>> = {};
  if (only) {
    for (const source of SOURCES) {
      enabled[source] = only.split(',').map((item) => item.trim()).includes(source);
    }
    const unknown = only
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item && !SOURCES.includes(item as IssueSource));
    if (unknown.length > 0) {
      progress(`未知扫描器：${unknown.join(', ')}（可选 ${SOURCES.join(', ')}）`);
      return 3;
    }
  }

  const failOnRaw = typeof args.flags['--fail-on'] === 'string' ? String(args.flags['--fail-on']) : 'high';
  const failOn = failOnRaw === 'none' ? 'none' : (failOnRaw as Severity);
  if (failOn !== 'none' && !SEVERITIES.includes(failOn)) {
    progress(`--fail-on 取值非法：${failOnRaw}`);
    return 3;
  }

  if (!fs.existsSync(root)) {
    progress(`目录不存在：${root}`);
    return 2;
  }

  const options = optionsFromProject(root, packageRoot, {
    enabled,
    outDir: typeof args.flags['--out'] === 'string' ? String(args.flags['--out']) : undefined,
    exportFiles: args.flags['--no-export'] !== true,
    onProgress: (event) => {
      if (quiet(args)) {
        return;
      }
      if (event.type === 'start') {
        progress(`开始 ${event.source}`);
      } else if (event.type === 'done') {
        if (event.skipped) {
          progress(`跳过 ${event.source}：${event.skipped}`);
        } else if (event.error) {
          progress(`${event.source} 出错：${event.error}`);
        } else {
          progress(`${event.source} 完成：${event.issues} 项`);
        }
      }
    }
  });

  let result;
  try {
    result = await runAgentScan(options);
  } catch (error) {
    progress(`扫描失败：${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const exported = args.flags['--no-export'] === true
    ? undefined
    : { jsonPath: path.join(root, '.quality-center', 'issues.json'), markdownPath: path.join(root, '.quality-center', 'report.md'), dir: path.join(root, '.quality-center') };
  const payload = buildPayload(result, root, exported);

  if (args.flags['--json'] === true) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const seconds = ((result.finishedAt - result.startedAt) / 1000).toFixed(1);
    process.stdout.write(
      [
        `扫描完成：${result.issues.length} 个问题（${severityCounts(payload)}），用时 ${seconds} 秒`,
        `忽略项：${result.ignored.length}`,
        result.skipped.length > 0
          ? `已跳过：${result.skipped.map((item) => `${item.source}（${item.reason}）`).join('；')}`
          : '已跳过：无',
        payload.missingTools.length > 0 ? `缺失工具：${missingToolsHint(payload.missingTools)}` : '',
        result.errors.length > 0
          ? `扫描异常：${result.errors.map((item) => `${item.source}：${item.message}`).join('；')}`
          : '',
        payload.files.issuesJson ? `结构化结果：${payload.files.issuesJson}` : '',
        `下一步：${payload.nextActions.join('；')}`
      ]
        .filter(Boolean)
        .join('\n')
    );
    process.stdout.write('\n');
  }

  if (payload.missingTools.length > 0) {
    return 2;
  }
  return exitCodeFor(result, failOn);
}

function mvnPath(): string | undefined {
  return resolveBinary('mvn');
}

async function buildCommand(args: Args): Promise<number> {
  const root = targetRoot(args);
  if (!fs.existsSync(root)) {
    progress(`目录不存在：${root}`);
    return 2;
  }
  const mvn = mvnPath();
  if (!mvn) {
    progress('没有找到 mvn，无法构建。先执行：quality-center tools install mvn');
    return 2;
  }
  const startedAt = Date.now();
  const handle = runStreaming(
    mvn,
    ['-B', '-DskipTests', 'package'],
    root,
    30 * 60_000,
    {
      onLine: (line) => {
        const text = stripAnsi(line);
        if (/^\[INFO\] (Building|BUILD|---)|^Downloading|^\[ERROR\]/.test(text)) {
          log(args, text.replace(/^\[INFO\]\s*/, ''));
        }
      }
    }
  );
  const outcome = await handle.result;
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (outcome.code !== 0) {
    const tail = stripAnsi(outcome.stderr || outcome.stdout)
      .split(/\r?\n/)
      .filter((line) => line.trim() && !/^[#.\s|-]+$/.test(line))
      .slice(-6)
      .join('\n');
    process.stdout.write(`构建失败（退出码 ${outcome.code}，用时 ${seconds} 秒）\n${tail || '无可用错误输出'}\n`);
    return 2;
  }
  const jars = fs.existsSync(path.join(root, 'target'))
    ? fs
        .readdirSync(path.join(root, 'target'))
        .filter(
          (name) =>
            name.endsWith('.jar') &&
            !/-sources\.jar$/.test(name) &&
            !/-javadoc\.jar$/.test(name) &&
            !name.startsWith('original-')
        )
    : [];
  process.stdout.write(
    `构建完成（用时 ${seconds} 秒）：${jars.length > 0 ? jars.join('、') : 'target 下未找到 jar'}\n`
  );
  return 0;
}

async function toolsCommand(args: Args): Promise<number> {
  const action = args.positionals[0] ?? 'status';
  if (action === 'status') {
    const statuses = toolStatuses();
    if (args.flags['--json'] === true) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: '2', tools: statuses }, null, 2)}\n`);
      return 0;
    }
    for (const status of statuses) {
      process.stdout.write(
        `${status.found ? '✓' : '✗'} ${status.id}（${status.bin}）` +
          `${status.found ? ` → ${status.path}` : `  可自动安装：${status.installable ? '是' : '否'}，${status.plan}`}\n`
      );
    }
    return 0;
  }

  if (action !== 'install') {
    progress(`未知子命令：tools ${action}`);
    return 3;
  }

  const raw = args.positionals[1] ?? '';
  const id = raw as ToolId;
  const tool = EXTERNAL_TOOLS[id];
  if (!tool) {
    progress(`未知工具：${raw || '(空)'}（可选 ${Object.keys(EXTERNAL_TOOLS).join(', ')}）`);
    return 3;
  }

  const plan = installPlan(tool);
  if (plan.requiresRoot) {
    process.stdout.write(
      `${tool.label} 需要管理员权限，未自动执行。请在终端手动运行：\n${plan.command ?? plan.hint}\n`
    );
    return 2;
  }
  if (!plan.command && !plan.script) {
    process.stdout.write(`${tool.label} 需要手动安装：${plan.hint}\n${tool.docs}\n`);
    return 2;
  }

  const found = resolveBinary(tool.bin);
  if (found) {
    process.stdout.write(`${tool.bin} 已存在：${found}\n`);
    return 0;
  }

  progress(`安装 ${tool.label}：${plan.describe}`);
  let command = plan.command ?? '';
  let cleanupDir: string | undefined;
  if (!plan.command && plan.script) {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'quality-center-cli-'));
    cleanupDir = dir;
    const file = path.join(dir, plan.scriptShell === 'powershell' ? 'install.ps1' : 'install.sh');
    const body = plan.scriptShell === 'powershell' ? `\uFEFF${plan.script}` : plan.script;
    fs.writeFileSync(file, body, 'utf8');
    command =
      plan.scriptShell === 'powershell'
        ? `"${path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${file}"`
        : `bash "${file}"`;
  }

  const handle = runStreaming(command, [], args.root, 15 * 60_000, {
    onLine: (line) => log(args, line)
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
    process.stdout.write(
      `已安装 ${tool.label}${resolved ? `：${resolved}` : `（目标目录 ${installLocation(tool, plan) ?? '见日志'}）`}\n`
    );
    return 0;
  }
  const tail = stripAnsi(outcome.stderr || outcome.stdout)
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^[#.\s|-]+$/.test(line))
    .slice(-5)
    .join('\n');
  process.stdout.write(`安装失败（退出码 ${outcome.code}）：\n${tail || plan.describe}\n`);
  return 2;
}

async function reportCommand(args: Args): Promise<number> {
  const root = targetRoot(args);
  const jsonFile = path.join(root, '.quality-center', 'issues.json');
  const mdFile = path.join(root, '.quality-center', 'report.md');
  if (args.flags['--md'] === true) {
    if (!fs.existsSync(mdFile)) {
      progress(`还没有报告：${mdFile}，先执行 quality-center scan`);
      return 2;
    }
    process.stdout.write(`${fs.readFileSync(mdFile, 'utf8')}\n`);
    return 0;
  }
  if (!fs.existsSync(jsonFile)) {
    progress(`还没有结构化结果：${jsonFile}，先执行 quality-center scan`);
    return 2;
  }
  const payload = JSON.parse(fs.readFileSync(jsonFile, 'utf8')) as {
    summary?: Record<string, number>;
  };
  if (args.flags['--json'] === true) {
    process.stdout.write(`${fs.readFileSync(jsonFile, 'utf8')}\n`);
    return 0;
  }
  const summary = payload.summary ?? { total: 0 };
  const pairs = SEVERITIES.map((severity) => `${severity} ${summary[severity] ?? 0}`).join(' / ');
  process.stdout.write(`${jsonFile}\n共 ${summary.total ?? 0} 个问题（${pairs}）\n`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags['--version'] === true || args.command === 'version') {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  switch (args.command) {
    case 'scan':
      return scanCommand(args);
    case 'build':
      return buildCommand(args);
    case 'tools':
      return toolsCommand(args);
    case 'report':
      return reportCommand(args);
    case 'help':
    case '--help':
      process.stdout.write(HELP);
      return 0;
    default:
      process.stdout.write(HELP);
      return 3;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`[quality-center] 未处理异常：${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 2;
  });

// 命令行进程不读取 stdin，避免阻塞在 agent 环境里
void process.stdin.isTTY;
