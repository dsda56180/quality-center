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
  readReport,
  ReportFormat,
  scanProject,
  toolsStatusPayload
} from './agentOps';
import { ToolId, EXTERNAL_TOOLS } from './tools';
import { AgentScanEvent } from './agentApi';
import { applyUpgradePlan, createUpgradePlan, readIssues } from './upgradePlanFile';

interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'quality-center';
const VERSION = packageVersion();

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
      '对项目执行六类扫描（Checkstyle 代码质量 / Gitleaks 密钥泄露 / Trivy 依赖 CVE / SpotBugs+FindSecBugs 静态缺陷 / qcsec 配置安全 / astgrep AST 语义规则），返回 schemaVersion 2 的结构化问题清单与下一步建议。工具缺失时返回 missingTools 与退出码 2。',
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
        }
      }
    }
  },
  {
    name: 'quality_build',
    description:
      '执行 mvn -B -DskipTests package 生成 target 产物（Trivy 依赖清单与 SpotBugs 字节码扫描的前置条件），返回是否成功、耗时与 jar 列表，失败给末尾原因。',
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
    name: 'quality_upgrade_plan',
    description:
      '生成依赖升级计划：只读 pom.xml 与扫描结果，把候选、跳过原因、pom 补丁（unified diff）落到 .quality-center/upgrade/<planId>/，不会修改 pom。返回 planId、pomHash、pomHashAfter 与补丁路径；后续 apply 必须带这三个值。',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        planId: { type: 'string', description: '自定义计划 ID，缺省按时间生成' }
      }
    }
  },
  {
    name: 'quality_upgrade_apply',
    description:
      '按计划落盘 pom：必须传 planId 与 pomHash（计划生成时的哈希），哈希不一致会拒绝写入，避免会话中途改过 pom 时误覆盖。默认只返回 diff 预览，write=true 才写回，并校验落盘结果与计划的 pomHashAfter 一致。',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        planId: { type: 'string', description: '计划 ID' },
        pomHash: { type: 'string', description: '生成计划时返回的 pomHash（含 sha256: 前缀）' },
        write: { type: 'boolean', description: '是否真正写回 pom.xml，默认 false（仅预览）' }
      },
      required: ['planId', 'pomHash']
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
      return asText({ exitCode: scan.exitCode, seconds: Number(scan.seconds.toFixed(1)), ...scan.payload });
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
        jars: outcome.jars,
        reason: outcome.tail,
        nextStep: outcome.ok
          ? '产物已就绪：现在调用 quality_scan 可补齐 SpotBugs 与依赖清单'
          : '构建失败：先按 reason 修复，或调用 quality_tools_install 装 mvn'
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
    case 'quality_upgrade_plan': {
      if (!fs.existsSync(root)) {
        return asText({ error: `目录不存在：${root}` }, true);
      }
      const issues = readIssues(root);
      if (issues.length === 0) {
        return asText({ error: '还没有扫描结果：先调用 quality_scan（可只跑 trivy）' }, true);
      }
      const customId = typeof params.planId === 'string' && params.planId.trim() ? params.planId.trim() : undefined;
      const result = createUpgradePlan(root, issues, { planId: customId });
      const patchPreview = result.patch.length > 2000 ? `${result.patch.slice(0, 2000)}\n…（完整补丁见 patchFile）` : result.patch;
      return asText({
        planId: result.plan.planId,
        schemaVersion: result.plan.schemaVersion,
        pomHash: result.plan.pomHash,
        pomHashAfter: result.plan.pomHashAfter,
        project: result.plan.project,
        candidates: result.plan.candidates.map((item) => ({
          id: item.id,
          packageName: item.packageName,
          from: item.from,
          to: item.to,
          mode: item.mode,
          cveCount: item.cveCount,
          crossLine: item.crossLine,
          note: item.note
        })),
        skipped: result.plan.skipped,
        blockedByPolicy: result.blockedByPolicy,
        planFile: path.relative(root, result.planPath),
        patchFile: path.relative(root, result.patchPath),
        patchPreview,
        nextStep: '审阅 diff 后调用 quality_upgrade_apply（带 planId 与 pomHash）；不要手工改 pom'
      });
    }
    case 'quality_upgrade_apply': {
      const planId = String(params.planId ?? '');
      const expectedHash = String(params.pomHash ?? '');
      if (!planId || !expectedHash) {
        return asText({ error: 'planId 与 pomHash 必填（都由 quality_upgrade_plan 返回）' }, true);
      }
      const write = Boolean(params.write);
      const outcome = applyUpgradePlan(root, { planId, write, expectedHash });
      if (!outcome.ok) {
        return asText({ planId, ok: false, reason: outcome.reason }, true);
      }
      return asText({
        planId: outcome.planId,
        mode: outcome.mode,
        ok: true,
        changed: outcome.changed,
        hashAfter: outcome.hashAfter,
        patch: write ? undefined : outcome.patch,
        nextStep: write
          ? '已写入 pom：调用 quality_build 跑构建门禁，再 quality_scan --only trivy 复扫并确认目标 CVE 消失'
          : '这是预览：确认 diff 无误后传 write=true 落盘'
      });
    }
    default:
      return asText({ error: `未知工具：${name}` }, true);
  }
}

async function handle(request: RpcRequest): Promise<void> {
  const { id, method, params } = request;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion:
          typeof params?.protocolVersion === 'string' ? (params.protocolVersion as string) : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: VERSION },
        instructions:
          'quality-center 提供六类扫描（checkstyle / gitleaks / trivy / spotbugs / qcsec / astgrep）、Maven 构建、外部工具安装与确定性修复。先调 quality_tools_status 确认工具就绪，再用 quality_scan 拿结构化结果。'
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = String(params?.name ?? '');
      const args = (params?.arguments as Record<string, unknown>) ?? {};
      if (!TOOLS.some((tool) => tool.name === name)) {
        replyError(id, -32602, `未知工具：${name}`);
        return;
      }
      try {
        const result = await callTool(name, args);
        reply(id, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
