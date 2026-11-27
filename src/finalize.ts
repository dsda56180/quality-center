/**
 * 运行收尾：把基线、当前扫描、计划进度、构建/测试状态合成一份可审计的最终报告。
 *
 * 动机：之前 AI 自己数 500/660，和 issues.json 的 582 对不上；收尾必须由插件从事实文件计算，
 * AI 只负责转述，不再参与算数。
 */
import * as fs from 'fs';
import * as path from 'path';
import { checkUpgradePlan, PLAN_GROUP_LABEL, readUpgradePlan } from './upgradePlanFile';
import { readScanBaseline } from './scanDigest';
import { patchRun, readRunState } from './runState';

export interface FinalizeResult {
  ok: boolean;
  reason?: string;
  baseline?: { at: string; total: number; bySource: Record<string, number> };
  current?: { at: string; total: number; bySource: Record<string, number> };
  delta?: {
    added: number;
    removed: number;
    totalChange: number;
    bySource: Record<string, { before: number; after: number; change: number }>;
    newlyVisible: string[];
  };
  plan?: Record<string, unknown>;
  build?: Record<string, unknown>;
  blocked?: string[];
  /** 收尾后仍未自动处理的项：必须写进报告，不能只留在面板或聊天里 */
  remaining?: {
    policyDenied: {
      packageName: string;
      installedVersion?: string;
      fixedVersion?: string;
      cveCount?: number;
      reason?: string;
    }[];
    crossLine: {
      packageName: string;
      from?: string;
      to: string;
      cveCount?: number;
    }[];
    reportOnly: { source: string; label: string; count: number; reason: string }[];
    secrets: number;
  };
  /** AI 收尾时登记的失败/隔离/未完成/人工项，供下一轮复盘 */
  carryover?: CarryoverItem[];
  evidence?: string[];
  reportFile?: string;
  markdownFile?: string;
}

export type CarryoverKind = 'failed' | 'quarantined' | 'unfinished' | 'manual';

export interface CarryoverItem {
  kind: CarryoverKind;
  target: string;
  reason: string;
  action?: string;
  evidence?: string;
}

export interface FinalizeOptions {
  carryover?: CarryoverItem[];
}

const CARRYOVER_KINDS: CarryoverKind[] = ['failed', 'quarantined', 'unfinished', 'manual'];

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** 收尾登记的条目要能跨会话复用，限制长度并拒绝空目标/空原因 */
function sanitizeCarryover(input: unknown): CarryoverItem[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const result: CarryoverItem[] = [];
  for (const raw of input.slice(0, 100)) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const item = raw as Record<string, unknown>;
    const target = cleanText(item.target, 200);
    const reason = cleanText(item.reason, 600);
    if (!target || !reason) {
      continue;
    }
    const kind = CARRYOVER_KINDS.includes(item.kind as CarryoverKind)
      ? (item.kind as CarryoverKind)
      : 'unfinished';
    result.push({
      kind,
      target,
      reason,
      action: cleanText(item.action, 300) || undefined,
      evidence: cleanText(item.evidence, 200) || undefined
    });
  }
  return result;
}

const SOURCES = ['checkstyle', 'gitleaks', 'trivy', 'spotbugs', 'qcsec', 'astgrep'];

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function summaryOf(summary: Record<string, unknown> | undefined, total: number): Record<string, number> {
  const result: Record<string, number> = { total };
  for (const source of SOURCES) {
    result[source] = Number(summary?.[source] ?? 0);
  }
  for (const severity of ['critical', 'high', 'medium', 'low']) {
    result[severity] = Number(summary?.[severity] ?? 0);
  }
  return result;
}

