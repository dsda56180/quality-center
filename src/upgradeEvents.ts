/**
 * 升级过程事件日志：把 plan / apply / revert / 门禁的真实结果落到磁盘，供后续优化与排障。
 *
 * 落盘位置（都在项目内，随 .quality-center 一起隔离）：
 * - .quality-center/upgrade/upgrade-events.jsonl  —— 追加写的事件流，一行一个事件
 * - .quality-center/upgrade/index.json    —— 所有计划的汇总索引（状态、进度、最后动作）
 * - .quality-center/upgrade/<planId>/gates.json —— 该计划的门禁执行结果
 *
 * 约定：
 * - 只记录事实（时间、来源、哈希、包、失败原因、耗时），不参与任何门禁判断；
 * - 写入失败不影响升级主流程，日志不是业务前置条件；
 * - 成功与失败都记，失败样本正是后续调策略的输入。
 */
import * as fs from 'fs';
import * as path from 'path';

export const UPGRADE_EVENT_SCHEMA = '1';
export const UPGRADE_INDEX_SCHEMA = '1';

export type UpgradeEventSource = 'panel' | 'cli' | 'mcp' | 'api' | 'build' | 'unknown';

export type UpgradeEventAction =
  | 'plan.created'
  | 'plan.reused'
  | 'apply.preview'
  | 'apply.write'
  | 'apply.skip'
  | 'apply.fail'
  | 'revert.ok'
  | 'revert.fail'
  | 'gate.result';

/** 便于统计的数值字段：列不进这里的信息放 reason / packages */
export interface UpgradeEventStats {
  candidates?: number;
  skipped?: number;
  applied?: number;
  blocked?: number;
  cvesBefore?: number;
  cvesAfter?: number;
  resolved?: number;
}

export interface UpgradeGateRecord {
  name: string;
  ok: boolean;
  exitCode?: number;
  durationMs?: number;
  /** 输出末尾（已截断）；完整日志仍在构建日志文件里 */
  outputTail?: string;
}

export interface UpgradeEventStep {
  at: string;
  hashBefore: string;
  hashAfter: string;
  packages: string[];
  group?: string;
}

export interface UpgradeEvent {
  at: string;
  schemaVersion: string;
  toolVersion?: string;
  planId: string;
  action: UpgradeEventAction;
  source: UpgradeEventSource;
  ok: boolean;
  code?: string;
  reason?: string;
  hashBefore?: string;
  hashAfter?: string;
  packages?: string[];
  group?: string;
  groups?: string[];
  durationMs?: number;
  stats?: UpgradeEventStats;
  gate?: UpgradeGateRecord;
  /** 回滚前已落盘的步骤轨迹：steps.json 会被清空，历史留在这里 */
  steps?: UpgradeEventStep[];
}

/** appendUpgradeEvent 的入参：时间、schema、工具版本由本模块补齐 */
export type UpgradeEventInput = Omit<UpgradeEvent, 'at' | 'schemaVersion' | 'toolVersion'>;

export type UpgradeIndexState = 'pending' | 'partial' | 'applied' | 'reverted';

export interface UpgradeIndexPlan {
  planId: string;
  createdAt: string;
  state: UpgradeIndexState;
  candidates: number;
  skipped: number;
  applied: number;
  crossLine: number;
  groups: string[];
  lastAction?: UpgradeEventAction;
  lastEventAt?: string;
  lastSource?: UpgradeEventSource;
  revertedAt?: string;
}

export interface UpgradeIndex {
  schemaVersion: string;
  generatedAt: string;
  plans: UpgradeIndexPlan[];
}

const EVENT_FILE = 'upgrade-events.jsonl';
const INDEX_FILE = 'index.json';
const GATES_FILE = 'gates.json';

export function upgradeDir(root: string): string {
  return path.join(root, '.quality-center', 'upgrade');
}

export function upgradeEventsPath(root: string): string {
  return path.join(upgradeDir(root), EVENT_FILE);
}

export function upgradeIndexPath(root: string): string {
  return path.join(upgradeDir(root), INDEX_FILE);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

let cachedVersion: string | undefined;
let versionLoaded = false;

/** 插件版本（读 package.json），用于把“哪一版的策略产生的样本”分开统计 */
export function upgradeToolVersion(): string | undefined {
  if (versionLoaded) {
    return cachedVersion;
  }
  versionLoaded = true;
  const candidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, '..', '..', 'package.json')
  ];
  for (const file of candidates) {
    const parsed = readJson<{ version?: string }>(file);
    if (parsed?.version) {
      cachedVersion = parsed.version;
      return cachedVersion;
    }
  }
  return undefined;
}

/** 追加一条事件；写盘失败静默（日志不能反过来阻断升级） */
export function appendUpgradeEvent(root: string, input: UpgradeEventInput): void {
  const event: UpgradeEvent = {
    at: new Date().toISOString(),
    schemaVersion: UPGRADE_EVENT_SCHEMA,
    toolVersion: upgradeToolVersion(),
    ...input
  };
  try {
    const file = upgradeEventsPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
  } catch {
    // 只读目录、磁盘满等情况下放弃写日志
  }
}

