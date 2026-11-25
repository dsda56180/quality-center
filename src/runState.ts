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
  options: { phase?: RunPhase; force?: boolean; actor?: RunActor } = {}
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
  return (
    patchRun(
      root,
      {
        status: state.status === 'paused' ? 'paused' : 'running',
        actor: currentActor,
        lastTool: tool,
        lastToolStartedAt: nowIso(),
        lastToolOk: undefined,
        lastToolError: undefined
      },
      'tool.start',
      { tool, args: summarizeArgs(args) },
      { tool }
    ) ?? state
  );
}

export function endTool(
  root: string,
  tool: string,
  result: { ok: boolean; durationMs: number; error?: string; errorCode?: string }
): RunState | undefined {
  const patch: Partial<RunState> = {
    lastTool: tool,
    lastToolOk: result.ok,
    lastToolError: result.error,
    lastToolStartedAt: undefined
  };
  if (result.errorCode === 'blocked') {
    patch.status = 'blocked';
  } else if (result.errorCode === 'needs-confirm') {
    patch.status = 'needs_confirm';
  }
  return patchRun(root, patch, 'tool.end', result, { tool });
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