/** 取源码与构建清单的最新修改时间；跳过 target/.git/.quality-center，避免把构建产物算成“改动” */
function latestSourceMtime(root: string): number {
  const skip = new Set(['target', '.git', '.quality-center', 'node_modules', '.idea', '.mvn']);
  let latest = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.(java|kt|xml|properties|yml|yaml)$/i.test(entry.name)) {
        try {
          latest = Math.max(latest, fs.statSync(full).mtimeMs);
        } catch {
          // 文件在遍历时消失：忽略
        }
      }
    }
  };
  const pom = path.join(root, 'pom.xml');
  try {
    latest = fs.statSync(pom).mtimeMs;
  } catch {
    // 非 Maven 项目：只按源码判断
  }
  walk(path.join(root, 'src'));
  return latest;
}

export function finalizeRun(root: string, options: FinalizeOptions = {}): FinalizeResult {
  const issuesFile = path.join(root, '.quality-center', 'issues.json');
  const currentRaw = readJson<{
    generatedAt?: string;
    issues?: unknown[];
    summary?: Record<string, unknown>;
  }>(issuesFile);
  if (!currentRaw || !Array.isArray(currentRaw.issues)) {
    return { ok: false, reason: '还没有当前扫描结果：先执行 quality_scan 复扫' };
  }
  const current = {
    at: currentRaw.generatedAt ?? '',
    total: currentRaw.issues.length,
    bySource: summaryOf(currentRaw.summary, currentRaw.issues.length)
  };
  // 收尾必须基于“改动之后的复扫”：AI 经常做完修复直接 finalize，面板于是永远看不到新结果。
  // 用事实文件的 mtime 兜底，和 AI 自己怎么说无关。
  const currentMs = Date.parse(current.at) || fs.statSync(issuesFile).mtimeMs;
  const latestChange = latestSourceMtime(root);
  if (latestChange && currentMs + 2000 < latestChange) {
    return {
      ok: false,
      reason:
        `当前扫描结果早于源码/依赖变更（扫描 ${new Date(currentMs).toISOString()}，` +
        `最新变更 ${new Date(latestChange).toISOString()}）：先完成改动，再 quality_scan 复扫，最后 quality_finalize。`
    };
  }
  const baselineDigest = readScanBaseline(root);
  const baseline = baselineDigest
    ? {
        at: baselineDigest.generatedAt,
        total: baselineDigest.total,
        bySource: summaryOf(baselineDigest.summary, baselineDigest.total)
      }
    : undefined;

  let delta: FinalizeResult['delta'];
  if (baselineDigest && baseline) {
    const beforeKeys = new Set(baselineDigest.keys);
    const afterKeys = new Set((currentRaw.issues as { source?: string; rule?: string; package?: string; file?: string; line?: number }[]).map((issue) =>
      [issue.source, issue.rule, issue.package ?? '', issue.file ?? '', issue.line ?? 0].join('|')
    ));
    let added = 0;
    for (const key of afterKeys) {
      if (!beforeKeys.has(key)) {
        added += 1;
      }
    }
    let removed = 0;
    for (const key of beforeKeys) {
      if (!afterKeys.has(key)) {
        removed += 1;
      }
    }
    const bySource: Record<string, { before: number; after: number; change: number }> = {};
    const newlyVisible: string[] = [];
    for (const source of SOURCES) {
      const before = baseline.bySource[source] ?? 0;
      const after = current.bySource[source] ?? 0;
      bySource[source] = { before, after, change: after - before };
      if (before === 0 && after > 0) {
        newlyVisible.push(source);
      }
    }
    delta = {
      added,
      removed,
      totalChange: current.total - baseline.total,
      bySource,
      newlyVisible
    };
  }

  let plan: Record<string, unknown> | undefined;
  let remaining: FinalizeResult['remaining'];
  try {
    const check = checkUpgradePlan(root);
    const file = readUpgradePlan(root, check.planId);
    plan = {
      planId: check.planId,
      state: check.state,
      applied: check.appliedCount ?? 0,
      total: check.total ?? 0,
      nextGroup: check.nextGroup,
      nextLabel: check.nextGroup ? PLAN_GROUP_LABEL[check.nextGroup] : undefined,
      blocked: check.blocked ?? [],
      groups: []
    };
    // 真实已落盘数从 steps 读，避免用计划候选数猜
    const stepsFile = path.join(root, '.quality-center', 'upgrade', check.planId, 'steps.json');
    const steps = readJson<{ packages?: string[] }[]>(stepsFile) ?? [];
    const appliedNames = new Set(steps.flatMap((step) => step.packages ?? []));
    plan.groups = file.groups.map((group) => ({
      name: group.name,
      label: PLAN_GROUP_LABEL[group.name],
      total: group.candidates.length,
      applied: group.candidates.filter((candidate) => appliedNames.has(candidate)).length
    }));
    plan.applied = appliedNames.size;

    const skipped = file.skipped
      .filter((item) => item.decision === 'policy-denied' || /dependencyManagement|策略未授权/.test(item.reason))
      .map((item) => ({
        packageName: item.packageName,
        installedVersion: item.installedVersion,
        fixedVersion: item.fixedVersion,
        cveCount: item.cveCount,
        reason: item.reason
      }));
    const crossLine = file.candidates
      .filter((item) => item.crossLine === true)
      .map((item) => ({
        packageName: item.packageName,
        from: item.from,
        to: item.to,
        cveCount: item.cveCount
      }));
    const bySource = current.bySource;
    const reportOnly: NonNullable<FinalizeResult['remaining']>['reportOnly'] = [];
    const addReport = (source: string, label: string, reason: string): void => {
      const count = Number(bySource[source] ?? 0);
      if (count > 0) {
        reportOnly.push({ source, label, count, reason });
      }
    };
    addReport('spotbugs', 'SpotBugs 静态缺陷', '多数是编码/防御性规范（如序列化、编码、空值、资源），不是业务语义；可让 AI 逐条给 diff，确认后改');
    addReport('qcsec', '配置安全', '暴露面、权限模型与凭证策略要按部署环境决定');
    addReport('astgrep', 'AST 语义规则', '权限模型、输入校验、安全设计需要业务判断');
    addReport('checkstyle', '代码质量', '未命中确定性修复清单，需人工复核');
    remaining = {
      policyDenied: skipped,
      crossLine,
      reportOnly,
      secrets: Number(bySource.gitleaks ?? 0)
    };
  } catch {
    plan = undefined;
    remaining = undefined;
  }

  const build = readJson<Record<string, unknown>>(path.join(root, '.quality-center', 'build-result.json'));
  const state = readRunState(root);
  const blocked = [
    ...(state?.blocked.map((item) => item.message) ?? []),
    ...((plan?.blocked as { packageName: string; reason: string }[] | undefined) ?? []).map(
      (item) => `${item.packageName}: ${item.reason}`
    )
  ];

  const result: FinalizeResult = {
    ok: true,
    baseline,
    current,
    delta,
    plan,
    build,
    blocked,
    remaining,
    carryover: sanitizeCarryover(options.carryover),
    evidence: [
      '.quality-center/issues.json',
      '.quality-center/scan-baseline.json',
      '.quality-center/scan-digest.json',
      '.quality-center/build-result.json',
      '.quality-center/run-state.json',
      '.quality-center/events.jsonl',
      '.quality-center/mcp-calls.jsonl',
      '.quality-center/fix-result.json',
      ...(plan ? [`.quality-center/upgrade/${String(plan.planId)}/plan.json`, `.quality-center/upgrade/${String(plan.planId)}/steps.json`] : [])
    ]
  };

  const reportFile = path.join(root, '.quality-center', 'final-report.json');
  const markdownFile = path.join(root, '.quality-center', 'final-report.md');
  fs.writeFileSync(reportFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownFile, renderMarkdown(result), 'utf8');
  result.reportFile = path.relative(root, reportFile).split(path.sep).join('/');
  result.markdownFile = path.relative(root, markdownFile).split(path.sep).join('/');

  patchRun(
    root,
    { phase: 'finalize', status: blocked.length > 0 ? 'blocked' : 'done' },
    'final.summary',
    {
      baseline: baseline?.total,
      current: current.total,
      planId: plan?.planId,
      state: plan?.state
    }
  );

  return result;
}

