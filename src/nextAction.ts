/**
 * 唯一状态机：把 issues.json / plan.json / steps.json / build-result.json 收敛成
 * 「现在到哪、下一步只做什么、为什么、命令是什么」。
 *
 * 动机：AI 和人都容易在多个入口之间迷路——面板说一套、README 说一套、计划说一套。
 * 这里不新增状态，只把已有事实投影成一个动作；CLI、MCP、面板都应读它。
 */
import * as fs from 'fs';
import * as path from 'path';
import { explainBuildFailure, detectManagedPropertyOverrides, readBuildState } from './explain';
import { loadPolicy } from './upgradePolicy';
import { projectStatus } from './status';
import {
  checkUpgradePlan,
  hashText,
  PLAN_GROUP_LABEL,
  PlanGroup,
  readPlanSteps,
  readUpgradePlan,
  UpgradePlanFile
} from './upgradePlanFile';

const QC = 'node .quality-center/bin/qc.cjs';

export type NextState =
  | 'no-project'
  | 'blocked'
  | 'not-scanned'
  | 'clean'
  | 'no-plan'
  | 'empty-plan'
  | 'drift'
  | 'pending'
  | 'partial'
  | 'applied'
  | 'build-failed'
  | 'verify'
  | 'done'
  | 'needs-confirm';

export type NextActionKind =
  | 'none'
  | 'scan'
  | 'plan'
  | 'apply'
  | 'build'
  | 'rescan'
  | 'explain'
  | 'revert'
  | 'install'
  | 'integrate'
  | 'confirm';

export interface NextBlocker {
  code: string;
  severity: 'blocking' | 'warning';
  message: string;
  suggestion: string;
}

export interface NextGroupStatus {
  name: PlanGroup;
  label: string;
  total: number;
  applied: number;
  state: 'done' | 'doing' | 'todo';
}

export interface NextActionPayload {
  schemaVersion: '1';
  generatedAt: string;
  state: NextState;
  title: string;
  action: NextActionKind;
  command: string;
  why: string;
  progress?: string;
  plan?: {
    planId: string;
    state: string;
    appliedCount: number;
    total: number;
    /** 非 manage 候选数：直接声明或由 BOM/父 POM 管理的依赖 */
    directCount?: number;
    nextGroup?: PlanGroup;
    nextLabel?: string;
    blocked?: { packageName: string; reason: string }[];
    javaVersion?: string;
    frameworkVersion?: string;
    frameworkTarget?: string;
    cveTotal?: number;
    skippedCount?: number;
    /** 面板解释用：哪些包被跳过、为什么、版本与引入方 */
    skipped?: {
      packageName: string;
      reason: string;
      decision: string;
      installedVersion?: string;
      fixedVersion?: string;
      cveCount?: number;
      introducedBy?: string[];
    }[];
    groups: NextGroupStatus[];
    /** 面板只读明细：让人直接看懂“升什么、升到哪”，不用打开 handoff.md */
    candidates?: {
      packageName: string;
      from: string;
      to: string;
      group: PlanGroup;
      groupLabel: string;
      cveCount: number;
      crossLine: boolean;
    }[];
  };
  scan?: {
    total: number;
    generatedAt?: string;
    deltaBaseline?: string | null;
    summary?: Record<string, number>;
  };
  pom?: { file: string; hash: string };
  policy?: { buildGate: string; frameworkTarget?: string; allowNextFrameworkLine: boolean };
  blockers: NextBlocker[];
  warnings: NextBlocker[];
  handoffFile?: string;
}

function safePlan(root: string): { plan: UpgradePlanFile; check: ReturnType<typeof checkUpgradePlan> } | null {
  try {
    const check = checkUpgradePlan(root);
    return { plan: readUpgradePlan(root, check.planId), check };
  } catch {
    return null;
  }
}

function scanCount(status: ReturnType<typeof projectStatus>): number {
  return Number(status.scan.total ?? 0);
}

function groupStatuses(plan: UpgradePlanFile | undefined, applied: Set<string>): NextGroupStatus[] {
  if (!plan) {
    return [];
  }
  return plan.groups.map((group) => {
    const done = group.candidates.filter((name) => applied.has(name)).length;
    return {
      name: group.name,
      label: PLAN_GROUP_LABEL[group.name],
      total: group.candidates.length,
      applied: done,
      state: done === 0 ? 'todo' : done === group.candidates.length ? 'done' : 'doing'
    };
  });
}

