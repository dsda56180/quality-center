/**
 * 升级计划文件（Plan V3）：把「要升什么、升到哪、会改成什么样」落成可审、可回滚、可进 CI 的产物。
 *
 * 关键约定：
 * - plan 只写 .quality-center/upgrade/<planId>/ 下的 plan.json 与 pom.diff，绝不改 pom.xml；
 * - apply 必须带 planId + pomHash，哈希对不上就拒绝落盘（AI 在会话中间改过 pom 时不会误覆盖）；
 * - apply 重新执行同一组候选后校验 pomHashAfter，保证落盘结果与预览的 diff 完全一致。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Issue } from './model';
import {
  applyUpgrade,
  planUpgrades,
  UpgradeCandidate,
  UpgradeContext,
  UpgradeMode
} from './upgrader';
import { buildCommandArgs, inferFrameworkVersion, loadPolicy } from './upgradePolicy';

export const PLAN_SCHEMA_VERSION = '3';

export interface PlanCandidate {
  id: string;
  packageName: string;
  groupId: string;
  artifactId: string;
  from: string;
  to: string;
  mode: UpgradeMode;
  cveCount: number;
  source: string;
  sourceKind: string;
  note?: string;
  property?: string;
  affects?: string[];
  /** 跨大版本（如 poi 4.x → 5.x）：必须人工确认，不能当同线补丁处理 */
  crossLine: boolean;
}

export interface PlanSkipped {
  packageName: string;
  reason: string;
  decision: 'manual' | 'policy-denied' | 'unsupported';
}

export interface UpgradePlanFile {
  schemaVersion: string;
  planId: string;
  createdAt: string;
  project: {
    root: string;
    javaVersion?: string;
    frameworkVersion?: string;
    frameworkTarget?: string;
    policySources: string[];
    buildCommand: string[];
  };
  pomHash: string;
  pomHashAfter: string;
  candidates: PlanCandidate[];
  skipped: PlanSkipped[];
  gates: { name: string; command: string[]; expectation: string }[];
  patchFile: string;
}

export interface CreatePlanResult {
  plan: UpgradePlanFile;
  planDir: string;
  planPath: string;
  patchPath: string;
  patch: string;
  /** 策略拒绝的依赖，直接展示给用户 */
  blockedByPolicy: string[];
}

export interface ApplyPlanResult {
  ok: boolean;
  mode: 'dry-run' | 'write';
  planId: string;
  changed: {
    label: string;
    old: string;
    new: string;
  }[];
  patch: string;
  reason?: string;
  hashBefore: string;
  hashAfter: string;
}

export interface CheckPlanResult {
  ok: boolean;
  planId: string;
  state: 'pending' | 'applied' | 'drift';
  message: string;
  expectedHash: string;
  actualHash: string;
}

export function hashText(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** 取版本主号，用于判断是否跨大版本 */
function majorOf(version: string): string {
  return version.match(/(\d+)/)?.[1] ?? version;
}

export function isCrossLine(from: string, to: string): boolean {
  const a = majorOf(from);
  const b = majorOf(to);
  return a !== b;
}

/** 读 .quality-center/issues.json；兼容 AgentPayload 形态与其它产出方的字段命名（package/currentVersion） */
export function readIssues(root: string): Issue[] {
  const file = path.join(root, '.quality-center', 'issues.json');
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed && Array.isArray((parsed as { issues?: unknown[] }).issues)
        ? (parsed as { issues: unknown[] }).issues
        : [];
    return list
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => normalizeIssue(item));
  } catch {
    return [];
  }
}

/** 字段归一化：不同产出方对依赖名的字段叫法不同，读入层必须兜住，否则计划会静默为空 */
function normalizeIssue(raw: Record<string, unknown>): Issue {
  const packageName =
    (typeof raw.packageName === 'string' && raw.packageName) ||
    (typeof raw.package === 'string' && raw.package) ||
    undefined;
  const installedVersion =
    (typeof raw.installedVersion === 'string' && raw.installedVersion) ||
    (typeof raw.currentVersion === 'string' && raw.currentVersion) ||
    undefined;
  const fixedVersion =
    (typeof raw.fixedVersion === 'string' && raw.fixedVersion) ||
    (Array.isArray(raw.fixedVersions) ? raw.fixedVersions.join(',') : undefined);
  return {
    ...(raw as unknown as Issue),
    source: raw.source as Issue['source'],
    severity: raw.severity as Issue['severity'],
    rule: typeof raw.rule === 'string' ? raw.rule : '',
    message: typeof raw.message === 'string' ? raw.message : '',
    packageName,
    installedVersion,
    fixedVersion
  };
}

