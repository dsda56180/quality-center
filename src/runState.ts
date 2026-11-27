/**
 * 运行状态与事件日志：MCP / CLI / 面板共用一份「现在谁在做什么」。
 *
 * 设计要点：
 * - 面板不再自己维护 plan/scan 状态，只读 run-state + 事实文件；
 * - MCP 进程与扩展进程是不同进程，用文件做事件总线，扩展侧只监听、只投影；
 * - state.json 原子写，events.jsonl 追加写；事件带单调 seq，面板据此判断是否真的变了。
 */
import * as fs from 'fs';
import * as path from 'path';

export type RunMode = 'assist' | 'drive' | 'autopilot' | 'manual';
export type RunPhase =
  | 'idle'
  | 'baseline_build'
  | 'baseline_scan'
  | 'fix'
  | 'plan'
  | 'apply'
  | 'static_fix'
  | 'rescan'
  | 'finalize'
  | 'done'
  | 'blocked'
  | 'needs_confirm'
  | 'paused';
export type RunStatus = 'running' | 'idle' | 'done' | 'blocked' | 'needs_confirm' | 'paused' | 'failed';

export interface RunActor {
  kind: 'mcp' | 'cli' | 'panel' | 'unknown';
  client?: string;
  tool?: string;
}

export interface RunBlockingItem {
  code: string;
  message: string;
  suggestion?: string;
}

export interface RunState {
  schemaVersion: '1';
  runId: string;
  mode: RunMode;
  /** 本次授权范围；用于收尾时校验静态/密钥等阶段是否真的进入过 */
  scopes?: string[];
  /** 只记录显式 quality_phase 声明的阶段，避免 build 的兜底阶段把 static_fix 冒充成已进入 */
  declaredPhases?: RunPhase[];
  phase: RunPhase;
  status: RunStatus;
  actor: RunActor;
  startedAt: string;
  updatedAt: string;
  lastEventSeq: number;
  revision: string;
  lastTool?: string;
  lastToolStartedAt?: string;
  lastToolOk?: boolean;
  lastToolError?: string;
  baselineScanAt?: string;
  baselineTotal?: number;
  planId?: string;
  lastScan?: { at?: string; total: number; bySource: Record<string, number> };
  build?: { at: string; ok: boolean; planId?: string; drift?: boolean; tests?: string; seconds?: number; gate?: string };
  blocked: RunBlockingItem[];
}

export interface RunEvent {
  seq: number;
  ts: string;
  runId: string;
  actor: RunActor;
  tool?: string;
  type: string;
  data?: unknown;
}

export interface RunSnapshot {
  runId: string;
  mode: RunMode;
  phase: RunPhase;
  status: RunStatus;
  actor: RunActor;
  startedAt: string;
  updatedAt: string;
  ageSeconds: number;
  stalled: boolean;
  lastTool?: string;
  lastToolOk?: boolean;
  lastToolError?: string;
  planId?: string;
  blocked: RunBlockingItem[];
  lastScan?: RunState['lastScan'];
  baselineScanAt?: string;
  baselineTotal?: number;
  build?: RunState['build'];
  active: boolean;
  revision: string;
}

const STATE_REL = path.join('.quality-center', 'run-state.json');
const EVENTS_REL = path.join('.quality-center', 'events.jsonl');
const MAX_EVENTS_LINES = 2000;

let currentActor: RunActor = { kind: 'unknown' };

export function setRunActor(actor: RunActor): void {
  currentActor = actor;
}

export function getRunActor(): RunActor {
  return currentActor;
}

function stateFile(root: string): string {
  return path.join(root, STATE_REL);
}

function eventsFile(root: string): string {
  return path.join(root, EVENTS_REL);
}

function nowIso(): string {
  return new Date().toISOString();
}

