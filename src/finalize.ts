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
  evidence?: string[];
  reportFile?: string;
  markdownFile?: string;
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

export function finalizeRun(root: string): FinalizeResult {
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
  } catch {
    plan = undefined;
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
  const lines: string[] = ['# 质量中心 · 最终验收', ''];
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
  }
  if (result.build) {
    const tests = (result.build.tests as { state?: string; total?: number; failures?: number } | undefined)?.state ?? 'unknown';
    lines.push('', '## 构建', '', `- 结果：${result.build.ok === true ? '成功' : '失败'}`);
    lines.push(`- 测试：${tests}${tests === 'executed' ? `（${String((result.build.tests as { total?: number }).total ?? 0)} 个）` : tests === 'skipped' ? '（构建成功不代表测试通过）' : ''}`);
    lines.push(`- pom drift：${result.build.drift === true ? '是（结果不可验收）' : '否'}`);
  }
  if (result.blocked && result.blocked.length > 0) {
    lines.push('', '## 阻塞', '', ...result.blocked.map((item) => `- ${item}`));
  }
  lines.push('', '## 证据', '', ...(result.evidence ?? []).map((item) => `- ${item}`));
  return `${lines.join('\n')}\n`;
}
