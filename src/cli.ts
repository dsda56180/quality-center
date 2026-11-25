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
import { applyUpgradePlan, checkUpgradePlan, createUpgradePlan, readIssues, revertUpgradePlan } from './upgradePlanFile';
import { digestScan } from './scanDigest';
import { projectStatus } from './status';
import { buildNextAction } from './nextAction';
import { explainBuildFailure } from './explain';
import { integrate } from './integrate';
import { buildAgentPrompt } from './agentPrompt';

const HELP = `质量中心（quality-center）命令行 —— 给 AI agent 与 CI 用的无界面接口

用法:
  quality-center scan [目录] [选项]      跑六类扫描，输出结构化结果
  quality-center status [目录] [--json]  一屏看工具/扫描/升级计划/pom 状态
  quality-center next [目录] [--json]    给出唯一下一步，并刷新 .quality-center/handoff.md
  quality-center explain [目录] [--json] 翻译构建失败：原因/影响/建议
  quality-center prompt [目录] [--drive] 输出可复制给 AI 的执行指令（--drive 为全权推进循环）
  quality-center build [目录]            执行策略门禁构建（默认 mvn package）
  quality-center fix [目录] [--write]    应用确定性修复（默认只预览）
  quality-center tools status [--json]   查看外部工具安装状态
  quality-center tools install <id>      自动安装 mvn / gitleaks / trivy
  quality-center report [--json|--md]    复用 .quality-center/issues.json 输出结果
  quality-center upgrade plan [目录]     生成升级计划（plan.json + pom.diff），不改 pom；--reuse 复用同 hash 的计划，--replace 覆盖进行中计划
  quality-center upgrade apply [目录]    按计划落盘（默认只预览，--write 才写；--group/--only 分批）
  quality-center upgrade check [目录]    校验当前 pom 是否与计划一致（CI 门禁）
  quality-center upgrade revert [目录]   回滚到计划生成前的 pom 快照
  quality-center integrate [目录]        写入策略/启动器/Skill 与各编辑器适配器
  quality-center mcp                     以 MCP(stdio) 服务端运行，供 agent 直接调用
  quality-center help | version

scan 选项:
  --json                 以 JSON（AgentPayload, schemaVersion=2）输出到 stdout
  --detail <summary|full> 配合 --json：summary 只给计数 + Top N（默认 full，兼容旧用法）
  --top <N>              summary 模式返回的问题条数，默认 10
  --delta                与上一次扫描比较，只回新增/消失数量
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

next 选项:
  --json                 以 JSON 输出状态机（含 command / blockers / handoffFile）
  --no-handoff           只读计算，不写 .quality-center/handoff.md

explain 选项:
  --json                 以 JSON 输出原因/影响/建议
  --log <文件>           指定日志，缺省读 .quality-center/build.log

prompt 选项:
  --drive               输出「全权推进」循环（默认协助模式）
  --plan <planId>       指定计划，缺省用最新一份
  --failure <文件>      附上失败日志尾部，供 AI 从现场开始判断
  --json                以 JSON 输出 { mode, planId, prompt }

upgrade 选项:
  --plan <planId>        指定计划，缺省用最新一份
  --hash <pomHash>       落盘前校验 pom 哈希，防止计划过期后误写
  --write                真正写回 pom.xml（默认只输出 diff 预览）
  --json                 以 JSON 输出计划或结果

integrate 选项:
  --all                  为 Trae / Cursor / VS Code / Copilot 全量生成适配器
  --fallback             额外生成 AGENTS.md 与根 .mcp.json（默认关闭，保持仓库干净）
  --check                只比对不写；生成物与策略不一致时退出码 1

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
  const takesValue = new Set(['--only', '--fail-on', '--out', '--path', '--plan', '--hash', '--group', '--detail', '--top', '--log', '--mute', '--sarif', '--failure']);
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
    const wantsDigest =
      typeof args.flags['--detail'] === 'string' ||
      args.flags['--delta'] === true ||
      typeof args.flags['--top'] === 'string';
    if (wantsDigest) {
      const digest = digestScan(root, scan.payload, {
        detail: args.flags['--detail'] === 'full' ? 'full' : 'summary',
        top: typeof args.flags['--top'] === 'string' ? Number(args.flags['--top']) : undefined,
        delta: args.flags['--delta'] === true
      });
      process.stdout.write(
        `${JSON.stringify({ exitCode: scan.exitCode, seconds: Number(scan.seconds.toFixed(1)), ...digest.body }, null, 2)}\n`
      );
    } else {
      // 兼容旧消费者：显式不加 --detail 时仍输出完整 payload
      process.stdout.write(`${JSON.stringify(scan.payload, null, 2)}\n`);
    }
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
  const explanation = outcome.ok ? undefined : explainBuildFailure(root);
  if (args.flags['--json'] === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: outcome.ok,
          code: outcome.code,
          seconds: outcome.seconds,
          gate: outcome.gate,
          jars: outcome.jars,
          errors: outcome.errors ?? [],
          tail: outcome.tail ?? '',
          logFile: outcome.logFile ? path.relative(root, outcome.logFile) : null,
          explain: explanation
            ? {
                kind: explanation.kind,
                cause: explanation.cause,
                impact: explanation.impact,
                suggestion: explanation.suggestion,
                evidence: explanation.evidence
              }
            : undefined
        },
        null,
        2
      )}\n`
    );
    return outcome.ok ? 0 : 2;
  }
  if (!outcome.ok) {
    const lines = [
      `构建失败（退出码 ${outcome.code}，用时 ${outcome.seconds.toFixed(1)} 秒）`,
      `原因：${explanation?.cause ?? '日志里没有可识别的错误模式'}`,
      `影响：${explanation?.impact ?? '本次落盘没有通过门禁，不能当成已完成'}`,
      `建议：${explanation?.suggestion ?? '查看完整日志，或把日志尾部交给 AI'}`
    ];
    if (explanation?.evidence.length) {
      lines.push(`现场：${explanation.evidence.join(' / ')}`);
    }
    if (outcome.logFile) {
      lines.push(`完整日志：${path.relative(root, outcome.logFile)}`);
    }
    lines.push('下一步：先处理好上面这条原因，再执行 qc next；不要跳过门禁继续下一组');
    process.stdout.write(`${lines.join('\n')}\n`);
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

function reportCommand(args: Args): number {  const root = targetRoot(args);
  const format = args.flags['--md'] === true ? 'markdown' : args.flags['--json'] === true ? 'json' : 'summary';
  const report = readReport(root, format);
  if (!report.ok) {
    progress(report.text);
    return 2;
  }
  process.stdout.write(`${report.text}${report.format === 'json' ? '' : '\n'}`);
  return 0;
}

function upgradeRoot(args: Args): string {
  const positional = args.positionals[1];
  return positional && !positional.startsWith('-') ? path.resolve(positional) : args.root;
}

async function upgradeCommand(args: Args): Promise<number> {
  const action = args.positionals[0] ?? 'plan';
  const root = upgradeRoot(args);
  if (!fs.existsSync(path.join(root, 'pom.xml'))) {
    progress(`未找到 pom.xml：${root}`);
    return 2;
  }
  const planId = typeof args.flags['--plan'] === 'string' ? String(args.flags['--plan']) : undefined;

  if (action === 'plan') {
    const issuesFile = path.join(root, '.quality-center', 'issues.json');
    if (!fs.existsSync(issuesFile)) {
      progress('还没有扫描结果：先执行 scan（或 scan --only trivy），再生成升级计划');
      return 2;
    }
    if (args.flags['--reuse'] !== true && args.flags['--replace'] !== true) {
      try {
        const active = checkUpgradePlan(root);
        if (active.state === 'pending' || active.state === 'partial') {
          progress(
            `已有进行中的升级计划 ${active.planId}（${active.appliedCount ?? 0}/${active.total ?? '?'}）。` +
              '先继续 apply / check，确需替换再加 --replace。'
          );
          return 2;
        }
      } catch {
        // 没有旧计划：正常生成
      }
    }
    const issues = readIssues(root);
    const result = createUpgradePlan(root, issues, { planId, reuse: args.flags['--reuse'] === true });
    if (result.plan.candidates.length === 0) {
      const detail = result.plan.skipped.length
        ? result.plan.skipped
            .slice(0, 5)
            .map((item) => `  - ${item.packageName}：${item.reason}`)
            .join('\n')
        : '  - 没有带修复版本的直接依赖漏洞';
      if (args.flags['--json'] === true) {
        process.stdout.write(`${JSON.stringify({ ...result.plan, empty: true }, null, 2)}\n`);
      } else {
        process.stdout.write(`没有可升级的依赖（0 个候选），未生成计划。\n${detail}\n提示：确认已跑过全量扫描；跨大版本项需人工评估后再决定是否升级。\n`);
      }
      return 0;
    }
    if (args.flags['--json'] === true) {
      process.stdout.write(`${JSON.stringify(result.plan, null, 2)}\n`);
      return 0;
    }
    const lines: string[] = [
      `升级计划 ${result.plan.planId}（schemaVersion ${result.plan.schemaVersion}）${result.reused ? '（复用：pom 与扫描结果未变）' : ''}`,
      `Java ${result.plan.project.javaVersion ?? '未识别'} · 框架目标 ${result.plan.project.frameworkTarget ?? '未声明'}`
    ];
    result.plan.groups.forEach((group) => {
      lines.push(`分组 ${group.name}（${group.label}）：${group.candidates.length} 项，涉及 ${group.cveCount} 条漏洞`);
    });
    result.plan.candidates.forEach((item) => {
      lines.push(
        `  [${item.id}] ${item.packageName} ${item.from} → ${item.to}（${item.mode}，${item.group}，涉及 ${item.cveCount} 条漏洞）` +
          `${item.crossLine ? '  ⚠ 跨大版本，需人工确认' : ''}`
      );
    });
    if (result.plan.skipped.length > 0) {
      lines.push(`跳过 ${result.plan.skipped.length} 项：`);
      result.plan.skipped.slice(0, 5).forEach((item) => lines.push(`  - ${item.packageName}：${item.reason}`));
    }
    lines.push(`计划：${path.relative(root, result.planPath)}`);
    lines.push(`补丁：${path.relative(root, result.patchPath)}（${result.patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length} 行新增）`);
    const firstGroup = result.plan.groups[0]?.name ?? 'framework';
    lines.push(
      `下一步：upgrade apply . --plan ${result.plan.planId} --hash ${result.plan.pomHash} --group ${firstGroup} --write（一组一验证，组后跑 upgrade check）`
    );
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  if (action === 'apply') {
    const write = args.flags['--write'] === true;
    const expectedHash = typeof args.flags['--hash'] === 'string' ? String(args.flags['--hash']) : undefined;
    const group = typeof args.flags['--group'] === 'string' ? (String(args.flags['--group']) as never) : undefined;
    const packages =
      typeof args.flags['--only'] === 'string'
        ? String(args.flags['--only'])
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined;
    const outcome = applyUpgradePlan(root, {
      planId,
      write,
      expectedHash,
      packages,
      group,
      allowCrossLine: args.flags['--allow-cross-line'] === true
    });
    if (args.flags['--json'] === true) {
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      return outcome.ok ? 0 : 2;
    }
    if (!outcome.ok) {
      progress(outcome.reason ?? '应用失败');
      return 2;
    }
    if (!write) {
      process.stdout.write(`${outcome.patch || '计划没有产生改动'}\n`);
      process.stdout.write('这是预览，未改动 pom.xml。确认后加 --write 落盘。\n');
      return 0;
    }
    process.stdout.write(
      `已按计划 ${outcome.planId} 写回 pom.xml：${outcome.changed.length} 处改动（${outcome.hashAfter}）\n` +
        (outcome.partial
          ? `还有未落盘的分组，下一组：${outcome.nextGroup ?? '无'}（带 --group ${outcome.nextGroup} --hash ${outcome.hashAfter}）\n`
          : '全部候选已落盘：upgrade check 确认 applied → 构建门禁 → scan --only trivy 复扫\n')
    );
    return 0;
  }

  if (action === 'check') {
    const outcome = checkUpgradePlan(root, planId);
    const stateLabel: Record<string, string> = {
      pending: '待落盘',
      partial: '进行中',
      applied: '已完成',
      drift: '与计划不一致'
    };
    const mark = outcome.state === 'drift' ? '✗' : outcome.state === 'applied' ? '✓' : '·';
    process.stdout.write(`${mark} ${stateLabel[outcome.state] ?? outcome.state}（${outcome.state}）：${outcome.message}\n`);
    if (outcome.total !== undefined) {
      process.stdout.write(`  进度 ${outcome.appliedCount ?? 0}/${outcome.total}${outcome.nextGroup ? `，下一组 ${outcome.nextGroup}` : ''}\n`);
    }
    if (outcome.state === 'drift') {
      process.stdout.write(`  期望 ${outcome.expectedHash}\n  实际 ${outcome.actualHash}\n  提示：pom 被手工改过；重新 upgrade plan 后再 apply\n`);
    }
    return outcome.ok ? 0 : 1;
  }

  if (action === 'revert') {
    const outcome = revertUpgradePlan(root, planId);
    if (args.flags['--json'] === true) {
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      return outcome.ok ? 0 : 2;
    }
    if (!outcome.ok) {
      progress(outcome.reason ?? '回滚失败');
      return 2;
    }
    process.stdout.write(`已回滚计划 ${outcome.planId}：pom.xml 恢复到计划前快照（${outcome.hashAfter}）\n`);
    return 0;
  }

  progress(`未知子命令：upgrade ${action}（可选 plan / apply / check / revert）`);
  return 3;
}

function integrateCommand(args: Args): number {
  const positional = args.positionals[0];
  const root = positional && !positional.startsWith('-') ? path.resolve(positional) : args.root;
  if (!fs.existsSync(root)) {
    progress(`目录不存在：${root}`);
    return 2;
  }
  const result = integrate(root, {
    mode: args.flags['--all'] === true ? 'all' : 'auto',
    check: args.flags['--check'] === true,
    fallback: args.flags['--fallback'] === true
  });
  const lines: string[] = [];
  for (const item of result.files) {
    lines.push(`${item.action === 'unchanged' ? '·' : item.action === 'drift' || item.action === 'missing' ? '✗' : '✓'} ${item.file}（${item.action}）`);
  }
  for (const note of result.notes) {
    lines.push(`提示：${note}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  if (!result.ok) {
    const missing = result.files.filter((item) => item.action === 'missing').length;
    const drifted = result.files.filter((item) => item.action === 'drift').length;
    process.stdout.write(
      missing === result.files.length
        ? '尚未接入：执行 integrate（不加 --check）生成策略、启动器与适配器\n'
        : `生成物与策略不一致（缺失 ${missing} / 漂移 ${drifted}）：执行 integrate（不加 --check）重新生成\n`
    );
    return 1;
  }
  return 0;
}

async function nextCommand(args: Args): Promise<number> {
  const root = targetRoot(args);
  if (!fs.existsSync(root)) {
    progress(`目录不存在：${root}`);
    return 2;
  }
  const payload = buildNextAction(root, { writeHandoff: args.flags['--no-handoff'] !== true });
  if (args.flags['--json'] === true) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  const lines = [`[${payload.state}] ${payload.title}`];
  if (payload.progress) {
    lines.push(`进度：${payload.progress}`);
  }
  lines.push(`下一步：${payload.command || '无需操作'}`);
  lines.push(`为什么：${payload.why}`);
  for (const item of payload.blockers) {
    lines.push(`阻塞：${item.message}`, `      建议：${item.suggestion}`);
  }
  for (const item of payload.warnings) {
    lines.push(`注意：${item.message}`, `      建议：${item.suggestion}`);
  }
  if (payload.handoffFile) {
    lines.push(`交接：${payload.handoffFile}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function promptCommand(args: Args): Promise<number> {
  const root = targetRoot(args);
  if (!fs.existsSync(root)) {
    progress(`目录不存在：${root}`);
    return 2;
  }
  const mode = args.flags['--drive'] === true ? ('drive' as const) : ('assist' as const);
  const planId = typeof args.flags['--plan'] === 'string' ? String(args.flags['--plan']) : undefined;
  let failure: string | undefined;
  const failureFile = typeof args.flags['--failure'] === 'string' ? String(args.flags['--failure']) : '';
  if (failureFile) {
    const file = path.resolve(root, failureFile);
    if (fs.existsSync(file)) {
      failure = fs.readFileSync(file, 'utf8').slice(-3000);
    } else {
      progress(`失败日志不存在：${file}`);
    }
  }
  const prompt = buildAgentPrompt(root, { mode, planId, failure });
  if (args.flags['--json'] === true) {
    process.stdout.write(`${JSON.stringify({ mode, planId: planId ?? null, root, prompt }, null, 2)}\n`);
  } else {
    process.stdout.write(`${prompt}\n`);
  }
  return 0;
}

async function explainCommand(args: Args): Promise<number> {
  const root = targetRoot(args);
  if (!fs.existsSync(root)) {
    progress(`目录不存在：${root}`);
    return 2;
  }
  const rawLog = typeof args.flags['--log'] === 'string' ? String(args.flags['--log']) : '';
  const logFile = rawLog ? path.resolve(root, rawLog) : undefined;
  const explanation = explainBuildFailure(root, undefined, logFile);
  if (args.flags['--json'] === true) {
    process.stdout.write(`${JSON.stringify(explanation, null, 2)}\n`);
    return explanation.ok ? 0 : 1;
  }
  const lines = [
    `原因：${explanation.cause}`,
    `影响：${explanation.impact}`,
    `建议：${explanation.suggestion}`
  ];
  if (explanation.evidence.length > 0) {
    lines.push('现场：');
    for (const item of explanation.evidence) {
      lines.push(`  ${item}`);
    }
  }
  if (explanation.errors && explanation.errors.length > 0) {
    lines.push(`编译错误 ${explanation.errors.length} 条：`);
    for (const error of explanation.errors.slice(0, 5)) {
      lines.push(`  ${error.file}:${error.line} ${error.message}`);
    }
  }
  if (explanation.logFile) {
    lines.push(`完整日志：${path.relative(root, explanation.logFile)}`);
  }
  lines.push('下一步：按上面的建议处理；处理完执行 qc next 回到主线，不要继续叠改动');
  process.stdout.write(`${lines.join('\n')}\n`);
  return explanation.ok ? 0 : 1;
}

async function statusCommand(args: Args): Promise<number> {
  const root = targetRoot(args);
  if (!fs.existsSync(root)) {
    progress(`目录不存在：${root}`);
    return 2;
  }
  const status = projectStatus(root);
  if (args.flags['--json'] === true) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }
  const tools = status.tools.map((tool) => `${tool.id}${tool.found ? '✓' : tool.installable ? '✗(可装)' : '✗'}`).join(' ');
  const scan = status.scan.hasResult
    ? `扫描 ${String(status.scan.total ?? 0)} 项（${String(status.scan.generatedAt ?? '')}）`
    : '扫描 尚未执行';
  const plan = status.upgradePlan
    ? `计划 ${String(status.upgradePlan.planId)} ${String(status.upgradePlan.state)} ${String(
        status.upgradePlan.appliedCount ?? 0
      )}/${String(status.upgradePlan.total ?? 0)}${status.upgradePlan.nextGroup ? `，下一组 ${String(status.upgradePlan.nextGroup)}` : ''}`
    : '计划 尚未生成';
  process.stdout.write(
    [`工具 ${tools}`, scan, plan, `pom ${status.pom.hash || '未找到'}`, `下一步 ${status.nextStep}`].join('\n') + '\n'
  );
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
    case 'status':
      return statusCommand(args);
    case 'next':
      return nextCommand(args);
    case 'explain':
      return explainCommand(args);
    case 'prompt':
      return promptCommand(args);
    case 'build':
      return buildCommand(args);
    case 'fix':
      return fixCommand(args);
    case 'tools':
      return toolsCommand(args);
    case 'report':
      return reportCommand(args);
    case 'upgrade':
      return upgradeCommand(args);
    case 'integrate':
      return integrateCommand(args);
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