function newRunId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-');
  return `run-${stamp}-${process.pid}`;
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function readRunState(root: string): RunState | undefined {
  try {
    const raw = fs.readFileSync(stateFile(root), 'utf8');
    const parsed = JSON.parse(raw) as RunState;
    if (!parsed || parsed.schemaVersion !== '1' || !parsed.runId) {
      return undefined;
    }
    if (!Array.isArray(parsed.blocked)) {
      parsed.blocked = [];
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/** 开始一次运行；同一模式下仍在运行/待确认的 run 直接复用，避免每次 brief 都新开 */
export function beginRun(
  root: string,
  mode: RunMode,
  options: { phase?: RunPhase; force?: boolean; actor?: RunActor; scopes?: string[] } = {}
): RunState {
  const existing = readRunState(root);
  if (
    !options.force &&
    existing &&
    existing.mode === mode &&
    ['running', 'needs_confirm', 'blocked', 'paused'].includes(existing.status) &&
    Date.now() - Date.parse(existing.updatedAt) < 30 * 60_000
  ) {
    return patchRun(
      root,
      { actor: options.actor ?? currentActor, lastTool: undefined, lastToolError: undefined },
      'run.resumed',
      { mode }
    ) ?? existing;
  }
  const state: RunState = {
    schemaVersion: '1',
    runId: newRunId(),
    mode,
    scopes: options.scopes,
    declaredPhases: options.phase ? [options.phase] : [],
    phase: options.phase ?? 'baseline_build',
    status: 'running',
    actor: options.actor ?? currentActor,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    lastEventSeq: 1,
    revision: '1',
    blocked: []
  };
  // 新运行必须重新固定基线，防止上一轮/临时扫描被当成“修复前”
  try {
    fs.rmSync(path.join(root, '.quality-center', 'scan-baseline.json'), { force: true });
    fs.rmSync(path.join(root, '.quality-center', 'final-report.json'), { force: true });
    fs.rmSync(path.join(root, '.quality-center', 'final-report.md'), { force: true });
  } catch {
    // 清理失败不影响运行
  }
  writeJsonAtomic(stateFile(root), state);
  appendEvent(root, state, 'run.started', { mode, phase: state.phase });
  return state;
}

/** 没有显式 begin 时（例如 MCP 直接 scan）补一个 manual run，保证面板能看到 */
export function ensureRun(root: string, actor?: RunActor, mode: RunMode = 'manual'): RunState {
  const existing = readRunState(root);
  if (existing) {
    return existing;
  }
  return beginRun(root, mode, { phase: 'idle', actor: actor ?? currentActor });
}

function appendEvent(
  root: string,
  state: RunState,
  type: string,
  data?: unknown,
  actor?: RunActor,
  tool?: string
): void {
  const event: RunEvent = {
    seq: state.lastEventSeq,
    ts: state.updatedAt,
    runId: state.runId,
    actor: actor ?? state.actor,
    tool,
    type,
    data
  };
  try {
    const file = eventsFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
    // 事件日志只保留最近一段，防止长期运行把磁盘写爆
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_EVENTS_LINES) {
      fs.writeFileSync(file, `${lines.slice(-MAX_EVENTS_LINES).join('\n')}\n`, 'utf8');
    }
  } catch {
    // 事件写失败不影响主流程
  }
}

export function patchRun(
  root: string,
  patch: Partial<Omit<RunState, 'schemaVersion' | 'runId' | 'startedAt' | 'lastEventSeq' | 'revision'>>,
  type: string,
  data?: unknown,
  options: { actor?: RunActor; tool?: string } = {}
): RunState | undefined {
  const state = readRunState(root);
  if (!state) {
    return undefined;
  }
  const seq = state.lastEventSeq + 1;
  const next: RunState = {
    ...state,
    ...patch,
    actor: patch.actor ?? options.actor ?? state.actor,
    updatedAt: nowIso(),
    lastEventSeq: seq,
    revision: String(seq)
  };
  writeJsonAtomic(stateFile(root), next);
  appendEvent(root, next, type, data, next.actor, options.tool);
  return next;
}

export function beginTool(root: string, tool: string, args?: Record<string, unknown>): RunState {
  const state = ensureRun(root);
  const terminal = ['done', 'blocked', 'needs_confirm', 'idle'].includes(state.phase);
  const resumedPhase = terminal ? phaseForTool(tool, state) : undefined;
  return (
    patchRun(
      root,
      {
        status: state.status === 'paused' ? 'paused' : 'running',
        actor: currentActor,
        lastTool: tool,
        lastToolStartedAt: nowIso(),
        lastToolOk: undefined,
        lastToolError: undefined,
        ...(resumedPhase ? { phase: resumedPhase } : {})
      },
      'tool.start',
      { tool, args: summarizeArgs(args) },
      { tool }
    ) ?? state
  );
}

/** 运行态停在终止阶段后，新的工具调用要立即把阶段拉回工作阶段，面板才不会出现“执行中但所有阶段都灰掉” */
function phaseForTool(tool: string, state: RunState): RunPhase | undefined {
  switch (tool) {
    case 'quality_agent_brief':
      return 'baseline_build';
    case 'quality_build':
      return state.baselineTotal === undefined ? 'baseline_build' : state.planId ? 'apply' : 'static_fix';
    case 'quality_scan':
      return state.baselineTotal === undefined ? 'baseline_scan' : 'rescan';
    case 'quality_fix':
    case 'cli:fix':
      return 'fix';
    case 'quality_upgrade_plan':
      return 'plan';
    case 'quality_upgrade_apply':
    case 'quality_upgrade_check':
    case 'quality_upgrade_revert':
      return 'apply';
    case 'quality_finalize':
      return 'finalize';
    default:
      return undefined;
  }
}

export function endTool(
  root: string,
  tool: string,
  result: { ok: boolean; durationMs: number; error?: string; errorCode?: string }
): RunState | undefined {
  const patch: Partial<RunState> = {
    lastTool: tool,
    lastToolOk: result.ok,
    lastToolError: result.ok ? undefined : summarizeToolError(result.error),
    lastToolStartedAt: undefined
  };
  if (result.errorCode === 'blocked') {
    patch.status = 'blocked';
  } else if (result.errorCode === 'needs-confirm') {
    patch.status = 'needs_confirm';
  }
  return patchRun(root, patch, 'tool.end', result, { tool });
}

/** 工具错误经常是嵌套的 MCP JSON；面板只展示人能读的那一层，不把整段 JSON 塞进 UI */
function summarizeToolError(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  let value: unknown = raw;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof value === 'string') {
      const text = value.trim();
      if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
        try {
          value = JSON.parse(text);
          continue;
        } catch {
          return truncate(text);
        }
      }
      return truncate(text);
    }
    if (Array.isArray(value)) {
      value = value
        .map((item) => (item && typeof item === 'object' && 'text' in item ? (item as { text: unknown }).text : item))
        .filter(Boolean)
        .join('\n');
      continue;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.error === 'string' && record.error.trim()) {
        return truncate(record.error.trim());
      }
      if (record.ok === false) {
        const tests = record.tests as { total?: number; failures?: number; errors?: number; state?: string } | undefined;
        const parts = ['执行失败'];
        if (typeof record.exitCode === 'number') {
          parts.push(`exitCode ${record.exitCode}`);
        }
        if (typeof record.gate === 'string') {
          parts.push(`gate ${record.gate}`);
        }
        if (tests && typeof tests.total === 'number') {
          parts.push(`测试 ${tests.state ?? 'unknown'}：${tests.total} 个，失败 ${tests.failures ?? 0}，错误 ${tests.errors ?? 0}`);
        }
        return truncate(parts.join(' · '));
      }
      if ('content' in record) {
        value = record.content;
        continue;
      }
      if (typeof record.message === 'string') {
        return truncate(record.message);
      }
      return truncate(JSON.stringify(record));
    }
    break;
  }
  return truncate(String(value));
}

