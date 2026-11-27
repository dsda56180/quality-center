#!/usr/bin/env node
/**
 * MCP（Model Context Protocol）stdio 服务端：把质量中心的能力直接暴露成 agent 可调用的工具。
 *
 * 传输：stdin/stdout 上的换行分隔 JSON-RPC 2.0（MCP stdio 标准），stdout 只放协议消息，
 * 一切日志走 stderr。实现零依赖，只用 Node 内置模块。
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  buildProject,
  fixProject,
  installToolHeadless,
  packageVersion,
  parseBuildErrors,
  readReport,
  rollbackFixProject,
  ReportFormat,
  scanProject,
  toolsStatusPayload
} from './agentOps';
import { ToolId, EXTERNAL_TOOLS } from './tools';
import { AgentScanEvent } from './agentApi';
import {
  applyUpgradePlan,
  checkUpgradePlan,
  createUpgradePlan,
  hashText,
  readIssues,
  revertUpgradePlan
} from './upgradePlanFile';
import { digestScan } from './scanDigest';
import { projectStatus } from './status';
import { defaultPolicyDocument } from './upgradePolicy';
import { buildNextAction } from './nextAction';
import { buildAgentFacts, buildAgentPrompt, type AgentScope } from './agentPrompt';
import { explainBuildFailure } from './explain';
import { finalizeRun, type CarryoverItem } from './finalize';
import {
  beginRun,
  beginTool,
  endTool,
  patchRun,
  readRunState,
  setRunActor,
  type RunMode,
  type RunPhase
} from './runState';

interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'quality-center';
const VERSION = packageVersion();
/** 最近一次真实 IDE 客户端的 initialize 信息；面板据此判断“已接入” */
let clientInfo: { name?: string; version?: string } = {};

/**
 * 写客户端心跳。只记录非面板自检的客户端：Trae/Claude/Cursor 等真正 initialize 后，
 * 面板就能在 `.quality-center/mcp-client.json` 看到“谁在什么时候连过”，而不是只猜配置存在。
 */
function writeClientHeartbeat(event: string, detail?: Record<string, unknown>): void {
  const name = clientInfo.name ?? '';
  if (!name || /quality-center|panel/i.test(name)) {
    return;
  }
  try {
    const dir = path.join(process.cwd(), '.quality-center');
    if (!fs.existsSync(dir)) {
      return;
    }
    fs.writeFileSync(
      path.join(dir, 'mcp-client.json'),
      `${JSON.stringify({ client: name, version: clientInfo.version, pid: process.pid, at: Date.now(), event, ...detail }, null, 2)}\n`,
      'utf8'
    );
  } catch {
    // 心跳失败不影响 MCP 主流程
  }
}

/** 调用审计：MCP 只保留最后一次心跳，长期任务需要逐次记录才能复盘“AI 到底做了什么” */
function writeToolAudit(
  root: string,
  entry: { at: string; tool: string; ok: boolean; ms: number; blocked?: boolean; error?: string }
): void {
  try {
    const dir = path.join(root, '.quality-center');
    if (!fs.existsSync(dir)) {
      return;
    }
    fs.appendFileSync(
      path.join(dir, 'mcp-calls.jsonl'),
      `${JSON.stringify({ client: clientInfo.name, pid: process.pid, ...entry })}\n`,
      'utf8'
    );
  } catch {
    // 审计失败不影响主流程
  }
}

/** 只有非空 blocked 数组 / 明确状态才算阻塞，避免把 `"blocked":[]` 误判成失败 */
function looksBlocked(text: string): boolean {
  return (
    /"blocked"\s*:\s*\[\s*[^\]\s]/.test(text) ||
    /"state"\s*:\s*"blocked"/.test(text) ||
    /"status"\s*:\s*"blocked"/.test(text) ||
    /"needs-confirm"\s*:\s*true/.test(text) ||
    /"requires-confirm"\s*:\s*true/.test(text)
  );
}

const log = (message: string): void => {
  process.stderr.write(`[quality-center-mcp] ${message}\n`);
};

function rpcError(message: string, code = -32603): void {
  log(message);
}

