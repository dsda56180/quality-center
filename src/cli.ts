#!/usr/bin/env node
/**
 * 无界面入口：给 AI agent / CI 调用的命令行接口。
 *
 * 设计要点：
 * - stdout 只放结果（--json 时是 AgentPayload），进度与日志一律走 stderr，方便 agent 直接解析；
 * - 退出码有语义：0 通过、1 有达到阈值的问题、2 执行失败（工具缺失 / 命令出错）、3 用法错误；
 * - 不依赖 vscode API，可在任意 Node 环境运行（编辑器插件目录里同样可用）；
 * - 具体能力都在 agentOps 里，与 MCP 服务端共用同一套实现。
 */
import * as fs from 'fs';
import * as path from 'path';
import { toSarif, toWorkflowCommands } from './sarif';
import {
  buildProject,
  fixProject,
  installToolHeadless,
  packageVersion,
  parseFailOn,
  parseOnly,
  readReport,
  scanProject,
  SEVERITIES,
  SOURCES,
  toolsStatusPayload
} from './agentOps';
import { AgentScanEvent } from './agentApi';
import { EXTERNAL_TOOLS, ToolId } from './tools';

const HELP = `质量中心（quality-center）命令行 —— 给 AI agent 与 CI 用的无界面接口

用法:
  quality-center scan [目录] [选项]      跑六类扫描，输出结构化结果
  quality-center build [目录]            执行 mvn package 生成 target 产物
  quality-center fix [目录] [--write]    应用确定性修复（默认只预览）
  quality-center tools status [--json]   查看外部工具安装状态
  quality-center tools install <id>      自动安装 mvn / gitleaks / trivy
  quality-center report [--json|--md]    复用 .quality-center/issues.json 输出结果
  quality-center mcp                     以 MCP(stdio) 服务端运行，供 agent 直接调用
  quality-center help | version

scan 选项:
  --json                 以 JSON（AgentPayload, schemaVersion=2）输出到 stdout
  --only <a,b,c>         只跑指定扫描器（checkstyle,gitleaks,trivy,spotbugs,qcsec,astgrep）
  --fail-on <级别>       critical|high|medium|low|info|none，命中即退出码 1（默认 high）
  --mute <a,b>           规则静音，支持规则 id、前缀通配（SEC_DRUID_*）、来源名（覆盖 qualityCenter.rules.mute）
  --aggregate            同文件聚合（medium 及以下、>=3 处才合并，默认关闭）
  --sarif [路径]         额外写 SARIF 2.1.0（默认 .quality-center/report.sarif）
  --gha                  输出 GitHub Actions 注解（::error/::warning）
  --out <目录>           中间报告目录（默认 <目录>/.quality-center/scans）
  --no-export            不写 .quality-center/issues.json、report.md 与 report.sarif
  --quiet                不输出进度（stderr）

fix 选项:
  --write                真正写回文件（默认只预览，输出改动清单）
  --json                 以 JSON 输出改动清单

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
  const takesValue = new Set(['--only', '--fail-on', '--out', '--path', '--mute', '--sarif']);
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

function scanProgress(args: Args): (event: AgentScanEvent) => void {
  return (event) => {
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
  };
}

async function scanCommand(args: Args): Promise<number> {
  const root = targetRoot(args);
  const onlyRaw = typeof args.flags['--only'] === 'string' ? String(args.flags['--only']) : undefined;
  const only = parseOnly(onlyRaw);
  if (onlyRaw && !only) {
    progress(`未知扫描器：${onlyRaw}（可选 ${SOURCES.join(', ')}）`);
    return 3;
  }
  const failOnRaw = typeof args.flags['--fail-on'] === 'string' ? String(args.flags['--fail-on']) : undefined;
  const failOn = parseFailOn(failOnRaw);
  if (!failOn) {
    progress(`--fail-on 取值非法：${failOnRaw ?? ''}`);
    return 3;
  }
  if (!fs.existsSync(root)) {
    progress(`目录不存在：${root}`);
    return 2;
  }

  let scan;
  try {
    const muteRaw = typeof args.flags['--mute'] === 'string' ? String(args.flags['--mute']) : undefined;
    scan = await scanProject({
      root,
      only,
      failOn,
      outDir: typeof args.flags['--out'] === 'string' ? String(args.flags['--out']) : undefined,
      exportFiles: args.flags['--no-export'] !== true,
      mute: muteRaw ? muteRaw.split(',').map((item) => item.trim()).filter(Boolean) : undefined,
      aggregate: args.flags['--aggregate'] === true,
      onProgress: scanProgress(args)
    });
  } catch (error) {
    progress(`扫描失败：${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  // SARIF：给 GitHub code scanning / Azure DevOps / SonarQube 直接消费
  const sarifFlag = args.flags['--sarif'];
  if (typeof sarifFlag === 'string' || sarifFlag === true) {
    const target =
      typeof sarifFlag === 'string' && sarifFlag.trim()
        ? path.resolve(sarifFlag)
        : path.join(root, '.quality-center', 'report.sarif');
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, toSarif(scan.result, root), 'utf8');
      log(args, `SARIF 已写入：${target}`);
    } catch (error) {
      progress(`写 SARIF 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // GitHub Actions 注解：出现在 PR 的 Checks / Files changed
  if (args.flags['--gha'] === true) {
    process.stdout.write(`${toWorkflowCommands(scan.result, root)}\n`);
  }

  if (args.flags['--json'] === true) {
    process.stdout.write(`${JSON.stringify(scan.payload, null, 2)}\n`);
  } else {
    const { payload } = scan;
    process.stdout.write(
      [
        `扫描完成：${scan.result.issues.length} 个问题（${severityCounts(payload)}），用时 ${scan.seconds.toFixed(1)} 秒`,
        `忽略项：${scan.result.ignored.length}`,
        scan.result.skipped.length > 0
          ? `已跳过：${scan.result.skipped.map((item) => `${item.source}（${item.reason}）`).join('；')}`
          : '已跳过：无',
        payload.missingTools.length > 0 ? `缺失工具：${payload.missingTools.join(', ')}` : '',
        scan.result.errors.length > 0
          ? `扫描异常：${scan.result.errors.map((item) => `${item.source}：${item.message}`).join('；')}`
          : '',
        payload.files.issuesJson ? `结构化结果：${payload.files.issuesJson}` : '',
        `下一步：${payload.nextActions.join('；')}`
      ]
        .filter(Boolean)
        .join('\n')
    );
    process.stdout.write('\n');
  }
  return scan.exitCode;
}

async function buildCommand(args: Args): Promise<number> {
  const root = targetRoot(args);
  if (!fs.existsSync(root)) {
    progress(`目录不存在：${root}`);
    return 2;
  }
  const outcome = await buildProject(root, (line) => {
    if (/^\[INFO\] (Building|BUILD|---)|^\[ERROR\]/.test(line)) {
      log(args, line.replace(/^\[INFO\]\s*/, ''));
    }
  });
  if (!outcome.ok) {
    process.stdout.write(
      `构建失败（退出码 ${outcome.code}，用时 ${outcome.seconds.toFixed(1)} 秒）\n${outcome.tail || '无可用错误输出'}\n`
    );
    return 2;
  }
  process.stdout.write(
    `构建完成（用时 ${outcome.seconds.toFixed(1)} 秒）：${outcome.jars.length > 0 ? outcome.jars.join('、') : 'target 下未找到 jar'}\n`
  );
  return 0;
}

async function fixCommand(args: Args): Promise<number> {
  const root = targetRoot(args);
  if (!fs.existsSync(root)) {
    progress(`目录不存在：${root}`);
    return 2;
  }
  const write = args.flags['--write'] === true;
  const outcome = await fixProject(root, write, scanProgress(args));

  if (args.flags['--json'] === true) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    return 0;
  }
  if (outcome.applied === 0) {
    process.stdout.write(`${outcome.note || '没有可应用的修复'}\n`);
    return 0;
  }
  process.stdout.write(
    `${write ? '已应用' : '预览'}确定性修复：${outcome.applied} 处 / ${outcome.files.length} 个文件` +
      `${outcome.skipped > 0 ? `（跳过 ${outcome.skipped} 处）` : ''}\n`
  );
  for (const file of outcome.files) {
    process.stdout.write(
      `  ${file.rel}：${file.changes.map((change) => `L${change.line} ${change.rule}`).join('、')}\n`
    );
  }
  process.stdout.write(
    write
      ? '下一步：执行 quality-center scan --json 复核这些规则是否已消失\n'
      : '这是预览，未改动任何文件。确认后加 --write 落盘。\n'
  );
  return 0;
}

async function toolsCommand(args: Args): Promise<number> {
  const action = args.positionals[0] ?? 'status';
  if (action === 'status') {
    const payload = toolsStatusPayload();
    if (args.flags['--json'] === true) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return 0;
    }
    for (const status of payload.tools) {
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
  if (!EXTERNAL_TOOLS[id]) {
    progress(`未知工具：${raw || '(空)'}（可选 ${Object.keys(EXTERNAL_TOOLS).join(', ')}）`);
    return 3;
  }
  return installCommand(args, id);
}

async function installCommand(args: Args, id: ToolId): Promise<number> {
  const outcome = await installToolHeadless(id, args.root, (line) => log(args, line));
  process.stdout.write(`${outcome.message}\n`);
  return outcome.ok ? 0 : 2;
}

function reportCommand(args: Args): number {
  const root = targetRoot(args);
  const format = args.flags['--md'] === true ? 'markdown' : args.flags['--json'] === true ? 'json' : 'summary';
  const report = readReport(root, format);
  if (!report.ok) {
    progress(report.text);
    return 2;
  }
  process.stdout.write(`${report.text}${report.format === 'json' ? '' : '\n'}`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags['--version'] === true || args.command === 'version') {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  switch (args.command) {
    case 'scan':
      return scanCommand(args);
    case 'build':
      return buildCommand(args);
    case 'fix':
      return fixCommand(args);
    case 'tools':
      return toolsCommand(args);
    case 'report':
      return reportCommand(args);
    case 'mcp':
      // 启动 stdio 服务端并接管 stdin/stdout，进程不会正常返回
      return new Promise<number>(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('./mcp');
      });
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