function truncate(text: string, max = 260): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function setPhase(
  root: string,
  phase: RunPhase,
  status?: RunStatus,
  data?: Record<string, unknown>
): RunState | undefined {
  return patchRun(root, { phase, ...(status ? { status } : {}) }, 'phase.changed', { phase, ...data });
}

export function markBlocked(root: string, item: RunBlockingItem): RunState | undefined {
  const state = readRunState(root);
  if (!state) {
    return undefined;
  }
  const blocked = state.blocked.filter((entry) => entry.code !== item.code);
  blocked.push(item);
  return patchRun(root, { status: 'blocked', blocked }, 'run.blocked', item);
}

export function finishRun(root: string, status: RunStatus = 'done', data?: Record<string, unknown>): RunState | undefined {
  const state = readRunState(root);
  if (!state) {
    return undefined;
  }
  // AI 驱动（autopilot）的运行由 MCP 自己收尾；CLI/面板的临时命令不能把整轮 AI 标成 done，
  // 否则面板会瞬间收起 AI 状态，下一次工具调用再把 phase 停在 done，所有阶段都变成灰色。
  if (state.mode !== 'manual' && currentActor.kind !== 'mcp') {
    return patchRun(
      root,
      { status: state.status === 'paused' ? 'paused' : 'running' },
      'run.delegated',
      { ...data, delegated: true, actor: currentActor.kind }
    );
  }
  return patchRun(root, { status, phase: status === 'done' ? 'done' : 'finalize' }, 'run.finished', data);
}