export function readUpgradeEvents(
  root: string,
  options?: { planId?: string; limit?: number }
): UpgradeEvent[] {
  const text = readText(upgradeEventsPath(root));
  if (!text) {
    return [];
  }
  const events: UpgradeEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as UpgradeEvent;
      if (parsed && typeof parsed.at === 'string' && typeof parsed.action === 'string') {
        if (!options?.planId || parsed.planId === options.planId) {
          events.push(parsed);
        }
      }
    } catch {
      // 单行损坏不影响其它事件
    }
  }
  if (options?.limit && options.limit > 0) {
    return events.slice(-options.limit);
  }
  return events;
}

/** 门禁结果：既写事件流，也留在 <planId>/gates.json，便于按计划回看 */
export function recordUpgradeGate(
  root: string,
  planId: string,
  source: UpgradeEventSource,
  gate: UpgradeGateRecord,
  extra?: {
    hashAfter?: string;
    packages?: string[];
    stats?: UpgradeEventStats;
  }
): void {
  appendUpgradeEvent(root, {
    planId,
    action: 'gate.result',
    source,
    ok: gate.ok,
    code: gate.ok ? undefined : 'gate-failed',
    reason: gate.name,
    gate,
    hashAfter: extra?.hashAfter,
    packages: extra?.packages,
    stats: extra?.stats
  });
  try {
    const dir = path.join(upgradeDir(root), planId);
    const file = path.join(dir, GATES_FILE);
    const existing = readJson<UpgradeGateRecord[]>(file);
    const list = Array.isArray(existing) ? existing : [];
    list.push(gate);
    writeJson(file, list);
  } catch {
    // 同事件流：写不进去就算了
  }
}

export function readUpgradeGates(root: string, planId: string): UpgradeGateRecord[] {
  const parsed = readJson<UpgradeGateRecord[]>(path.join(upgradeDir(root), planId, GATES_FILE));
  return Array.isArray(parsed) ? parsed : [];
}

interface RawPlanFile {
  planId?: string;
  createdAt?: string;
  candidates?: { packageName?: string; crossLine?: boolean }[];
  skipped?: unknown[];
  groups?: { name?: string }[];
}

interface RawStep {
  packages?: string[];
}

/**
 * 重建 index.json：状态从磁盘标记推导（reverted / applied / steps / 无），
 * 不依赖内存调用顺序，CLI 与面板都能读到同一份事实。
 */
export function refreshUpgradeIndex(root: string): UpgradeIndex {
  const dir = upgradeDir(root);
  const events = readUpgradeEvents(root);
  const byPlan = new Map<string, UpgradeEvent[]>();
  events.forEach((event) => {
    if (!event.planId) {
      return;
    }
    const list = byPlan.get(event.planId) ?? [];
    list.push(event);
    byPlan.set(event.planId, list);
  });

  const plans: UpgradeIndexPlan[] = [];
  try {
    const dirs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const planId of dirs) {
      const planFile = path.join(dir, planId, 'plan.json');
      const plan = readJson<RawPlanFile>(planFile);
      const appliedJson = readJson<{ appliedAt?: string }>(path.join(dir, planId, 'applied.json'));
      const revertedJson = readJson<{ revertedAt?: string }>(path.join(dir, planId, 'reverted.json'));
      const steps = readJson<RawStep[]>(path.join(dir, planId, 'steps.json'));
      const candidates = Array.isArray(plan?.candidates) ? plan!.candidates! : [];
      const appliedCount = new Set(
        (Array.isArray(steps) ? steps : []).flatMap((step) =>
          Array.isArray(step.packages) ? step.packages : []
        )
      ).size;
      const planEvents = byPlan.get(planId) ?? [];
      const lastEvent = planEvents[planEvents.length - 1];
      let state: UpgradeIndexState = 'pending';
      if (revertedJson) {
        state = 'reverted';
      } else if (appliedJson) {
        state = 'applied';
      } else if (appliedCount > 0) {
        state = 'partial';
      }
      plans.push({
        planId,
        createdAt: plan?.createdAt ?? '',
        state,
        candidates: candidates.length,
        skipped: Array.isArray(plan?.skipped) ? plan!.skipped!.length : 0,
        applied: appliedCount,
        crossLine: candidates.filter((item) => Boolean(item.crossLine)).length,
        groups: Array.isArray(plan?.groups)
          ? plan!.groups!.map((group) => String(group.name ?? '')).filter(Boolean)
          : [],
        lastAction: lastEvent?.action,
        lastEventAt: lastEvent?.at,
        lastSource: lastEvent?.source,
        revertedAt: revertedJson?.revertedAt
      });
    }
  } catch {
    // 目录还没建起来：返回空索引
  }
  plans.sort((a, b) => (a.createdAt || a.planId).localeCompare(b.createdAt || b.planId));
  const index: UpgradeIndex = {
    schemaVersion: UPGRADE_INDEX_SCHEMA,
    generatedAt: new Date().toISOString(),
    plans
  };
  try {
    writeJson(upgradeIndexPath(root), index);
  } catch {
    // 索引只是派生文件，写不进去不影响主流程
  }
  return index;
}

export function readUpgradeIndex(root: string): UpgradeIndex | undefined {
  return readJson<UpgradeIndex>(upgradeIndexPath(root));
}