function splitLines(text: string): string[] {
  // 去掉末尾换行再切分，否则会多出一个空行上下文，导致 git apply 失败
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n');
}

interface DiffOp {
  type: ' ' | '-' | '+';
  text: string;
}

/** 行级 LCS diff；超大文件退化为整段替换，避免 DP 表撑爆内存 */
function diffOps(a: string[], b: string[]): DiffOp[] {
  const prefix: DiffOp[] = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    prefix.push({ type: ' ', text: a[start] });
    start += 1;
  }

  const suffix: DiffOp[] = [];
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
    suffix.unshift({ type: ' ', text: a[endA] });
  }

  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const cells = (middleA.length + 1) * (middleB.length + 1);
  const middle: DiffOp[] = [];
  if (cells > 4_000_000) {
    middleA.forEach((text) => middle.push({ type: '-', text }));
    middleB.forEach((text) => middle.push({ type: '+', text }));
  } else {
    const width = middleB.length + 1;
    const table = new Uint32Array(cells);
    for (let i = middleA.length - 1; i >= 0; i -= 1) {
      for (let j = middleB.length - 1; j >= 0; j -= 1) {
        const index = i * width + j;
        table[index] =
          middleA[i] === middleB[j]
            ? table[(i + 1) * width + (j + 1)] + 1
            : Math.max(table[(i + 1) * width + j], table[index + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < middleA.length && j < middleB.length) {
      if (middleA[i] === middleB[j]) {
        middle.push({ type: ' ', text: middleA[i] });
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
        middle.push({ type: '-', text: middleA[i] });
        i += 1;
      } else {
        middle.push({ type: '+', text: middleB[j] });
        j += 1;
      }
    }
    while (i < middleA.length) {
      middle.push({ type: '-', text: middleA[i] });
      i += 1;
    }
    while (j < middleB.length) {
      middle.push({ type: '+', text: middleB[j] });
      j += 1;
    }
  }

  return [...prefix, ...middle, ...suffix];
}

/** 生成统一 diff 文本（3 行上下文），可直接 git apply */
export function unifiedDiff(oldText: string, newText: string, file = 'pom.xml', context = 3): string {
  if (oldText === newText) {
    return '';
  }
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffOps(a, b);

  const changed = ops
    .map((op, index) => ({ op, index }))
    .filter((item) => item.op.type !== ' ')
    .map((item) => item.index);
  if (changed.length === 0) {
    return '';
  }

  const hunks: { start: number; end: number }[] = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(ops.length - 1, changed[0] + context);
  for (const index of changed.slice(1)) {
    if (index - context <= end + 1) {
      end = Math.min(ops.length - 1, index + context);
    } else {
      hunks.push({ start, end });
      start = Math.max(0, index - context);
      end = Math.min(ops.length - 1, index + context);
    }
  }
  hunks.push({ start, end });

  const lines: string[] = [`--- a/${file}`, `+++ b/${file}`];
  let aLine = 1;
  let bLine = 1;
  let cursor = 0;
  for (const hunk of hunks) {
    while (cursor < hunk.start) {
      if (ops[cursor].type !== '+') {
        aLine += 1;
      }
      if (ops[cursor].type !== '-') {
        bLine += 1;
      }
      cursor += 1;
    }
    const body = ops.slice(hunk.start, hunk.end + 1);
    const aCount = body.filter((op) => op.type !== '+').length;
    const bCount = body.filter((op) => op.type !== '-').length;
    lines.push(`@@ -${aLine},${aCount} +${bLine},${bCount} @@`);
    for (const op of body) {
      lines.push(`${op.type}${op.text}`);
      if (op.type !== '+') {
        aLine += 1;
      }
      if (op.type !== '-') {
        bLine += 1;
      }
      cursor += 1;
    }
  }
  return `${lines.join('\n')}\n`;
}

function planRoot(root: string): string {
  return path.join(root, '.quality-center', 'upgrade');
}

function newPlanId(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `up-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes()
  )}${pad(now.getSeconds())}`;
}

/** 生成计划：只读 pom，不写 pom；产物写到 .quality-center/upgrade/<planId>/ */
export function createUpgradePlan(root: string, issues: Issue[], options?: { planId?: string }): CreatePlanResult {
  const pomFile = path.join(root, 'pom.xml');
  if (!fs.existsSync(pomFile)) {
    throw new Error(`未找到 pom.xml：${pomFile}`);
  }
  const original = fs.readFileSync(pomFile, 'utf8');
  const loaded = loadPolicy(root, original);
  const context: UpgradeContext = { frameworkTarget: loaded.frameworkTarget };
  const raw = planUpgrades(root, issues, context);

  const forbidden = new Set(loaded.policy.forbiddenPackages);
  const blockedByPolicy: string[] = [];
  const candidates: PlanCandidate[] = [];
  const skipped: PlanSkipped[] = raw.skipped.map((item) => ({
    packageName: item.packageName,
    reason: item.reason,
    decision: 'manual' as const
  }));

  let text = original;
  raw.candidates.forEach((candidate: UpgradeCandidate) => {
    if (forbidden.has(candidate.packageName)) {
      blockedByPolicy.push(candidate.packageName);
      skipped.push({
        packageName: candidate.packageName,
        reason: '策略禁用该依赖（forbiddenPackages），需替换而不是升级',
        decision: 'policy-denied'
      });
      return;
    }
    const applied = applyUpgrade(text, candidate);
    if (!applied) {
      skipped.push({
        packageName: candidate.packageName,
        reason: '无法在 pom.xml 中定位该依赖，需人工处理',
        decision: 'manual'
      });
      return;
    }
    text = applied.text;
    candidates.push({
      id: `c${candidates.length + 1}`,
      packageName: candidate.packageName,
      groupId: candidate.groupId,
      artifactId: candidate.artifactId,
      from: candidate.from,
      to: candidate.to,
      mode: candidate.mode,
      cveCount: candidate.cveCount,
      source: candidate.source,
      sourceKind: candidate.sourceKind,
      note: candidate.note,
      property: candidate.property,
      affects: candidate.affects,
      crossLine: isCrossLine(candidate.from, candidate.to)
    });
  });

  const patch = unifiedDiff(original, text);
  const planId = options?.planId ?? newPlanId();
  const dir = path.join(planRoot(root), planId);
  fs.mkdirSync(dir, { recursive: true });

  const frameworkVersion = inferFrameworkVersion(original);

  const plan: UpgradePlanFile = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId,
    createdAt: new Date().toISOString(),
    project: {
      root,
      javaVersion: loaded.javaVersion,
      frameworkVersion,
      frameworkTarget: loaded.frameworkTarget,
      policySources: loaded.sources,
      buildCommand: ['mvn', ...buildCommandArgs(loaded.policy, { skipTests: true })]
    },
    pomHash: hashText(original),
    pomHashAfter: hashText(text),
    candidates,
    skipped,
    gates: [
      {
        name: loaded.policy.buildGate,
        command: ['mvn', ...buildCommandArgs(loaded.policy, { skipTests: true })],
        expectation: 'BUILD SUCCESS'
      },
      {
        name: 'rescan',
        command: ['node', '<扩展目录>/out/cli.js', 'scan', root, '--only', 'trivy', '--json', '--no-export'],
        expectation: '目标 CVE 消失'
      },
      {
        name: 'tests',
        command: ['mvn', ...buildCommandArgs(loaded.policy, { skipTests: false })],
        expectation: loaded.policy.buildGate === 'test' ? '72 项及本项目全部单测通过' : '跨大版本或策略要求时必跑'
      }
    ],
    patchFile: 'pom.diff'
  };

  const planPath = path.join(dir, 'plan.json');
  const patchPath = path.join(dir, 'pom.diff');
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  fs.writeFileSync(patchPath, patch, 'utf8');

  return { plan, planDir: dir, planPath, patchPath, patch, blockedByPolicy };
}

/** 读取计划：显式 planId 或目录下最新的一份 */
export function readUpgradePlan(root: string, planId?: string): UpgradePlanFile {
  const dir = planRoot(root);
  if (!fs.existsSync(dir)) {
    throw new Error('还没有升级计划：先执行 upgrade plan');
  }
  const ids = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const id = planId ?? ids[ids.length - 1];
  if (!id) {
    throw new Error('还没有升级计划：先执行 upgrade plan');
  }
  const file = path.join(dir, id, 'plan.json');
  if (!fs.existsSync(file)) {
    throw new Error(`计划不存在：${id}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as UpgradePlanFile;
}

function toCandidate(plan: UpgradePlanFile, item: PlanCandidate): UpgradeCandidate {
  return {
    packageName: item.packageName,
    groupId: item.groupId,
    artifactId: item.artifactId,
    from: item.from,
    to: item.to,
    cveCount: item.cveCount,
    mode: item.mode,
    source: item.source,
    sourceKind: item.sourceKind as UpgradeCandidate['sourceKind'],
    property: item.property,
    affects: item.affects,
    alternatives: [item.to],
    note: item.note
  };
}

/** 应用计划：默认只预览；write=true 时原子写回并校验落盘结果哈希 */
export function applyUpgradePlan(
  root: string,
  options: { planId?: string; write: boolean; expectedHash?: string }
): ApplyPlanResult {
  const plan = readUpgradePlan(root, options.planId);
  const pomFile = path.join(root, 'pom.xml');
  const original = fs.readFileSync(pomFile, 'utf8');
  const hashBefore = hashText(original);

  if (options.expectedHash && options.expectedHash !== hashBefore) {
    return {
      ok: false,
      mode: options.write ? 'write' : 'dry-run',
      planId: plan.planId,
      changed: [],
      patch: '',
      reason: `pom 已被改动（当前 ${hashBefore}，期望 ${options.expectedHash}）；请重新执行 upgrade plan`,
      hashBefore,
      hashAfter: hashBefore
    };
  }
  if (hashBefore !== plan.pomHash) {
    return {
      ok: false,
      mode: options.write ? 'write' : 'dry-run',
      planId: plan.planId,
      changed: [],
      patch: '',
      reason: `计划已过期：pom 当前哈希 ${hashBefore} 与计划 ${plan.pomHash} 不一致`,
      hashBefore,
      hashAfter: hashBefore
    };
  }

  let text = original;
  const changed: ApplyPlanResult['changed'] = [];
  for (const item of plan.candidates) {
    const applied = applyUpgrade(text, toCandidate(plan, item));
    if (!applied) {
      return {
        ok: false,
        mode: options.write ? 'write' : 'dry-run',
        planId: plan.planId,
        changed: [],
        patch: '',
        reason: `无法定位 ${item.packageName}，已中止且未改动 pom`,
        hashBefore,
        hashAfter: hashBefore
      };
    }
    text = applied.text;
    applied.changes.forEach((change) => changed.push({ label: change.label, old: change.old, new: change.new }));
  }

  const hashAfter = hashText(text);
  if (hashAfter !== plan.pomHashAfter) {
    return {
      ok: false,
      mode: options.write ? 'write' : 'dry-run',
      planId: plan.planId,
      changed: [],
      patch: '',
      reason: `应用结果与计划不一致（${hashAfter} ≠ ${plan.pomHashAfter}）`,
      hashBefore,
      hashAfter: hashBefore
    };
  }

  const patch = unifiedDiff(original, text);
  if (options.write) {
    const tmp = `${pomFile}.quality-center.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, pomFile);
    const record = {
      planId: plan.planId,
      appliedAt: new Date().toISOString(),
      hashBefore,
      hashAfter,
      candidates: plan.candidates.map((item) => `${item.packageName} ${item.from} → ${item.to}`)
    };
    fs.writeFileSync(path.join(planRoot(root), plan.planId, 'applied.json'), `${JSON.stringify(record, null, 2)}\n`);
  }

  return { ok: true, mode: options.write ? 'write' : 'dry-run', planId: plan.planId, changed, patch, hashBefore, hashAfter };
}

/** CI 门禁：计划是否仍然有效、当前 pom 是否与计划一致 */
export function checkUpgradePlan(root: string, planId?: string): CheckPlanResult {
  const plan = readUpgradePlan(root, planId);
  const pomFile = path.join(root, 'pom.xml');
  const current = fs.readFileSync(pomFile, 'utf8');
  const actualHash = hashText(current);
  if (actualHash === plan.pomHash) {
    return {
      ok: false,
      planId: plan.planId,
      state: 'pending',
      message: '计划已生成但尚未落盘（pom 仍是升级前内容）',
      expectedHash: plan.pomHash,
      actualHash
    };
  }
  if (actualHash !== plan.pomHashAfter) {
    return {
      ok: false,
      planId: plan.planId,
      state: 'drift',
      message: 'pom 与计划不一致：可能被手工改动，或需要重新生成计划',
      expectedHash: plan.pomHashAfter,
      actualHash
    };
  }
  const appliedFile = path.join(planRoot(root), plan.planId, 'applied.json');
  if (!fs.existsSync(appliedFile)) {
    return {
      ok: false,
      planId: plan.planId,
      state: 'drift',
      message: 'pom 内容与计划一致，但缺少 applied.json 落盘记录（可能被手工写入）',
      expectedHash: plan.pomHashAfter,
      actualHash
    };
  }
  return {
    ok: true,
    planId: plan.planId,
    state: 'applied',
    message: 'pom 与计划一致，落盘记录齐全',
    expectedHash: plan.pomHashAfter,
    actualHash
  };
}