function severitySummary(summary: Record<string, number> | undefined): string {
  if (!summary) {
    return '';
  }
  return ['critical', 'high', 'medium', 'low', 'info']
    .map((key) => (Number(summary[key] ?? 0) > 0 ? `${key} ${summary[key]}` : ''))
    .filter(Boolean)
    .join(' / ');
}

/** 计算唯一下一步；默认同时刷新 .quality-center/handoff.md */
export function buildNextAction(root: string, options?: { writeHandoff?: boolean }): NextActionPayload {
  const payload = computeNextAction(root);
  if (options?.writeHandoff !== false) {
    const file = writeHandoff(root, payload);
    payload.handoffFile = path.relative(root, file);
  }
  return payload;
}

function computeNextAction(root: string): NextActionPayload {
  const status = projectStatus(root);
  const blockers: NextBlocker[] = [];
  const warnings: NextBlocker[] = [];
  const generatedAt = new Date().toISOString();

  const base = {
    schemaVersion: '1' as const,
    generatedAt,
    blockers,
    warnings
  };

  if (!status.pom.hash) {
    return {
      ...base,
      state: 'no-project',
      title: '当前目录没有可识别的 pom.xml',
      action: 'none',
      command: '',
      why: '质量中心的标准升级流程只适用于 Maven 项目；没有 pom 就没有计划和落盘对象',
      pom: status.pom
    };
  }

  const mvn = status.tools.find((tool) => tool.id === 'mvn');
  if (mvn && !mvn.found) {
    blockers.push({
      code: 'mvn-missing',
      severity: 'blocking',
      message: '没有找到 mvn，扫描与构建都跑不了',
      suggestion: '先安装 Maven（插件会装到自己的工具目录，不改系统 PATH）'
    });
    return {
      ...base,
      state: 'blocked',
      title: '缺少构建工具 mvn',
      action: 'install',
      command: `${QC} tools install mvn`,
      why: '没有 Maven 就无法生成依赖清单、跑构建门禁；先补齐工具再谈升级',
      pom: status.pom
    };
  }

  const loaded = loadPolicy(root, fs.existsSync(path.join(root, 'pom.xml')) ? fs.readFileSync(path.join(root, 'pom.xml'), 'utf8') : undefined);
  const policy = {
    buildGate: loaded.policy.buildGate,
    frameworkTarget: loaded.frameworkTarget,
    allowNextFrameworkLine: loaded.policy.allowNextFrameworkLine
  };

  const scan = {
    total: scanCount(status),
    generatedAt: typeof status.scan.generatedAt === 'string' ? status.scan.generatedAt : undefined,
    deltaBaseline: typeof status.scan.deltaBaseline === 'string' ? status.scan.deltaBaseline : null,
    summary: (status.scan.summary as Record<string, number> | undefined) ?? undefined
  };

  if (!status.scan.hasResult) {
    return {
      ...base,
      state: 'not-scanned',
      title: '还没有扫描结果',
      action: 'scan',
      command: `${QC} scan . --json --detail summary --top 10`,
      why: '计划只能从扫描结果里的修复版本推导；先拿一份全量基线，后续复扫才有得比',
      pom: status.pom,
      scan,
      policy
    };
  }

  if (scan.total === 0) {
    return {
      ...base,
      state: 'clean',
      title: '最近一次扫描 0 条问题',
      action: 'rescan',
      command: `${QC} scan . --json --detail summary --top 10`,
      why: '没有发现问题，不需要依赖升级；改过 pom 或代码后再复扫确认',
      pom: status.pom,
      scan,
      policy
    };
  }

  const found = safePlan(root);
  if (!found) {
    return {
      ...base,
      state: 'no-plan',
      title: `有 ${scan.total} 条问题，但还没有升级计划`,
      action: 'plan',
      command: `${QC} upgrade plan . --reuse`,
      why: '先把「升什么、升到哪、会改成什么样」落成 plan.json 与 pom.diff；计划阶段绝不改 pom',
      pom: status.pom,
      scan,
      policy
    };
  }

  const { plan, check } = found;
  const steps = readPlanSteps(root, plan.planId);
  const appliedNames = new Set(steps.flatMap((step) => step.packages));
  const groups = groupStatuses(plan, appliedNames);
  const buildState = readBuildState(root);
  const buildMatchesPom = buildState?.pomHash === status.pom.hash;
  const lastStepAt = steps.length > 0 ? steps[steps.length - 1].at : plan.createdAt;

  if (check.total === 0) {
    blockers.push({
      code: 'empty-plan',
      severity: 'blocking',
      message: '当前计划 0 个候选（可能上一次只跑了局部扫描）',
      suggestion: '先做一次全量扫描，再重新生成计划'
    });
    return {
      ...base,
      state: 'empty-plan',
      title: `计划 ${plan.planId} 没有可升级的依赖`,
      action: 'plan',
      command: `${QC} scan . --json --detail summary --top 10`,
      why: '空计划会让 apply / check 走进死胡同；先补齐扫描结果再 plan',
      plan: {
        planId: plan.planId,
        state: check.state,
        appliedCount: 0,
        total: 0,
        groups
      },
      pom: status.pom,
      scan,
      policy
    };
  }

  if (check.state === 'drift') {
    blockers.push({
      code: 'pom-drift',
      severity: 'blocking',
      message: check.message,
      suggestion: 'pom 被手工改过：重新生成计划，不要继续 apply'
    });
    return {
      ...base,
      state: 'drift',
      title: `pom 已偏离计划 ${plan.planId}`,
      action: 'plan',
      command: `${QC} upgrade plan . --reuse`,
      why: '当前 pom 与计划的任何已知状态都不一致，继续落盘会覆盖手工改动',
      plan: {
        planId: plan.planId,
        state: check.state,
        appliedCount: check.appliedCount ?? 0,
        total: check.total ?? 0,
        groups
      },
      pom: status.pom,
      scan,
      policy
    };
  }

  const planInfo = {
    planId: plan.planId,
    state: check.state,
    appliedCount: check.appliedCount ?? 0,
    total: check.total ?? 0,
    directCount: plan.candidates.filter((item) => item.mode !== 'manage').length,
    nextGroup: check.nextGroup,
    nextLabel: check.nextGroup ? PLAN_GROUP_LABEL[check.nextGroup] : undefined,
    blocked: check.blocked ?? [],
    javaVersion: plan.project.javaVersion,
    frameworkVersion: plan.project.frameworkVersion,
    frameworkTarget: plan.project.frameworkTarget,
    groups,
    cveTotal: plan.candidates.reduce((sum, item) => sum + (item.cveCount || 0), 0),
    skippedCount: plan.skipped.length,
    skipped: plan.skipped.map((item) => ({
      packageName: item.packageName,
      reason: item.reason,
      decision: item.decision,
      installedVersion: item.installedVersion,
      fixedVersion: item.fixedVersion,
      cveCount: item.cveCount,
      introducedBy: item.introducedBy
    })),
    candidates: plan.candidates.map((item) => ({
      packageName: item.packageName,
      from: item.from,
      to: item.to,
      group: item.group,
      groupLabel: PLAN_GROUP_LABEL[item.group],
      cveCount: item.cveCount || 0,
      crossLine: Boolean(item.crossLine)
    }))
  };

  // 计划已全部落盘：构建 → 复扫 → 完成
  if (check.state === 'applied') {
    if (!buildState || !buildMatchesPom || Date.parse(buildState.at) < Date.parse(lastStepAt)) {
      return {
        ...base,
        state: 'applied',
        title: `计划 ${plan.planId} 已全部落盘，等待编译与测试`,
        action: 'build',
        command: `${QC} build .`,
        why: 'plan 成功不等于工程可用；先编译并运行测试，再复扫确认目标 CVE 真的消失',
        progress: `已落盘 ${check.appliedCount ?? 0}/${check.total ?? 0}`,
        plan: planInfo,
        pom: status.pom,
        scan,
        policy
      };
    }
    if (!buildState.ok) {
      const explanation = explainBuildFailure(
        root,
        undefined,
        buildState.logFile ? path.resolve(root, buildState.logFile) : undefined
      );
      blockers.push({
        code: 'build-failed',
        severity: 'blocking',
        message: explanation.cause,
        suggestion: explanation.suggestion
      });
      warnings.push({
        code: 'revert-scope',
        severity: 'warning',
        message: 'upgrade revert 会回到「计划生成前」，不是只退回某一组',
        suggestion: '先按 explain 的原因修；确实要整体重来再用 revert'
      });
      return {
        ...base,
        state: 'build-failed',
        title: `计划已全部落盘，但构建失败：${explanation.cause.slice(0, 80)}`,
        action: 'explain',
        command: `${QC} explain . --json`,
        why: '先把失败翻译成原因/影响/建议，再决定修代码还是整体回滚；不要在失败上继续叠改动',
        plan: planInfo,
        pom: status.pom,
        scan,
        policy
      };
    }
    const scanAt = scan.generatedAt ? Date.parse(scan.generatedAt) : 0;
    if (scanAt < Date.parse(buildState.at)) {
      return {
        ...base,
        state: 'verify',
        title: '构建已通过，等待复扫验收',
        action: 'rescan',
        command: `${QC} scan . --json --only trivy --delta`,
        why: '构建通过只证明代码可编译；还要确认计划里的目标 CVE 在扫描结果里消失',
        plan: planInfo,
        pom: status.pom,
        scan,
        policy
      };
    }
    return {
      ...base,
      state: 'done',
      title: `计划 ${plan.planId} 已完成并通过构建`,
      action: 'none',
      command: '',
      why: '计划全部落盘、门禁通过、复扫已覆盖；剩余项按报告人工评估即可',
      plan: planInfo,
      pom: status.pom,
      scan,
      policy
    };
  }

  // 未完成：如果「上一步之后」的构建失败，先翻译失败，不要继续下一组
  const builtAfterStep =
    steps.length > 0 &&
    buildState !== null &&
    buildMatchesPom &&
    Date.parse(buildState.at) >= Date.parse(lastStepAt);
  if (steps.length === 0 && buildState && buildMatchesPom && !buildState.ok) {
    warnings.push({
      code: 'baseline-build-failed',
      severity: 'warning',
      message: `当前基线构建就没有通过：${explainBuildFailure(root, undefined, buildState.logFile ? path.resolve(root, buildState.logFile) : undefined).cause}`,
      suggestion: '先确认基线是否本来就编译不过；带着失败基线升级会让归因变难，建议先修基线或明确接受'
    });
  }
  if (builtAfterStep && buildState && !buildState.ok) {
    const explanation = explainBuildFailure(
      root,
      undefined,
      buildState.logFile ? path.resolve(root, buildState.logFile) : undefined
    );
    blockers.push({
      code: 'build-failed',
      severity: 'blocking',
      message: explanation.cause,
      suggestion: explanation.suggestion
    });
    warnings.push({
      code: 'revert-scope',
      severity: 'warning',
      message: 'upgrade revert 会回到「计划生成前」，不是只退回某一组',
      suggestion: '先按 explain 的原因修；确实要整体重来再用 revert'
    });
    return {
      ...base,
      state: 'build-failed',
      title: `上一组落盘后构建失败：${explanation.cause.slice(0, 80)}`,
      action: 'explain',
      command: `${QC} explain . --json`,
      why: '一组一验证：这一组没过门禁就不许开下一组；先定位原因，别继续 apply',
      progress: `已落盘 ${check.appliedCount ?? 0}/${check.total ?? 0}`,
      plan: planInfo,
      pom: status.pom,
      scan,
      policy
    };
  }

  const nextGroup = check.nextGroup;
  if (!nextGroup && (check.blocked?.length ?? 0) > 0) {
    for (const item of check.blocked ?? []) {
      blockers.push({
        code: 'policy-blocked',
        severity: 'blocking',
        message: `${item.packageName}: 这是被其他依赖间接带入的包，需要先授权写版本锁定`,
        suggestion: '先升级引入它的直接依赖；如果无法升级，在面板「查看未处理项」里只勾选需要处理的包，授权插件写版本锁定后重新生成计划'
      });
    }
    return {
      ...base,
      state: 'blocked',
      title: `计划 ${plan.planId} 还有 ${check.blocked?.length ?? 0} 项需要你选择处理方式`,
      action: 'none',
      command: '',
      why: '这些包是被其他依赖间接带入的；需要先授权版本锁定，或者升级引入它们的直接依赖。不要手改 pom。',
      progress: `已落盘 ${check.appliedCount ?? 0}/${check.total ?? 0}`,
      plan: planInfo,
      pom: status.pom,
      scan,
      policy
    };
  }
  if (!nextGroup) {
    return {
      ...base,
      state: 'applied',
      title: '所有候选都已落盘，等待编译与测试',
      action: 'build',
      command: `${QC} build .`,
      why: '计划状态与步骤记录不一致时，以构建结果为准',
      plan: planInfo,
      pom: status.pom,
      scan,
      policy
    };
  }

  // 框架组落盘前预检：项目属性覆盖 BOM 版本是最常见的「一升就炸」
  const frameworkDone = appliedNames.size > 0 && steps.some((step) => step.group === 'framework');
  if (nextGroup === 'framework' && !frameworkDone) {
    const pomText = fs.readFileSync(path.join(root, 'pom.xml'), 'utf8');
    for (const item of detectManagedPropertyOverrides(pomText)) {
      warnings.push({
        code: 'property-override',
        severity: 'warning',
        message: `项目属性 ${item.property}=${item.value} 会覆盖框架 BOM 的 ${item.managed} 版本`,
        suggestion: '框架组落盘后若报 Non-resolvable import POM，优先处理这个属性：并入 family 组同组升级，或删除属性交给 BOM 管理'
      });
    }
  }

  const hash = status.pom.hash || hashText(fs.readFileSync(path.join(root, 'pom.xml'), 'utf8'));
  const progress = `已落盘 ${check.appliedCount ?? 0}/${check.total ?? 0}，下一组 ${PLAN_GROUP_LABEL[nextGroup]}`;

  if (nextGroup === 'cross-line') {
    blockers.push({
      code: 'cross-line-confirm',
      severity: 'blocking',
      message: `下一组是跨大版本：${plan.candidates.filter((item) => item.group === 'cross-line').map((item) => item.packageName).join(', ')}`,
      suggestion: '确认兼容性并跑单测后再加 --allow-cross-line；默认命令不会替你跨线'
    });
    return {
      ...base,
      state: 'needs-confirm',
      title: `只剩跨大版本组（${plan.candidates.filter((item) => item.group === 'cross-line').length} 项），需要人工确认`,
      action: 'confirm',
      command: `${QC} upgrade apply . --plan ${plan.planId} --hash ${hash} --group cross-line --write`,
      why: '跨大版本会改变 API 与运行行为，插件默认拒绝写入；确认后由人显式加 --allow-cross-line',
      progress,
      plan: planInfo,
      pom: status.pom,
      scan,
      policy
    };
  }

  return {
    ...base,
    state: check.state === 'partial' ? 'partial' : 'pending',
    title:
      check.state === 'partial'
        ? `计划 ${plan.planId} 进行中：${progress}`
        : `计划 ${plan.planId} 已生成，等待第一组落盘`,
    action: 'apply',
    command: `${QC} upgrade apply . --plan ${plan.planId} --hash ${hash} --group ${nextGroup} --write`,
    why: `一次只推进一组：先落盘 ${PLAN_GROUP_LABEL[nextGroup]}，再编译并测试；失败只处理这一组，不开下一组`,
    progress,
    plan: planInfo,
    pom: status.pom,
    scan,
    policy
  } satisfies NextActionPayload;
}