function renderMarkdown(result: FinalizeResult): string {
  const lines: string[] = ['# 质量中心 · 最终验收', '', '## 本次修复结果', ''];
  if (!result.baseline) {
    lines.push('> 没有基线快照：本轮无法给出修复前/后对比，只能给当前计数。');
  } else {
    lines.push(`- 基线：${result.baseline.total} 条（${result.baseline.at}）`);
    lines.push(`- 当前：${result.current?.total ?? 0} 条（${result.current?.at ?? ''}）`);
    if (result.delta) {
      lines.push(`- 变化：${result.delta.totalChange >= 0 ? '+' : ''}${result.delta.totalChange}（新增 ${result.delta.added} / 消失 ${result.delta.removed}）`);
      if (result.delta.newlyVisible.length > 0) {
        lines.push(`- 首次可见（不是回归）：${result.delta.newlyVisible.join(', ')}`);
      }
    }
  }
  if (result.delta) {
    lines.push('', '| 来源 | 基线 | 当前 | 变化 |', '| --- | --- | --- | --- |');
    for (const [source, item] of Object.entries(result.delta.bySource)) {
      lines.push(`| ${source} | ${item.before} | ${item.after} | ${item.change >= 0 ? '+' : ''}${item.change} |`);
    }
  }
  if (result.plan) {
    lines.push('', '## 升级计划', '', `- 计划：${String(result.plan.planId)}（${String(result.plan.state)}）`);
    lines.push(`- 落盘：${String(result.plan.applied)}/${String(result.plan.total)}，下一组 ${String(result.plan.nextLabel ?? '无')}`);
    const groups = result.plan.groups as { label: string; total: number; applied: number }[] | undefined;
    if (groups && groups.length > 0) {
      lines.push('', '分组进度：');
      for (const group of groups) {
        lines.push(`- ${group.label}：${group.applied}/${group.total} 已落盘`);
      }
    }
  }
  if (result.carryover && result.carryover.length > 0) {
    const kindLabel: Record<CarryoverKind, string> = {
      failed: '失败未落盘',
      quarantined: '已隔离（禁止原样重试）',
      unfinished: '未完成',
      manual: '待人工决策'
    };
    lines.push('', '## 中途失败与待处置', '');
    lines.push('> 由 AI 在收尾时登记；下一轮启动会先复盘这里，不依赖聊天记录。', '');
    for (const kind of CARRYOVER_KINDS) {
      const items = result.carryover.filter((item) => item.kind === kind);
      if (items.length === 0) {
        continue;
      }
      lines.push(`### ${kindLabel[kind]}（${items.length} 项）`, '');
      for (const item of items) {
        lines.push(`- \`${item.target}\`：${item.reason}${item.action ? `；处置：${item.action}` : ''}${item.evidence ? `（证据：${item.evidence}）` : ''}`);
      }
      lines.push('');
    }
  }
  if (result.remaining) {
    const remaining = result.remaining;
    lines.push('', '## 剩余项', '');
    if (remaining.policyDenied.length > 0) {
      lines.push('### 待授权间接依赖（' + remaining.policyDenied.length + ' 项）', '');
      lines.push('> 由其他依赖带入，需要写 dependencyManagement 锁版本；当前策略未授权，AI 默认不写。');
      lines.push('> 授权方式：面板「授权覆盖」按项勾选，写入 upgrade-policy.json 后重新生成计划；不直接改 pom。');
      lines.push('', '| 包 | 当前版本 | 修复版本 | CVE | 原因 |', '| --- | --- | --- | --- | --- |');
      for (const item of remaining.policyDenied) {
        lines.push(
          '| ' + item.packageName + ' | ' + (item.installedVersion ?? '?') + ' | ' +
          (item.fixedVersion ?? '?') + ' | ' + (item.cveCount ?? 0) + ' | ' + (item.reason ?? '') + ' |'
        );
      }
      lines.push('');
    }
    if (remaining.crossLine.length > 0) {
      lines.push('### 跨大版本（' + remaining.crossLine.length + ' 项）', '');
      lines.push('> 会改变 API、驱动协议或依赖基线；默认不写，确认兼容性后才允许 --allow-cross-line。');
      lines.push('', '| 包 | 当前版本 | 目标版本 | CVE |', '| --- | --- | --- | --- |');
      for (const item of remaining.crossLine) {
        lines.push(
          '| ' + item.packageName + ' | ' + (item.from ?? '?') + ' | ' + item.to + ' | ' + (item.cveCount ?? 0) + ' |'
        );
      }
      lines.push('');
    }
    if (remaining.reportOnly.length > 0) {
      let reportOnlyTotal = 0;
      for (const item of remaining.reportOnly) {
        reportOnlyTotal += item.count;
      }
      lines.push('### 只报告、需人工判断（' + reportOnlyTotal + ' 项）', '');
      lines.push('| 来源 | 数量 | 为什么没自动改 |', '| --- | --- | --- |');
      for (const item of remaining.reportOnly) {
        lines.push('| ' + item.label + ' | ' + item.count + ' | ' + item.reason + ' |');
      }
      lines.push('');
    }
    if (remaining.secrets > 0) {
      lines.push('### 密钥（' + remaining.secrets + ' 处）', '', '- 不读取、不打印原值；先轮换并清理历史，再改配置引用。', '');
    }
    lines.push('## 下一步', '');
    if (remaining.policyDenied.length > 0) {
      lines.push('- 先决定 ' + remaining.policyDenied.length + ' 项间接依赖是否授权写 dependencyManagement；授权后重新生成计划，不手改 pom。');
    }
    if (remaining.crossLine.length > 0) {
      lines.push('- 再确认 ' + remaining.crossLine.length + ' 项跨大版本的 JDK/框架/API 兼容性；确认后单独执行这一组并显式允许。');
    }
    if (remaining.reportOnly.length > 0) {
      lines.push('- 静态/安全剩余项按来源筛选，优先高严重度；可让 AI 尝试生成 diff，也可手动逐项处理。');
    }
    if (remaining.secrets > 0) {
      lines.push('- 密钥先轮换，再改配置引用；不要交给 AI 自动改原值。');
    }
  }
  if (result.build) {
    const tests = result.build.tests as
      | { state?: string; total?: number; failures?: number; errors?: number; skipped?: number }
      | undefined;
    const testState = tests?.state ?? 'unknown';
    const testDetail = testState === 'executed'
      ? `（${tests?.total ?? 0} 个，失败 ${tests?.failures ?? 0}，错误 ${tests?.errors ?? 0}，跳过 ${tests?.skipped ?? 0}）`
      : testState === 'skipped' ? '（构建成功不代表测试通过）' : '';
    lines.push('', '## 构建与测试', '', `- 结果：${result.build.ok === true ? '成功' : '失败'}`);
    lines.push(`- 测试：${testState}${testDetail}`);
    if (result.build.gate) {
      lines.push(`- 门禁：${String(result.build.gate)}`);
    }
    if (result.build.seconds !== undefined) {
      lines.push(`- 耗时：${String(result.build.seconds)} 秒`);
    }
    lines.push(`- pom drift：${result.build.drift === true ? '是（结果不可验收）' : '否'}`);
  }
  if (result.blocked && result.blocked.length > 0) {
    lines.push('', '## 阻塞', '', ...result.blocked.map((item) => `- ${item}`));
  }
  lines.push('', '## 证据', '', ...(result.evidence ?? []).map((item) => `- ${item}`));
  return `${lines.join('\n')}\n`;
}
