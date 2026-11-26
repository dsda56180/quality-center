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
  isFrameworkManaged,
  planUpgrades,
  UpgradeCandidate,
  UpgradeContext,
  UpgradeMode
} from './upgrader';
import { buildCommandArgs, inferFrameworkVersion, isDependencyManagementAllowed, loadPolicy } from './upgradePolicy';
import { isManagedFrameworkProperty } from './explain';

export const PLAN_SCHEMA_VERSION = '3';

/** 候选分组：按风险与联动关系排队，AI/CI 一组一组推进，失败可二分 */
export type PlanGroup = 'framework' | 'family' | 'independent' | 'cross-line';

export const PLAN_GROUP_ORDER: PlanGroup[] = ['framework', 'family', 'independent', 'cross-line'];

export const PLAN_GROUP_LABEL: Record<PlanGroup, string> = {
  framework: '框架升级',
  family: '框架族对齐',
  independent: '独立依赖',
  'cross-line': '跨大版本（需人工确认）'
};

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
  /** 推进顺序所属分组 */
  group: PlanGroup;
}

export interface PlanSkipped {
  packageName: string;
  reason: string;
  decision: 'manual' | 'policy-denied' | 'unsupported';
  /** 当前解析版本，来自扫描结果或依赖树 */
  installedVersion?: string;
  /** 可用的同线修复版本 */
  fixedVersion?: string;
  /** 该包关联的漏洞数 */
  cveCount?: number;
  /** dependency:tree 里直接引入该传递依赖的父节点 */
  introducedBy?: string[];
}

export interface UpgradePlanFile {
  schemaVersion: string;
  planId: string;
  createdAt: string;
  project: {
    root: string;
    /** 计划的目标 Java 版本；未迁移时等于当前版本 */
    javaVersion?: string;
    /** 项目当前的 Java 版本（仅在发生迁移时出现） */
    sourceJavaVersion?: string;
    frameworkVersion?: string;
    frameworkTarget?: string;
    policySources: string[];
    buildCommand: string[];
  };
  pomHash: string;
  pomHashAfter: string;
  /** 生成计划时 issues.json 的哈希：与 pomHash 一起用于判断计划能否复用 */
  issuesHash?: string;
  candidates: PlanCandidate[];
  /** 分组汇总，按推荐推进顺序排列 */
  groups: { name: PlanGroup; label: string; cveCount: number; candidates: string[] }[];
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
  /** pom 与扫描结果都没变，复用了已有计划 */
  reused?: boolean;
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
  /** 本次实际落盘的包名 */
  applied?: string[];
  /** 只应用了部分候选（按组/按包推进） */
  partial?: boolean;
  /** 下一个建议推进的分组，已全部应用时为空 */
  nextGroup?: PlanGroup;
  /** 本次涉及跨大版本候选，需 allowCrossLine 才允许写 */
  crossLine?: string[];
  /** 当前策略拒绝的候选，不会被写入 */
  blocked?: { packageName: string; reason: string }[];
}

export interface RevertPlanResult {
  ok: boolean;
  planId: string;
  hashBefore: string;
  hashAfter: string;
  reason?: string;
}