/** 给新会话 / 新 Agent 的一页交接：做到哪、下一步、别做什么 */
export function handoffMarkdown(root: string, next: NextActionPayload): string {
  const lines: string[] = [
    '# 质量中心 · 交接',
    '',
    `> 生成时间：${next.generatedAt}`,
    '> 这份文件由 `qc next` 生成；事实源仍是 issues.json / plan.json / steps.json / build-result.json，不要手改本文件。',
    '',
    '## 现在到哪了',
    '',
    next.title,
    next.progress ? `进度：${next.progress}` : '',
    ''
  ].filter((line) => line !== undefined);

  lines.push('## 下一步（唯一动作）', '');
  if (next.command) {
    lines.push('```bash', next.command, '```');
  } else {
    lines.push('无需操作。');
  }
  lines.push('', `为什么：${next.why}`, '');

  if (next.scan) {
    const counts = severitySummary(next.scan.summary);
    lines.push(
      '## 扫描',
      '',
      `- 结果：${next.scan.total} 条${counts ? `（${counts}）` : ''}`,
      `- 时间：${next.scan.generatedAt ?? '未知'}`,
      `- 增量基线：${next.scan.deltaBaseline ?? '无'}`,
      ''
    );
  }

  if (next.plan) {
    lines.push('## 计划', '', `- 计划：${next.plan.planId}（${next.plan.state}）`, `- Java：${next.plan.javaVersion ?? '未知'} · 框架：${next.plan.frameworkVersion ?? '未知'} → ${next.plan.frameworkTarget ?? '未声明'}`, '', '| 分组 | 已落盘 / 候选 | 状态 |', '| --- | --- | --- |');
    for (const group of next.plan.groups) {
      const stateLabel = group.state === 'done' ? '已完成' : group.state === 'doing' ? '进行中' : '未开始';
      lines.push(`| ${group.label} | ${group.applied} / ${group.total} | ${stateLabel} |`);
    }
    lines.push('');
  }

  const planId = next.plan?.planId;
  const steps = planId ? readPlanSteps(root, planId) : [];
  lines.push('## 已落盘步骤', '');
  if (steps.length === 0) {
    lines.push('还没有任何一组落盘。');
  } else {
    for (const step of steps) {
      lines.push(`- ${step.at} · ${step.group ?? '未分组'} · ${step.packages.join(', ')} · ${step.hashAfter}`);
    }
  }
  lines.push('');

  if (next.blockers.length > 0) {
    lines.push('## 阻塞', '');
    for (const item of next.blockers) {
      lines.push(`- ${item.message}`, `  - 建议：${item.suggestion}`);
    }
    lines.push('');
  }
  if (next.warnings.length > 0) {
    lines.push('## 警告', '');
    for (const item of next.warnings) {
      lines.push(`- ${item.message}`, `  - 建议：${item.suggestion}`);
    }
    lines.push('');
  }

  lines.push(
    '## 执行流程（用户一次性授权时按此执行）',
    '',
    '> 以下 `qc` 指 `node .quality-center/bin/qc.cjs`；状态机仍是 `qc next`，两者冲突时以 next 为准。',
    '',
    '1. 基线：`qc build` 建立 target（失败也记录，用 `qc explain` 判断）→ `qc scan --json` → `qc report --format summary`，记录修复前按来源计数。没有 target 时 trivy 只按源码解析、SpotBugs 为 0，基线与最终不可比。',
    '2. 确定性修复：`qc fix --write` → `qc build` 确认没有引入编译失败。',
    '3. 依赖升级：`qc upgrade plan --reuse`（必须先有当前 pom 的成功构建记录）→ 按分组 `upgrade apply --write` → `qc build` → `qc upgrade check`；失败先 explain，同组两次失败 revert 并列为阻塞。',
    '4. 依赖收敛：读 issues.json 的 category=duplicate 建议；先改代码、编译通过、最后删依赖；不自动删依赖，不为统一 JSON 重写业务序列化协议；BOM 项删除显式 version 后提示用 mvn dependency:tree 复核。',
    '5. 静态代码：`qc phase static_fix` → `qc report --format json` → 局部修复；每 20 条或 10 分钟 `qc build`。',
    '6. 复核收尾：全量 `qc scan` → `qc report` 对比（不要用旧 issues.json 冒充复验）→ 最终 `qc build` → `qc upgrade check` → `qc finalize`。',
    '',
    '- 只允许一个升级计划；需要新增 `<dependencyManagement>` 时先看策略白名单，不在白名单就列为阻塞。',
    '- 计数按来源（checkstyle / spotbugs / trivy / astgrep / qcsec / gitleaks）分别说明；`tests=skipped` 不能说“测试通过”，`drift=true` 不能说“可验收”。',
    ''
  );

  lines.push(
    '## 规则（硬性）',
    '',
    '1. 只通过 `qc upgrade apply` 写 pom；禁止手改、禁止批量替换版本号。',
    '2. 一次只推进一组；这组构建没过，不许开下一组。',
    '3. 每组之后：`qc build`（按策略 buildGate）→ `qc upgrade check`；组后应为 partial 且 appliedCount 增加，全部组完成才是 applied。',
    '4. 构建失败先 `qc explain`，再决定修代码还是整体回滚；不要在失败上继续叠改动。',
    '5. 同一组连续两次失败：`qc upgrade revert` 回到计划前（不是单组回退），再说明两次失败差异。',
    '6. 跨大版本默认不写，必须人工确认后才加 `--allow-cross-line`。',
    '7. `upgrade check` 出现 drift 说明 pom 被手工改过：停手，重新 plan。',
    '',
    '## 文件',
    '',
    '- `.quality-center/issues.json`：扫描事实源',
    '- `.quality-center/upgrade/<planId>/plan.json` / `pom.diff`：计划与补丁',
    '- `.quality-center/upgrade/<planId>/steps.json`：每一步的哈希轨迹',
    '- `.quality-center/build-result.json`：最近一次构建结果',
    '- `.quality-center/build.log`：完整构建日志',
    '- `.quality-center/handoff.md`：本文件'
  );

  return `${lines.join('\n')}\n`;
}

export function writeHandoff(root: string, next: NextActionPayload): string {
  const file = path.join(root, '.quality-center', 'handoff.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, handoffMarkdown(root, next), 'utf8');
  return file;
}