/** stdout 只写协议帧（一行一条 JSON） */
function send(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(id: RpcRequest['id'], result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: RpcRequest['id'], code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const PATH_PROP = {
  type: 'string',
  description: '项目根目录（绝对路径或相对当前工作目录），默认当前工作目录'
};

const TOOLS: ToolDef[] = [
  {
    name: 'quality_scan',
    description:
      '对项目执行六类扫描（Checkstyle 代码质量 / Gitleaks 密钥泄露 / Trivy 依赖 CVE / SpotBugs+FindSecBugs 静态缺陷 / qcsec 配置安全 / astgrep AST 语义规则）。默认返回摘要 + Top N（明细写 issues.json），避免把上百条问题全塞进上下文；复扫用 delta=true 只看新增/消失。工具缺失时返回 missingTools 与退出码 2。',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        only: {
          type: 'array',
          items: { type: 'string', enum: ['checkstyle', 'gitleaks', 'trivy', 'spotbugs', 'qcsec', 'astgrep'] },
          description: '只跑指定扫描器，缺省六类全跑'
        },
        failOn: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low', 'info', 'none'],
          description: '达到该严重度即 exitCode 1，默认 high'
        },
        exportFiles: {
          type: 'boolean',
          description: '是否写 .quality-center/issues.json 与 report.md，默认 true'
        },
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          description: 'summary（默认）：计数 + Top N；full：返回全部 issues / ignored / suggestions'
        },
        top: { type: 'number', description: 'summary 模式返回的问题条数，默认 10，上限 50' },
        delta: {
          type: 'boolean',
          description: '与上一次扫描比较，只回新增/消失的数量与代表项，用于复扫验收'
        }
      }
    }
  },
  {
    name: 'quality_status',
    description:
      '一次拿到全局状态：外部工具就绪情况、最近一次扫描与问题计数、当前升级计划的分组进度（pending/partial/applied/drift）、pom 哈希。开始工作或怀疑状态变化时先调它，不要分别调 report/check 去猜。',
    inputSchema: {
      type: 'object',
      properties: { path: PATH_PROP }
    }
  },
  {
    name: 'quality_next',
    description:
      '唯一状态机：返回现在到哪（state）、下一步只做什么（action + command）、为什么、阻塞与警告，并刷新 .quality-center/handoff.md。新会话或换了一个 Agent 时先调它，不要读一堆文档再自己推断流程。',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        writeHandoff: { type: 'boolean', description: '是否刷新 .quality-center/handoff.md，默认 true' }
      }
    }
  },
  {
    name: 'quality_agent_brief',
    description:
      '全权推进的唯一入口：返回当前项目的完整执行指令（含启动前确认、autopilot 一次性修复、冲突调整、逐组落盘与止损规则）+ 当前状态机快照。用户说“按质量中心推进 / 全权升级 / 一次性修完”时先调它；mode=autopilot 表示默认参数已授权、不要反复提问。scope 必须按用户选择：全面修复=all，只升级依赖=upgrade，依赖收敛=consolidation，代码质量=code，密钥=secrets，静态缺陷=static；不要用 all 代替用户明确限定的范围。',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        mode: {
          type: 'string',
          enum: ['drive', 'autopilot'],
          description: 'drive=先做 4 项启动前确认；autopilot=用户已一次性授权，版本边界与门禁以 plan.json / upgrade-policy.json 为准，不逐项提问，最后必须复扫'
        },
        scope: {
          type: 'string',
          enum: ['all', 'upgrade', 'consolidation', 'code', 'secrets', 'static'],
          description: '修复范围。all=全面修复；upgrade=仅依赖版本/CVE；consolidation=依赖收敛；code=确定性代码修复；secrets=硬编码密钥；static=静态缺陷。缺省 all。'
        },
        scopes: {
          type: 'array',
          items: { type: 'string', enum: ['all', 'upgrade', 'consolidation', 'code', 'secrets', 'static'] },
          description: '多选修复范围；优先于 scope。包含 all 等价于全选。面板多选下拉使用。'
        }
      }
    }
  },
  {
    name: 'quality_explain',
    description:
      '把构建失败翻译成「原因 / 影响 / 建议」：覆盖项目属性覆盖 BOM（Non-resolvable import POM）、坐标不存在、依赖解析失败、编译错误（文件/行号）、依赖收敛冲突。构建失败后先调它，不要直接读整份 Maven 日志。',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        text: { type: 'string', description: '直接传入失败日志文本；缺省读 .quality-center/build.log' },
        logFile: { type: 'string', description: '指定日志文件路径（绝对路径或相对项目根目录）' }
      }
    }
  },
  {
    name: 'quality_build',
    description:
      '执行构建生成 target 产物（Trivy 依赖清单与 SpotBugs 字节码扫描的前置条件）。默认按策略跑测试；返回是否成功、耗时、tests 状态（executed/skipped）、pom 是否偏离活动计划（drift）与 jar 列表。drift=true 或 tests=skipped 时结果不能当作验收证据。',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        timeoutSec: { type: 'number', description: '超时秒数，默认 1800' }
      }
    }
  },
  {
    name: 'quality_tools_status',
    description:
      '查看外部工具（mvn / gitleaks / trivy）是否可用、解析到的路径、能否自动安装。这是工具状态的唯一事实来源，调用前不要假设已安装。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'quality_tools_install',
    description:
      '按当前操作系统自动安装缺失的外部工具（Windows 走 winget/choco/scoop 或官方产物，macOS/Linux 走 brew 或官方产物），装到插件自己的工具目录，不改系统 PATH。已安装则直接返回路径。',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: ['mvn', 'gitleaks', 'trivy'], description: '要安装的工具' },
        path: PATH_PROP
      },
      required: ['tool']
    }
  },
  {
    name: 'quality_report',
    description:
      '读取上一次扫描落盘的结果（.quality-center/issues.json / report.md），不重新扫描。适合汇报或复核。',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        format: { type: 'string', enum: ['summary', 'json', 'markdown'], description: '默认 summary' }
      }
    }
  },
  {
    name: 'quality_fix',
    description:
      '应用确定性修复：删除无用导入（UnusedImports/RedundantImport）、调整修饰符顺序（ModifierOrder）、简化布尔比较（SimplifyBooleanExpression）。默认只预览不落盘，write=true 才写文件；改完需要重新 quality_scan 复核。',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        write: { type: 'boolean', description: '是否真正写回文件，默认 false（仅预览）' }
      }
    }
  },
  {
    name: 'quality_fix_rollback',
    description:
      '回滚某次确定性修复：从 .quality-center/fix/<fixId>/before/ 恢复文件，并校验文件仍是修复后的哈希；修复后又被手工改过的文件拒绝覆盖。fixId 缺省读 .quality-center/fix-result.json 的最近一次。',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        fixId: { type: 'string', description: '修复审计 ID，例如 fix-20261125165800；缺省使用最近一次' }
      }
    }
  },
  {
    name: 'quality_upgrade_plan',
    description:
      '生成依赖升级计划：只读 pom.xml 与扫描结果，把候选、分组、跳过原因与 pom 补丁（unified diff）落到 .quality-center/upgrade/<planId>/，不会修改 pom。默认只返回分组概览 + 当前首组候选（避免一次列出几十条），要看别的组传 group，要全量传 detail=full。pom 与扫描结果都没变且 plan 未落盘时传 reuse=true 会复用已有计划而不是新建。',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        planId: { type: 'string', description: '自定义计划 ID，缺省按时间生成' },
        group: {
          type: 'string',
          enum: ['framework', 'family', 'independent', 'cross-line'],
          description: '只返回该分组的候选，缺省返回首组（framework）'
        },
        detail: { type: 'string', enum: ['summary', 'full'], description: 'full 才返回全部候选与完整补丁预览' },
        reuse: { type: 'boolean', description: 'pomHash 与 issuesHash 都没变时复用已有计划，默认 true' },
        replace: {
          type: 'boolean',
          description:
            '明确允许在已有「进行中」计划上生成第二个计划；默认 false。autopilot 收尾阶段不应传 true；只有策略变更导致确实需要换计划时才用。'
        },
        allowUnbuilt: {
          type: 'boolean',
          description:
            '允许在缺少当前 pom 成功构建记录时生成计划。autopilot 不应使用：没有构建会让 trivy/SpotBugs 口径不完整，计划会漏掉传递依赖。'
        }
      }
    }
  },
  {
    name: 'quality_upgrade_authorize',
    description:
      '用户明确确认后，按包授权写 dependencyManagement 版本锁定：只把 packages 追加到 .quality-center/upgrade-policy.json 的 dependencyManagementAllowlist，并重新生成计划；不会直接改 pom。只能用于当前计划里 policy-denied 的间接依赖；调用前必须已向用户逐条说明「引入路径 + 升级/锁定/排除/迁移」并得到确认。',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        packages: {
          type: 'array',
          items: { type: 'string' },
          description: '要授权的 packageName，必须在当前计划 skipped 中且 decision=policy-denied'
        },
        planId: {
          type: 'string',
          description: '当前计划 ID，缺省取最新计划；只用于校验待授权项，不修改旧计划'
        }
      },
      required: ['packages']
    }
  },
  {
    name: 'quality_upgrade_apply',
    description:
      '按计划落盘 pom：必须传 planId 与 pomHash（当前 pom 的哈希），不一致会拒绝写入。默认只返回 diff 预览，write=true 才写回。支持按分组（group）或按包（packages）分批推进：一组写完跑一次构建，失败容易定位；跨大版本候选默认拒绝，需显式 allowCrossLine=true。',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        planId: { type: 'string', description: '计划 ID' },
        pomHash: { type: 'string', description: '当前 pom 的哈希（含 sha256: 前缀），由 plan 或上一次 apply 返回' },
        write: { type: 'boolean', description: '是否真正写回 pom.xml，默认 false（仅预览）' },
        group: {
          type: 'string',
          enum: ['framework', 'family', 'independent', 'cross-line'],
          description: '只应用该分组，按 framework → family → independent → cross-line 顺序推进'
        },
        packages: {
          type: 'array',
          items: { type: 'string' },
          description: '只应用这些包（packageName 或候选 id），与 group 同时给出时取交集'
        },
        allowCrossLine: {
          type: 'boolean',
          description: '允许写入跨大版本候选，默认 false（会被拒绝并返回包名）'
        }
      },
      required: ['planId', 'pomHash']
    }
  },
  {
    name: 'quality_upgrade_check',
    description:
      '校验升级计划与 pom 的当前状态：pending（未落盘）/ partial（已落部分分组）/ applied（完整落盘）/ drift（被手工改动或与计划不一致）。CI 门禁与 AI 收尾都应调它，不要凭感觉判断成功。',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        planId: { type: 'string', description: '计划 ID，缺省取最新一份计划' }
      }
    }
  },
  {
    name: 'quality_upgrade_revert',
    description:
      '回滚某个计划的落盘：把 pom 恢复到计划生成前的快照（.quality-center/upgrade/<planId>/pom.before.xml）。当前 pom 必须与最后一次落盘一致才允许回滚；手工改过会拒绝并说明原因。',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        planId: { type: 'string', description: '计划 ID，缺省取最新一份计划' }
      }
    }
  },
  {
    name: 'quality_phase',
    description:
      '显式推进运行阶段（phase），让面板与事件日志知道 AI 现在做的是静态修复还是复扫。阶段：baseline_build / baseline_scan / fix / plan / apply / static_fix / rescan / finalize；只改状态，不执行动作。',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        phase: {
          type: 'string',
          enum: ['baseline_build', 'baseline_scan', 'fix', 'plan', 'apply', 'static_fix', 'rescan', 'finalize']
        }
      },
      required: ['phase']
    }
  },
  {
    name: 'quality_finalize',
    description:
      '收尾验收：插件从固定的基线快照、当前 issues.json、计划 steps、build-result 计算修复前/后与按来源变化，写入 .quality-center/final-report.json / final-report.md。AI 直接转述，不要自己数。收尾时把本轮失败/隔离/未完成/人工项通过 carryover 登记，下一轮会先复盘。',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        carryover: {
          type: 'array',
          description: '本轮未正常完成的项；下一轮启动时按 kind 复盘，failed/quarantined 禁止原样重试',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['failed', 'quarantined', 'unfinished', 'manual']
              },
              target: { type: 'string', description: '包坐标、规则、文件:行或待决策项' },
              reason: { type: 'string', description: '为什么没完成，必须写事实，不写猜测' },
              action: { type: 'string', description: '已做的处置：回滚/排除/保留/待确认' },
              evidence: { type: 'string', description: '证据文件或命令输出位置' }
            },
            required: ['kind', 'target', 'reason']
          }
        }
      }
    }
  }
];