export function recordScan(root: string, payload: { generatedAt?: string; total: number; bySource: Record<string, number> }): void {
  const state = readRunState(root);
  if (!state) {
    return;
  }
  const patch: Partial<RunState> = { lastScan: payload };
  if (!state.baselineScanAt) {
    patch.baselineScanAt = payload.generatedAt ?? nowIso();
    patch.baselineTotal = payload.total;
    patch.phase = 'baseline_scan';
  } else if (state.phase === 'static_fix') {
    patch.phase = 'rescan';
  }
  patchRun(root, patch, 'scan.completed', payload);
}

export function recordFix(
  root: string,
  detail: { applied: number; skipped: number; files: number; mode: string; fixId?: string; snapshotId?: string; reverted?: boolean }
): void {
  if (!readRunState(root)) {
    return;
  }
  patchRun(root, { phase: 'fix' }, detail.reverted ? 'fix.reverted' : 'fix.completed', detail);
}

export function recordBuild(
  root: string,
  detail: { ok: boolean; planId?: string; drift?: boolean; tests?: string; seconds?: number; gate?: string }
): void {
  if (!readRunState(root)) {
    return;
  }
  patchRun(
    root,
    {
      build: { at: nowIso(), ...detail },
      ...(detail.ok ? {} : { status: 'running' as RunStatus })
    },
    'build.completed',
    detail
  );
}

export function runSnapshot(root: string): RunSnapshot | undefined {
  const state = readRunState(root);
  if (!state) {
    return undefined;
  }
  const updated = Date.parse(state.updatedAt) || 0;
  const ageSeconds = Math.max(0, Math.floor((Date.now() - updated) / 1000));
  const longTool = state.lastTool && /^(quality_build|quality_scan|quality_fix|quality_upgrade_apply|quality_upgrade_plan)$/.test(state.lastTool);
  const stalledAfter = longTool ? 600 : 90;
  const active = ['running', 'idle', 'paused'].includes(state.status) && ageSeconds < 30 * 60;
  return {
    runId: state.runId,
    mode: state.mode,
    phase: state.phase,
    status: state.status,
    actor: state.actor,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    ageSeconds,
    stalled: state.status === 'running' && ageSeconds > stalledAfter,
    lastTool: state.lastTool,
    lastToolOk: state.lastToolOk,
    lastToolError: state.lastToolError,
    planId: state.planId,
    blocked: state.blocked,
    lastScan: state.lastScan,
    baselineScanAt: state.baselineScanAt,
    baselineTotal: state.baselineTotal,
    build: state.build,
    active,
    revision: state.revision
  };
}

function summarizeArgs(args?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!args) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      result[key] = value.length > 160 ? `${value.slice(0, 160)}…` : value;
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = value.slice(0, 10);
    } else {
      result[key] = '[object]';
    }
  }
  return result;
}