export interface CheckPlanResult {
  ok: boolean;
  planId: string;
  state: 'pending' | 'partial' | 'applied' | 'drift';
  message: string;
  expectedHash: string;
  actualHash: string;
  appliedCount?: number;
  total?: number;
  nextGroup?: PlanGroup;
  /** 当前策略拒绝、不能再落盘的候选（例如未授权 dependencyManagement） */
  blocked?: { packageName: string; reason: string }[];
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

/** 候选分组：框架先走，框架族跟着 BOM 对齐，独立依赖其次，跨大版本最后且需人工确认 */
function groupOf(candidate: UpgradeCandidate, crossLine: boolean): PlanGroup {
  // Java 源码级别是框架升级的前置条件，必须和 parent/BOM 同组落盘
  if (candidate.packageName === 'java.version') {
    return 'framework';
  }
  if (crossLine) {
    return 'cross-line';
  }
  if (candidate.groupId === 'org.springframework.boot') {
    return 'framework';
  }
  // 属性会覆盖框架 BOM 的依赖必须跟框架同组落盘，否则框架组单独构建必然解析失败
  if (isManagedFrameworkProperty(candidate.property)) {
    return 'framework';
  }
  return isFrameworkManaged(candidate.packageName) ? 'family' : 'independent';
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

/** 扫描结果的稳定指纹：只取问题标识，不含 generatedAt / 耗时，重扫同一批问题才能命中复用 */
function issueSetHash(issues: Issue[]): string {
  const keys = issues
    .map((issue) =>
      [issue.source, issue.rule, issue.packageName ?? '', issue.file ?? '', issue.line ?? 0, issue.severity].join('|')
    )
    .sort();
  return hashText(keys.join('\n'));
}

/** 生成计划：只读 pom，不写 pom；产物写到 .quality-center/upgrade/<planId>/ */
export function createUpgradePlan(
  root: string,
  issues: Issue[],
  options?: { planId?: string; reuse?: boolean }
): CreatePlanResult {
  const pomFile = path.join(root, 'pom.xml');
  if (!fs.existsSync(pomFile)) {
    throw new Error(`未找到 pom.xml：${pomFile}`);
  }
  const original = fs.readFileSync(pomFile, 'utf8');
  const pomHash = hashText(original);
  const issuesHash = issueSetHash(issues);

  // 复用：pom 与扫描结果都没变、且计划还没落盘时，不新建带时间戳的目录
  if (options?.reuse && !options?.planId) {
    const reusable = findReusablePlan(root, pomHash, issuesHash);
    if (reusable) {
      return reusable;
    }
  }
  const loaded = loadPolicy(root, original);
  const context: UpgradeContext = {
    frameworkTarget: loaded.frameworkTarget,
    currentJavaVersion: loaded.javaVersion,
    targetJavaVersion: loaded.targetJavaVersion,
    allowDependencyManagement: loaded.policy.allowDependencyManagement,
    dependencyManagementAllowlist: loaded.policy.dependencyManagementAllowlist
  };
  const raw = planUpgrades(root, issues, context);

  const forbidden = new Set(loaded.policy.forbiddenPackages);
  const blockedByPolicy: string[] = [];
  const candidates: PlanCandidate[] = [];
  const issueSummary = (packageName: string): {
    installedVersion?: string;
    fixedVersion?: string;
    cveCount: number;
  } => {
    const matched = issues.filter((issue) => (issue.packageName ?? '') === packageName);
    return {
      installedVersion: matched.find((issue) => issue.installedVersion)?.installedVersion,
      fixedVersion: matched.find((issue) => issue.fixedVersion)?.fixedVersion,
      cveCount: matched.length
    };
  };
  const skipped: PlanSkipped[] = raw.skipped.map((item) => ({
    packageName: item.packageName,
    reason: item.reason,
    decision: /dependencyManagement|策略未授权/.test(item.reason) ? ('policy-denied' as const) : ('manual' as const),
    introducedBy: item.introducedBy,
    ...issueSummary(item.packageName)
  }));

  let text = original;
  raw.candidates.forEach((candidate: UpgradeCandidate) => {
    if (forbidden.has(candidate.packageName)) {
      blockedByPolicy.push(candidate.packageName);
      skipped.push({
        packageName: candidate.packageName,
        reason: '策略禁用该依赖（forbiddenPackages），需替换而不是升级',
        decision: 'policy-denied',
        ...issueSummary(candidate.packageName)
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
    // 策略显式指定 targetJavaVersion 时，Java 级别与 Boot 3.x 父 POM 都是用户授权的迁移，
    // 不再按“未知跨大版本”阻断，否则 framework 组无法一次落盘。
    const authorizedJavaMigration = candidate.packageName === 'java.version';
    const authorizedBootLine =
      candidate.groupId === 'org.springframework.boot' &&
      Boolean(loaded.targetJavaVersion && loaded.targetJavaVersion !== loaded.javaVersion) &&
      Boolean(loaded.frameworkTarget?.startsWith('3.')) &&
      loaded.policy.allowNextFrameworkLine;
    const crossLine = authorizedJavaMigration || authorizedBootLine ? false : isCrossLine(candidate.from, candidate.to);
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
      crossLine,
      group: groupOf(candidate, crossLine)
    });
  });

  // 按分组排队：框架 → 框架族 → 独立依赖 → 跨大版本；组内 CVE 多的先来
  candidates.sort(
    (a, b) =>
      PLAN_GROUP_ORDER.indexOf(a.group) - PLAN_GROUP_ORDER.indexOf(b.group) || b.cveCount - a.cveCount
  );
  const groups = PLAN_GROUP_ORDER.filter((name) => candidates.some((item) => item.group === name)).map(
    (name) => {
      const items = candidates.filter((item) => item.group === name);
      return {
        name,
        label: PLAN_GROUP_LABEL[name],
        cveCount: items.reduce((sum, item) => sum + item.cveCount, 0),
        candidates: items.map((item) => item.packageName)
      };
    }
  );

  const patch = unifiedDiff(original, text);
  const planId = options?.planId ?? newPlanId();

  const frameworkVersion = inferFrameworkVersion(original);

  const plan: UpgradePlanFile = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId,
    createdAt: new Date().toISOString(),
    project: {
      root,
      javaVersion: loaded.targetJavaVersion ?? loaded.javaVersion,
      sourceJavaVersion: loaded.targetJavaVersion && loaded.targetJavaVersion !== loaded.javaVersion ? loaded.javaVersion : undefined,
      frameworkVersion,
      frameworkTarget: loaded.frameworkTarget,
      policySources: loaded.sources,
      buildCommand: ['mvn', ...buildCommandArgs(loaded.policy, { skipTests: true })]
    },
    pomHash,
    pomHashAfter: hashText(text),
    issuesHash,
    candidates,
    groups,
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

  // 没有候选就不落盘：避免留下 0 候选的空计划，让 check / status / apply 走进死胡同
  if (candidates.length === 0) {
    return { plan, planDir: '', planPath: '', patchPath: '', patch: '', blockedByPolicy };
  }

  const dir = path.join(planRoot(root), planId);
  fs.mkdirSync(dir, { recursive: true });
  const planPath = path.join(dir, 'plan.json');
  const patchPath = path.join(dir, 'pom.diff');
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  fs.writeFileSync(patchPath, patch, 'utf8');

  return { plan, planDir: dir, planPath, patchPath, patch, blockedByPolicy };
}

/** 找到一份与当前 pom / 扫描结果完全一致、且仍未落盘的计划 */
function findReusablePlan(root: string, pomHash: string, issuesHash: string): CreatePlanResult | undefined {
  const dir = planRoot(root);
  if (!fs.existsSync(dir)) {
    return undefined;
  }
  const ids = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const id of ids) {
    const planPath = path.join(dir, id, 'plan.json');
    const patchPath = path.join(dir, id, 'pom.diff');
    if (!fs.existsSync(planPath) || !fs.existsSync(patchPath)) {
      continue;
    }
    try {
      const plan = JSON.parse(fs.readFileSync(planPath, 'utf8')) as UpgradePlanFile;
      if (plan.pomHash === pomHash && plan.issuesHash === issuesHash) {
        return {
          plan,
          planDir: path.join(dir, id),
          planPath,
          patchPath,
          patch: fs.readFileSync(patchPath, 'utf8'),
          blockedByPolicy: [],
          reused: true
        };
      }
    } catch {
      // 坏文件跳过
    }
  }
  return undefined;
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
  // 已回滚的计划不再算“当前计划”：否则最新目录是一个 revert 掉的计划，
  // check/plan 门禁会把它当成进行中，挡住真正还在推进的旧计划。
  const activeIds = ids.filter((id) => !fs.existsSync(path.join(dir, id, 'reverted.json')));
  const id = planId ?? activeIds[activeIds.length - 1] ?? ids[ids.length - 1];
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

/** 每一步落盘的记录：按组/按包推进时保留完整轨迹，便于 check 与 revert */
export interface PlanStep {
  at: string;
  hashBefore: string;
  hashAfter: string;
  packages: string[];
  group?: PlanGroup;
}

function stepFile(root: string, planId: string): string {
  return path.join(planRoot(root), planId, 'steps.json');
}

function readSteps(root: string, planId: string): PlanStep[] {
  const file = stepFile(root, planId);
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as PlanStep[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 只读导出：交接文件、状态机需要展示「哪一步在什么时候落的盘」 */
export function readPlanSteps(root: string, planId: string): PlanStep[] {
  return readSteps(root, planId);
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 把计划候选还原成可执行候选（apply 与面板预览都走同一个函数，保证两边逐字节一致） */
export function planCandidateToUpgrade(plan: UpgradePlanFile, item: PlanCandidate): UpgradeCandidate {
  return toCandidate(plan, item);
}

/** 应用计划：默认只预览；write=true 时原子写回。支持按分组 / 按包推进，失败可二分定位 */
export function applyUpgradePlan(
  root: string,
  options: {
    planId?: string;
    write: boolean;
    expectedHash?: string;
    /** 只应用这些包（packageName 或候选 id） */
    packages?: string[];
    /** 只应用某个分组 */
    group?: PlanGroup;
    /** 跨大版本候选默认拒绝写入，显式确认后才允许 */
    allowCrossLine?: boolean;
  }
): ApplyPlanResult {
  const plan = readUpgradePlan(root, options.planId);
  const pomFile = path.join(root, 'pom.xml');
  const original = fs.readFileSync(pomFile, 'utf8');
  const hashBefore = hashText(original);
  const mode: ApplyPlanResult['mode'] = options.write ? 'write' : 'dry-run';
  const fail = (reason: string, extra?: Partial<ApplyPlanResult>): ApplyPlanResult => ({
    ok: false,
    mode,
    planId: plan.planId,
    changed: [],
    patch: '',
    reason,
    hashBefore,
    hashAfter: hashBefore,
    ...extra
  });

  if (options.expectedHash && options.expectedHash !== hashBefore) {
    return fail(`pom 已被改动（当前 ${hashBefore}，期望 ${options.expectedHash}）；请重新执行 upgrade plan`);
  }

  const steps = readSteps(root, plan.planId);
  const knownHashes = [plan.pomHash, ...steps.map((step) => step.hashAfter)];
  if (!knownHashes.includes(hashBefore)) {
    return fail(
      `当前 pom 与计划的任何已知状态都不一致（${hashBefore}）；可能被手工改过，请重新执行 upgrade plan`
    );
  }

  let selected = plan.candidates;
  if (options.packages && options.packages.length > 0) {
    const wanted = new Set(options.packages);
    selected = plan.candidates.filter((item) => wanted.has(item.packageName) || wanted.has(item.id));
    if (selected.length === 0) {
      return fail(`指定的包不在这份计划里：${options.packages.join(', ')}`);
    }
  }
  if (options.group) {
    if (!PLAN_GROUP_ORDER.includes(options.group)) {
      return fail(`未知分组：${options.group}（可选 ${PLAN_GROUP_ORDER.join(' / ')}）`);
    }
    selected = selected.filter((item) => item.group === options.group);
    if (selected.length === 0) {
      return fail(`分组 ${options.group} 里没有候选`);
    }
  }

  const appliedBefore = new Set(steps.flatMap((step) => step.packages));
  selected = selected.filter((item) => !appliedBefore.has(item.packageName));
  const policy = loadPolicy(root).policy;
  const blocked = policyBlockedCandidates(plan, policy);
  const blockedNames = new Set(blocked.map((item) => item.packageName));
  const blockedNow = selected.filter((item) => blockedNames.has(item.packageName));
  selected = selected.filter((item) => !blockedNames.has(item.packageName));
  const remainingGroups = PLAN_GROUP_ORDER.filter((name) =>
    plan.candidates.some(
      (item) =>
        item.group === name && !appliedBefore.has(item.packageName) && !blockedNames.has(item.packageName)
    )
  );
  if (selected.length === 0) {
    return {
      ok: true,
      mode,
      planId: plan.planId,
      changed: [],
      patch: '',
      applied: [],
      partial: remainingGroups.length > 0,
      reason:
        blockedNow.length > 0
          ? `策略拒绝 ${blockedNow.map((item) => item.packageName).join(', ')}：需要新增 dependencyManagement，当前策略未授权；已跳过，继续 ${remainingGroups[0] ?? '收尾'}`
          : '选中的候选已经在上一步落盘，无需重复写入',
      hashBefore,
      hashAfter: hashBefore,
      nextGroup: remainingGroups[0],
      blocked
    };
  }

  const crossLinePkgs = selected.filter((item) => item.crossLine).map((item) => item.packageName);
  if (crossLinePkgs.length > 0 && !options.allowCrossLine) {
    return fail(
      `包含跨大版本候选：${crossLinePkgs.join(', ')}；确认兼容性后传 allowCrossLine=true 或用计划逐个人工处理`,
      { crossLine: crossLinePkgs }
    );
  }

  let text = original;
  const changed: ApplyPlanResult['changed'] = [];
  for (const item of selected) {
    const applied = applyUpgrade(text, toCandidate(plan, item));
    if (!applied) {
      return fail(`无法定位 ${item.packageName}，已中止且未改动 pom`);
    }
    text = applied.text;
    applied.changes.forEach((change) => changed.push({ label: change.label, old: change.old, new: change.new }));
  }

  const hashAfter = hashText(text);
  const wholePlan = appliedBefore.size === 0 && selected.length === plan.candidates.length;
  if (wholePlan && hashAfter !== plan.pomHashAfter) {
    return fail(`应用结果与计划不一致（${hashAfter} ≠ ${plan.pomHashAfter}）`);
  }

  const patch = unifiedDiff(original, text);
  const appliedNames = selected.map((item) => item.packageName);
  const cumulative = [...appliedBefore, ...appliedNames];
  const nextGroup = PLAN_GROUP_ORDER.find((name) =>
    plan.candidates.some(
      (item) =>
        item.group === name && !cumulative.includes(item.packageName) && !blockedNames.has(item.packageName)
    )
  );
  const partial = !!nextGroup;

  if (options.write) {
    const dir = path.join(planRoot(root), plan.planId);
    const backup = path.join(dir, 'pom.before.xml');
    if (!fs.existsSync(backup)) {
      fs.writeFileSync(backup, original, 'utf8');
    }
    const tmp = `${pomFile}.quality-center.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, pomFile);

    const nextSteps = [
      ...steps,
      {
        at: new Date().toISOString(),
        hashBefore,
        hashAfter,
        packages: appliedNames,
        group: options.group
      }
    ];
    writeJson(stepFile(root, plan.planId), nextSteps);

    if (!partial) {
      writeJson(path.join(dir, 'applied.json'), {
        planId: plan.planId,
        appliedAt: new Date().toISOString(),
        hashBefore: plan.pomHash,
        hashAfter,
        candidates: plan.candidates.map((item) => `${item.packageName} ${item.from} → ${item.to}`)
      });
    }
  }

  return {
    ok: true,
    mode,
    planId: plan.planId,
    changed,
    patch,
    hashBefore,
    hashAfter,
    applied: appliedNames,
    partial,
    nextGroup,
    crossLine: crossLinePkgs.length > 0 ? crossLinePkgs : undefined,
    blocked: blocked.length > 0 ? blocked : undefined
  };
}

/** 回滚：把 pom 恢复到计划生成前的快照；当前内容必须与最后一次落盘一致才允许回滚 */
export function revertUpgradePlan(root: string, planId?: string): RevertPlanResult {
  const plan = readUpgradePlan(root, planId);
  const dir = path.join(planRoot(root), plan.planId);
  const backupFile = path.join(dir, 'pom.before.xml');
  const pomFile = path.join(root, 'pom.xml');
  const current = fs.readFileSync(pomFile, 'utf8');
  const hashBefore = hashText(current);
  if (!fs.existsSync(backupFile)) {
    return { ok: false, planId: plan.planId, hashBefore, hashAfter: hashBefore, reason: '没有可回滚的快照（计划尚未落盘）' };
  }
  const steps = readSteps(root, plan.planId);
  const lastApplied = steps.length > 0 ? steps[steps.length - 1].hashAfter : plan.pomHashAfter;
  if (hashBefore !== lastApplied) {
    return {
      ok: false,
      planId: plan.planId,
      hashBefore,
      hashAfter: hashBefore,
      reason: `pom 已被手工改动（当前 ${hashBefore}，最后一次落盘 ${lastApplied}）；请先确认改动再回滚`
    };
  }
  const restored = fs.readFileSync(backupFile, 'utf8');
  const tmp = `${pomFile}.quality-center.tmp`;
  fs.writeFileSync(tmp, restored, 'utf8');
  fs.renameSync(tmp, pomFile);
  writeJson(path.join(dir, 'reverted.json'), {
    planId: plan.planId,
    revertedAt: new Date().toISOString(),
    from: hashBefore,
    to: hashText(restored)
  });
  fs.rmSync(path.join(dir, 'applied.json'), { force: true });
  writeJson(stepFile(root, plan.planId), []);
  return { ok: true, planId: plan.planId, hashBefore, hashAfter: hashText(restored) };
}

/** 当前策略下的不可落盘候选：manage 需要用 dependencyManagement，未授权时只报告 */
function policyBlockedCandidates(
  plan: UpgradePlanFile,
  policy: ReturnType<typeof loadPolicy>['policy']
): { packageName: string; reason: string }[] {
  return plan.candidates
    .filter((item) => item.mode === 'manage' && !isDependencyManagementAllowed(policy, item.packageName))
    .map((item) => ({
      packageName: item.packageName,
      reason: '需新增 dependencyManagement 固定传递依赖，策略未授权'
    }));
}

/** CI 门禁：计划是否仍然有效、当前 pom 是否与计划一致 */
export function checkUpgradePlan(root: string, planId?: string): CheckPlanResult {
  const plan = readUpgradePlan(root, planId);
  const pomFile = path.join(root, 'pom.xml');
  const current = fs.readFileSync(pomFile, 'utf8');
  const actualHash = hashText(current);
  const total = plan.candidates.length;
  const steps = readSteps(root, plan.planId);
  const appliedCount = new Set(steps.flatMap((step) => step.packages)).size;
  const appliedNames = new Set(steps.flatMap((step) => step.packages));
  const blocked = policyBlockedCandidates(plan, loadPolicy(root).policy);
  const blockedNames = new Set(blocked.map((item) => item.packageName));
  const nextGroup = PLAN_GROUP_ORDER.find((name) =>
    plan.candidates.some(
      (item) =>
        item.group === name && !appliedNames.has(item.packageName) && !blockedNames.has(item.packageName)
    )
  );
  if (actualHash === plan.pomHash) {
    return {
      ok: false,
      planId: plan.planId,
      state: 'pending',
      message: '计划已生成但尚未落盘（pom 仍是升级前内容）',
      expectedHash: plan.pomHash,
      actualHash,
      appliedCount: 0,
      total,
      nextGroup,
      blocked
    };
  }
  if (actualHash !== plan.pomHashAfter) {
    // 部分应用也是合法中间态：pom 必须等于某一步落盘后的哈希
    if (steps.some((step) => step.hashAfter === actualHash)) {
      return {
        ok: false,
        planId: plan.planId,
        state: 'partial',
        message: `部分应用：已落盘 ${appliedCount}/${total} 个候选，下一组 ${nextGroup ? PLAN_GROUP_LABEL[nextGroup] : '无'}`,
        expectedHash: plan.pomHashAfter,
        actualHash,
        appliedCount,
        total,
        nextGroup,
        blocked
      };
    }
    return {
      ok: false,
      planId: plan.planId,
      state: 'drift',
      message: 'pom 与计划不一致：可能被手工改动，或需要重新生成计划',
      expectedHash: plan.pomHashAfter,
      actualHash,
      appliedCount,
      total
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
      actualHash,
      appliedCount,
      total
    };
  }
  return {
    ok: true,
    planId: plan.planId,
    state: 'applied',
    message: 'pom 与计划一致，落盘记录齐全',
    expectedHash: plan.pomHashAfter,
    actualHash,
    appliedCount,
    total,
    blocked
  };
}