function asText(result: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    isError
  };
}

async function callTool(name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const root = path.resolve(
    typeof params.path === 'string' && params.path.trim() ? params.path : process.cwd()
  );

  switch (name) {
    case 'quality_status': {
      if (!fs.existsSync(root)) {
        return asText({ error: `目录不存在：${root}` }, true);
      }
      return asText(projectStatus(root));
    }
    case 'quality_agent_brief': {
      if (!fs.existsSync(root)) {
        return asText({ error: `目录不存在：${root}` }, true);
      }
      const mode = params?.mode === 'autopilot' ? 'autopilot' : 'drive';
      const scopesList: AgentScope[] = ['all', 'upgrade', 'consolidation', 'code', 'secrets', 'static'];
      const rawScopes = Array.isArray(params?.scopes) ? params.scopes : [];
      const picked = rawScopes.filter((item): item is AgentScope => scopesList.includes(item as AgentScope));
      const singleScope: AgentScope = scopesList.includes(params?.scope as AgentScope)
        ? (params?.scope as AgentScope)
        : 'all';
      let scopes: AgentScope[] = picked.length ? picked : [singleScope];
      const fullScopes: AgentScope[] = ['upgrade', 'consolidation', 'code', 'secrets', 'static'];
      if (scopes.includes('all') || fullScopes.every((item) => scopes.includes(item))) {
        scopes = ['all'];
      }
      const upgradeScope = scopes.includes('all') || scopes.includes('upgrade');
      const next = upgradeScope ? buildNextAction(root, { writeHandoff: true }) : undefined;
      beginRun(root, mode as RunMode, {
        phase: (upgradeScope ? 'baseline_build' : 'static_fix') as RunPhase
      });
      return asText({
        scopes,
        // 结构化事实：面板 / 其他 Agent 想直接读字段时不用解析 prompt 文本
        facts: buildAgentFacts(root, { mode, scopes }),
        prompt: buildAgentPrompt(root, { mode, scopes }),
        next: next ?? null
      });
    }
    case 'quality_next': {
      if (!fs.existsSync(root)) {
        return asText({ error: `目录不存在：${root}` }, true);
      }
      return asText(buildNextAction(root, { writeHandoff: params.writeHandoff !== false }));
    }
    case 'quality_explain': {
      if (!fs.existsSync(root)) {
        return asText({ error: `目录不存在：${root}` }, true);
      }
      const text = typeof params.text === 'string' && params.text.trim() ? params.text : undefined;
      const rawLog = typeof params.logFile === 'string' && params.logFile.trim() ? params.logFile : undefined;
      const logFile = rawLog ? path.resolve(root, rawLog) : undefined;
      const explanation = explainBuildFailure(root, text, logFile);
      return asText(explanation, !explanation.ok);
    }
    case 'quality_scan': {
      const only = Array.isArray(params.only)
        ? (params.only as string[]).filter((item) => item in { checkstyle: 1, gitleaks: 1, trivy: 1, spotbugs: 1 })
        : undefined;
      if (!fs.existsSync(root)) {
        return asText({ error: `目录不存在：${root}` }, true);
      }
      const scan = await scanProject({
        root,
        only: only as never,
        failOn: (params.failOn as never) ?? 'high',
        exportFiles: params.exportFiles === undefined ? true : Boolean(params.exportFiles),
        onProgress: (event: AgentScanEvent) => {
          if (event.type === 'done') {
            log(`${event.source} 完成：${event.issues} 项`);
          }
        }
      });
      const digest = digestScan(root, scan.payload, {
        detail: params.detail === 'full' ? 'full' : 'summary',
        top: typeof params.top === 'number' ? params.top : undefined,
        delta: Boolean(params.delta)
      });
      return asText({ exitCode: scan.exitCode, seconds: Number(scan.seconds.toFixed(1)), ...digest.body });
    }
    case 'quality_build': {
      const timeoutSec = typeof params.timeoutSec === 'number' ? params.timeoutSec : undefined;
      if (!fs.existsSync(root)) {
        return asText({ error: `目录不存在：${root}` }, true);
      }
      const started = Date.now();
      const outcome = await buildProject(root, (line) => {
        if (/^\[INFO\] (Building|BUILD|---)|^\[ERROR\]/.test(line)) {
          log(line.replace(/^\[INFO\]\s*/, ''));
        }
      });
      const result = {
        ok: outcome.ok,
        exitCode: outcome.code,
        seconds: Number(outcome.seconds.toFixed(1)),
        gate: outcome.gate,
        tests: outcome.tests,
        drift: outcome.drift,
        planId: outcome.planId,
        jars: outcome.jars,
        reason: outcome.tail,
        errors: outcome.errors ?? parseBuildErrors(outcome.tail),
        logFile: outcome.logFile ? path.relative(root, outcome.logFile) : undefined,
        explain: outcome.ok
          ? undefined
          : (() => {
              const explanation = explainBuildFailure(root);
              return {
                kind: explanation.kind,
                cause: explanation.cause,
                impact: explanation.impact,
                suggestion: explanation.suggestion,
                evidence: explanation.evidence
              };
            })(),
        nextStep: outcome.ok
          ? '产物已就绪：现在调用 quality_next 看下一步（通常是复扫或继续下一组）'
          : '构建失败：先调用 quality_explain 或读这里的 explain，按建议处理后再 quality_next；不要跳过门禁'
      };
      if (timeoutSec && Date.now() - started > timeoutSec * 1000) {
        (result as Record<string, unknown>).note = '超时设置只作提示，实际超时为 30 分钟';
      }
      return asText(result, !outcome.ok);
    }
    case 'quality_tools_status':
      return asText(toolsStatusPayload());
    case 'quality_tools_install': {
      const id = String(params.tool ?? '') as ToolId;
      if (!EXTERNAL_TOOLS[id]) {
        return asText({ error: `未知工具：${id}（可选 mvn, gitleaks, trivy）` }, true);
      }
      const outcome = await installToolHeadless(id, root, (line) => log(line));
      return asText(outcome, !outcome.ok);
    }
    case 'quality_report': {
      const format = (params.format as ReportFormat) ?? 'summary';
      if (!['summary', 'json', 'markdown'].includes(format)) {
        return asText({ error: `未知格式：${String(params.format)}` }, true);
      }
      const report = readReport(root, format);
      if (!report.ok) {
        return asText({ error: report.text }, true);
      }
      if (report.format === 'json') {
        return {
          content: [{ type: 'text', text: report.text }],
          isError: false
        };
      }
      return asText({ format: report.format, file: report.file, content: report.text });
    }
    case 'quality_fix': {
      if (!fs.existsSync(root)) {
        return asText({ error: `目录不存在：${root}` }, true);
      }
      const write = Boolean(params.write);
      const outcome = await fixProject(root, write, (event) => {
        if (event.type === 'done' && !event.issues) {
          log(`${event.source} 无问题`);
        }
      });
      return asText({
        ...outcome,
        nextStep: write
          ? '已写回文件：调用 quality_scan 复核问题是否消失'
          : '这只是预览：确认无误后传 write=true 落盘'
      });
    }
    case 'quality_fix_rollback': {
      if (!fs.existsSync(root)) {
        return asText({ error: `目录不存在：${root}` }, true);
      }
      let fixId = typeof params.fixId === 'string' ? params.fixId : '';
      if (!fixId) {
        try {
          const latest = JSON.parse(fs.readFileSync(path.join(root, '.quality-center', 'fix-result.json'), 'utf8')) as {
            fixId?: string;
          };
          fixId = latest.fixId ?? '';
        } catch {
          fixId = '';
        }
      }
      if (!fixId) {
        return asText({ error: '没有可回滚的修复记录：先执行 quality_fix write=true' }, true);
      }
      const result = rollbackFixProject(root, fixId);
      patchRun(root, { phase: 'fix' }, 'fix.rollback', {
        fixId,
        restored: result.restored.length,
        refused: result.refused.length
      });
      return asText({ ...result, nextStep: result.ok ? '已回滚：重新 quality_scan 确认计数' : '查看 refused 后手工处理' }, !result.ok);
    }
    case 'quality_upgrade_plan': {
      if (!fs.existsSync(root)) {
        return asText({ error: `目录不存在：${root}` }, true);
      }
      const issuesFile = path.join(root, '.quality-center', 'issues.json');
      if (!fs.existsSync(issuesFile)) {
        return asText({ error: '还没有扫描结果：先调用 quality_scan（可只跑 trivy）' }, true);
      }
      let reusablePlan = false;
      if (params.replace !== true) {
        try {
          const active = checkUpgradePlan(root);
          reusablePlan = true;
          if (active.state === 'partial' || (active.state === 'pending' && params.reuse !== true)) {
            return asText(
              {
                error: `已有进行中的升级计划 ${active.planId}（${active.appliedCount ?? 0}/${active.total ?? '?'}，下一组 ${active.nextGroup ?? '无'}）。先继续 apply 该计划或 revert，再考虑新计划；确需替换请传 replace=true。`,
                activePlan: active
              },
              true
            );
          }
        } catch {
          // 没有旧计划：继续正常生成
        }
      }
      const activeRun = readRunState(root);
      const runActive =
        !!activeRun &&
        activeRun.status !== 'done' &&
        Date.now() - Date.parse(activeRun.updatedAt) < 30 * 60_000;
      if (!reusablePlan && activeRun && runActive && activeRun.mode !== 'manual' && params.allowUnbuilt !== true) {
        const currentHash = hashText(fs.readFileSync(path.join(root, 'pom.xml'), 'utf8'));
        let build: { ok?: boolean; pomHash?: string; at?: string } | undefined;
        try {
          build = JSON.parse(fs.readFileSync(path.join(root, '.quality-center', 'build-result.json'), 'utf8')) as {
            ok?: boolean;
            pomHash?: string;
            at?: string;
          };
        } catch {
          build = undefined;
        }
        if (!build || build.ok !== true || build.pomHash !== currentHash) {
          return asText(
            {
              error:
                '当前 pom 还没有成功构建记录：先跑 quality_build，再生成升级计划。' +
                '没有 target 时 trivy 只按源码解析、SpotBugs 为 0，计划会漏掉传递依赖，后面会逼出第二个计划。',
              build: build ?? null,
              currentPomHash: currentHash
            },
            true
          );
        }
      }
      const issues = readIssues(root);
      const customId = typeof params.planId === 'string' && params.planId.trim() ? params.planId.trim() : undefined;
      const result = createUpgradePlan(root, issues, {
        planId: customId,
        reuse: params.reuse !== false,
        source: 'mcp'
      });
      if (result.plan.candidates.length === 0) {
        return asText({
          empty: true,
          candidateCount: 0,
          skippedCount: result.plan.skipped.length,
          skippedTop3: result.plan.skipped.slice(0, 3),
          hint: '没有可升级的依赖，未生成计划。确认已跑全量 quality_scan；跨大版本项需人工评估。'
        });
      }
      patchRun(
        root,
        { planId: result.plan.planId, phase: 'plan', status: 'running' },
        'plan.created',
        {
          planId: result.plan.planId,
          candidates: result.plan.candidates.length,
          groups: result.plan.groups.map((group) => ({ name: group.name, total: group.candidates.length })),
          skipped: result.plan.skipped.length,
          reused: result.reused === true
        }
      );
      const detail = params.detail === 'full';
      const requestedGroup = typeof params.group === 'string' ? params.group : undefined;
      const shownGroup = requestedGroup ?? result.plan.groups[0]?.name;
      const compact = (item: (typeof result.plan.candidates)[number]): Record<string, unknown> => ({
        id: item.id,
        packageName: item.packageName,
        from: item.from,
        to: item.to,
        mode: item.mode,
        group: item.group,
        cveCount: item.cveCount,
        crossLine: item.crossLine,
        note: item.note ? item.note.slice(0, 120) : undefined
      });
      const candidates = detail
        ? result.plan.candidates
        : result.plan.candidates.filter((item) => item.group === shownGroup);
      return asText({
        planId: result.plan.planId,
        reused: result.reused === true,
        schemaVersion: result.plan.schemaVersion,
        pomHash: result.plan.pomHash,
        pomHashAfter: result.plan.pomHashAfter,
        project: {
          javaVersion: result.plan.project.javaVersion,
          frameworkVersion: result.plan.project.frameworkVersion,
          frameworkTarget: result.plan.project.frameworkTarget,
          buildCommand: result.plan.project.buildCommand
        },
        groups: result.plan.groups.map((group) => ({
          name: group.name,
          label: group.label,
          count: group.candidates.length,
          cveCount: group.cveCount
        })),
        groupShown: shownGroup,
        candidates: candidates.map((item) => (detail ? item : compact(item))),
        candidateCount: result.plan.candidates.length,
        skippedCount: result.plan.skipped.length,
        skippedTop3: result.plan.skipped.slice(0, 3),
        blockedByPolicy: result.blockedByPolicy,
        planFile: path.relative(root, result.planPath),
        patchFile: path.relative(root, result.patchPath),
        patchPreview: detail
          ? result.patch.length > 4000
            ? `${result.patch.slice(0, 4000)}\n…（完整补丁见 patchFile）`
            : result.patch
          : undefined,
        nextStep: `这是 ${String(shownGroup)} 组：审阅后可 apply(group=${String(shownGroup)})；要其他组传 group=，要全量传 detail=full；不要手工改 pom`
      });
    }
    case 'quality_upgrade_authorize': {
      const packages =
        Array.isArray(params.packages)
          ? Array.from(new Set((params.packages as unknown[]).map((item) => String(item)).filter(Boolean)))
          : [];
      if (!packages.length) {
        return asText({ error: 'packages 必填：只传用户明确确认的间接依赖包名' }, true);
      }
      let targetPlanId = typeof params.planId === 'string' ? params.planId.trim() : '';
      try {
        const active = checkUpgradePlan(root, targetPlanId || undefined);
        targetPlanId = active.planId;
      } catch (error) {
        return asText(
          { error: `没有可授权的升级计划：${error instanceof Error ? error.message : String(error)}` },
          true
        );
      }
      const planFile = path.join(root, '.quality-center', 'upgrade', targetPlanId, 'plan.json');
      let skipped: Array<{ packageName?: string; decision?: string; reason?: string }> = [];
      try {
        const raw = JSON.parse(fs.readFileSync(planFile, 'utf8')) as {
          skipped?: Array<{ packageName?: string; decision?: string; reason?: string }>;
        };
        skipped = raw.skipped ?? [];
      } catch (error) {
        return asText(
          { error: `读取计划 ${targetPlanId} 失败：${error instanceof Error ? error.message : String(error)}` },
          true
        );
      }
      const denied = skipped.filter(
        (item) =>
          item.packageName &&
          (item.decision === 'policy-denied' || /dependencyManagement|策略未授权/.test(item.reason ?? ''))
      );
      const allowed = new Set(denied.map((item) => String(item.packageName)));
      const rejected = packages.filter((name) => !allowed.has(name));
      if (rejected.length) {
        return asText(
          {
            error: `这些包不在当前计划 ${targetPlanId} 的待授权列表里，未写策略：${rejected.join(', ')}`,
            allowed: Array.from(allowed)
          },
          true
        );
      }

      const policyFile = path.join(root, '.quality-center', 'upgrade-policy.json');
      let document: Record<string, unknown>;
      if (fs.existsSync(policyFile)) {
        try {
          document = JSON.parse(fs.readFileSync(policyFile, 'utf8')) as Record<string, unknown>;
        } catch (error) {
          return asText(
            { error: `upgrade-policy.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` },
            true
          );
        }
      } else {
        document = defaultPolicyDocument(root) as unknown as Record<string, unknown>;
      }
      const existing = Array.isArray(document.dependencyManagementAllowlist)
        ? document.dependencyManagementAllowlist.filter((item): item is string => typeof item === 'string')
        : [];
      document.dependencyManagementAllowlist = Array.from(new Set([...existing, ...packages])).sort();
      fs.mkdirSync(path.dirname(policyFile), { recursive: true });
      fs.writeFileSync(policyFile, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

      let created: ReturnType<typeof createUpgradePlan> | undefined;
      try {
        created = createUpgradePlan(root, readIssues(root), {
          source: 'mcp',
          reuse: false
        });
      } catch (error) {
        return asText(
          {
            authorized: packages,
            previousPlanId: targetPlanId,
            error: `策略已写入，但重新生成计划失败：${error instanceof Error ? error.message : String(error)}`
          },
          true
        );
      }
      return asText({
        authorized: packages,
        previousPlanId: targetPlanId,
        planId: created.plan.planId,
        candidateCount: created.plan.candidates.length,
        skippedCount: created.plan.skipped.length,
        planFile: path.relative(root, created.planPath),
        nextStep: '授权只写版本锁定，不改业务代码；下一步按组预览/apply，并在每组后执行 quality_build。'
      });
    }
    case 'quality_upgrade_apply': {
      const planId = String(params.planId ?? '');
      const expectedHash = String(params.pomHash ?? '');
      if (!planId || !expectedHash) {
        return asText({ error: 'planId 与 pomHash 必填（pomHash 传当前 pom 的哈希）' }, true);
      }
      const write = Boolean(params.write);
      const packages =
        Array.isArray(params.packages) && params.packages.length > 0
          ? (params.packages as string[]).map((item) => String(item))
          : undefined;
      const group = typeof params.group === 'string' ? (params.group as never) : undefined;
      const outcome = applyUpgradePlan(root, {
        planId,
        write,
        expectedHash,
        packages,
        group,
        allowCrossLine: Boolean(params.allowCrossLine),
        source: 'mcp'
      });
      if (!outcome.ok) {
        return asText(
          { planId, ok: false, reason: outcome.reason, crossLine: outcome.crossLine },
          true
        );
      }
      if (write) {
        patchRun(
          root,
          { planId: outcome.planId, phase: 'apply', status: 'running' },
          'plan.applied',
          {
            planId: outcome.planId,
            applied: outcome.applied,
            partial: outcome.partial,
            nextGroup: outcome.nextGroup,
            hashAfter: outcome.hashAfter
          }
        );
      }
      return asText({
        planId: outcome.planId,
        mode: outcome.mode,
        ok: true,
        applied: outcome.applied,
        partial: outcome.partial,
        nextGroup: outcome.nextGroup,
        changed: outcome.changed,
        hashAfter: outcome.hashAfter,
        patch: write ? undefined : outcome.patch,
        nextStep: write
          ? outcome.blocked && outcome.blocked.length > 0
            ? `策略拒绝 ${outcome.blocked.map((item) => item.packageName).join(', ')}，已跳过；下一组 ${outcome.nextGroup ?? '收尾'}`
            : outcome.partial
              ? `本组已落盘：先跑 quality_build 门禁，通过后再应用 ${outcome.nextGroup ?? '剩余'} 组；失败可调用 quality_upgrade_revert 回滚`
              : '全部候选已落盘：跑 quality_build 后 quality_scan --only trivy 复扫，并用 quality_upgrade_check 确认 applied'
          : '这是预览：确认 diff 无误后传 write=true 落盘'
      });
    }
    case 'quality_upgrade_check': {
      const planId = typeof params.planId === 'string' && params.planId.trim() ? params.planId.trim() : undefined;
      const outcome = checkUpgradePlan(root, planId);
      return asText({
        ...outcome,
        nextStep:
          outcome.state === 'applied'
            ? '已完整落盘：可运行构建与复扫验收'
            : outcome.state === 'partial'
              ? `还有 ${(outcome.total ?? 0) - (outcome.appliedCount ?? 0)} 个候选未落盘，下一组 ${outcome.nextGroup ?? ''}`
              : outcome.state === 'pending'
                ? '计划尚未落盘：调用 quality_upgrade_apply 应用'
                : 'pom 已偏离计划：重新执行 quality_upgrade_plan 或人工核对'
      }, outcome.state === 'drift');
    }
    case 'quality_upgrade_revert': {
      const planId = typeof params.planId === 'string' && params.planId.trim() ? params.planId.trim() : undefined;
      const outcome = revertUpgradePlan(root, planId, { source: 'mcp' });
      if (outcome.ok) {
        patchRun(
          root,
          { planId: outcome.planId, phase: 'plan', status: 'running' },
          'plan.reverted',
          { planId: outcome.planId, hashAfter: outcome.hashAfter }
        );
      }
      return asText(
        {
          ...outcome,
          nextStep: outcome.ok
            ? '已恢复到计划前快照：确认代码可编译，再重新规划'
            : '回滚被拒绝：先确认 pom 的手工改动'
        },
        !outcome.ok
      );
    }
    case 'quality_phase': {
      const phase = typeof params.phase === 'string' ? params.phase : '';
      const allowed = ['baseline_build', 'baseline_scan', 'fix', 'plan', 'apply', 'static_fix', 'rescan', 'finalize'];
      if (!allowed.includes(phase)) {
        return asText({ error: `未知阶段：${phase}（可选 ${allowed.join(' / ')}）` }, true);
      }
      if (!readRunState(root)) {
        return asText({ error: '当前没有运行记录：先调用 quality_agent_brief 启动一次运行' }, true);
      }
      const state = patchRun(
        root,
        { phase: phase as RunPhase },
        'phase.changed',
        { phase }
      );
      return asText({ ok: true, phase, runId: state?.runId, nextStep: '继续执行该阶段动作，不要只改状态不干活' });
    }
    case 'quality_finalize': {
      const result = finalizeRun(root, {
        carryover: params.carryover as CarryoverItem[] | undefined
      });
      return asText(result, !result.ok);
    }
    default:
      return asText({ error: `未知工具：${name}` }, true);
  }
}

async function handle(request: RpcRequest): Promise<void> {
  const { id, method, params } = request;
  switch (method) {
    case 'initialize':
      const info = (params?.clientInfo ?? {}) as { name?: unknown; version?: unknown };
      clientInfo = {
        name: typeof info.name === 'string' ? info.name : undefined,
        version: typeof info.version === 'string' ? info.version : undefined
      };
      writeClientHeartbeat('initialize');
      reply(id, {
        protocolVersion:
          typeof params?.protocolVersion === 'string' ? (params.protocolVersion as string) : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: VERSION },
        instructions:
          'quality-center 提供六类扫描、Maven 构建、外部工具安装、确定性修复与依赖升级计划。用户要求“按质量中心推进 / 全权升级”时，先调 quality_agent_brief 获取完整执行指令与状态快照，再按其中的 next 执行；用户只要某一类（依赖升级/收敛/代码/密钥/静态）时，quality_agent_brief 必须带对应 scope，不要用默认 all 扩大授权。换会话或状态不确定时先调 quality_next。构建失败先调 quality_explain；不要自己推断流程、手改 pom 或要求用户粘贴长 prompt。用户明确授权全权推进时，按 action 连续执行到 done / needs-confirm / blocked；每次 apply 后必须 build，失败先 explain，同一组两次失败就停手。'
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      writeClientHeartbeat('tools/list', { tools: TOOLS.length });
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = String(params?.name ?? '');
      writeClientHeartbeat('tools/call', { tool: name });
      const args = (params?.arguments as Record<string, unknown>) ?? {};
      if (!TOOLS.some((tool) => tool.name === name)) {
        replyError(id, -32602, `未知工具：${name}`);
        return;
      }
      const root = path.resolve(
        typeof args.path === 'string' && args.path.trim() ? args.path : process.cwd()
      );
      const actor = {
        kind: 'mcp' as const,
        client: clientInfo.name,
        tool: name
      };
      setRunActor(actor);
      if (fs.existsSync(root)) {
        if (name === 'quality_agent_brief') {
          const mode: RunMode = args.mode === 'autopilot' ? 'autopilot' : 'drive';
          beginRun(root, mode, { phase: 'baseline_build', actor });
        }
        const readOnlyTool = new Set([
          'quality_status',
          'quality_next',
          'quality_report',
          'quality_explain',
          'quality_upgrade_check',
          'tools_status'
        ]);
        // 只读工具不新起运行，避免“AI 只是查了一下状态”被面板显示成正在执行
        if (!readOnlyTool.has(name) || readRunState(root)) {
          beginTool(root, name, args);
        }
      }
      const startedAt = Date.now();
      try {
        const result = await callTool(name, args);
        if (fs.existsSync(root)) {
          const text = JSON.stringify(result);
          endTool(root, name, {
            ok: result.isError !== true,
            durationMs: Date.now() - startedAt,
            error: result.isError === true ? text.slice(0, 240) : undefined,
            errorCode: looksBlocked(text) ? 'blocked' : undefined
          });
          writeToolAudit(root, {
            at: new Date().toISOString(),
            tool: name,
            ok: result.isError !== true,
            ms: Date.now() - startedAt,
            blocked: looksBlocked(text) || undefined
          });
        }
        reply(id, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (fs.existsSync(root)) {
          endTool(root, name, {
            ok: false,
            durationMs: Date.now() - startedAt,
            error: message
          });
          writeToolAudit(root, {
            at: new Date().toISOString(),
            tool: name,
            ok: false,
            ms: Date.now() - startedAt,
            error: message.slice(0, 240)
          });
        }
        rpcError(`${name} 执行失败：${message}`);
        replyError(id, -32603, message);
      }
      return;
    }
    case 'resources/list':
      reply(id, { resources: [] });
      return;
    case 'prompts/list':
      reply(id, { prompts: [] });
      return;
    default:
      replyError(id, -32601, `不支持的方法：${method}`);
  }
}

function start(): void {
  log(`服务启动：${SERVER_NAME} ${VERSION}（stdio）`);
  let buffer = '';
  // 串行处理：MCP 客户端可能连发多条，扫描是重操作，
  // 并发会把多份 mvn/trivy 同时拉起；同时保证 stdin 关闭时等所有请求收尾。
  let queue: Promise<void> = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) {
        continue;
      }
      let request: RpcRequest;
      try {
        request = JSON.parse(line) as RpcRequest;
      } catch {
        replyError(null, -32700, '无法解析的 JSON');
        continue;
      }
      const isNotification = request.id === undefined || request.method.startsWith('notifications/');
      queue = queue
        .then(() =>
          handle({ ...request, id: isNotification ? null : request.id }).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            if (isNotification) {
              log(`处理通知失败：${message}`);
            } else {
              replyError(request.id ?? null, -32603, message);
            }
          })
        )
        .catch((error) => log(`队列异常：${error instanceof Error ? error.message : String(error)}`));
    }
  });
  process.stdin.on('end', () => {
    queue
      .then(() => {
        log('stdin 关闭，退出');
        process.exit(0);
      })
      .catch(() => process.exit(0));
  });
}

start();
