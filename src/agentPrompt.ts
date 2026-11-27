/**
 * 交给编辑器 / CLI 里的 AI 的启动指令。
 *
 * 这里不放事实本身：issues.json、plan.json、handoff.md 已经是事实源，
 * 把上下文重复塞进 prompt 只会过期。指令只做三件事：
 * 1) 指明唯一入口（qc next）与要读的文件；
 * 2) 规定推进顺序与落盘方式（一组一验证，禁止手改 pom）；
 * 3) 给出止损条件（失败翻译、drift、跨大版本）。
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PLAN_GROUP_LABEL, PLAN_GROUP_ORDER, readUpgradePlan, UpgradePlanFile } from './upgradePlanFile';
import { inferFrameworkVersion, loadPolicy } from './upgradePolicy';
import type { Severity } from './model';

export type AgentScope = 'all' | 'upgrade' | 'consolidation' | 'code' | 'secrets' | 'static';

export interface AgentPromptOptions {
  /** 失败现场（如 Maven 尾部或编译错误），附在最后一段 */
  failure?: string;
  /** 指定计划；缺省取最新一份 */
  planId?: string;
  /**
   * assist：让 AI 协助推进，每步可等用户决定；
   * drive：用户已授权 AI 连续执行，启动前做 4 项确认；
   * autopilot：默认参数已授权，不逐项提问，一次修到可修完，最后复扫。
   */
  mode?: 'assist' | 'drive' | 'autopilot';
  /**
   * 修复范围。面板的“全面修复 / 仅升级依赖 / 修复某一块”对应不同 scope；
   * AI 必须先知道自己被授权改哪一类，否则会把“全面”理解成可以顺手改 pom。
   */
  scope?: AgentScope;
  /** 多选范围；与 scope 同时存在时以 scopes 为准。包含 all 等价于全选 */
  scopes?: AgentScope[];
  /** 严重度下限；缺省 info（全部）。低于该等级的只报告，不改代码 */
  minSeverity?: Severity;
}

const SCOPE_LABEL: Record<Exclude<AgentScope, 'all'>, string> = {
  upgrade: '依赖版本升级 / CVE',
  consolidation: '依赖收敛（JSON / 日志 / HTTP / BOM）',
  code: '确定性代码修复（Checkstyle / astgrep）',
  secrets: '硬编码密钥处置（gitleaks）',
  static: '静态缺陷（SpotBugs / qcsec）'
};

const ALL_SCOPES: Exclude<AgentScope, 'all'>[] = ['upgrade', 'consolidation', 'code', 'secrets', 'static'];

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: '严重',
  high: '高危',
  medium: '中危',
  low: '低危',
  info: '提示'
};

function severityBoundary(minSeverity?: Severity): string {
  if (!minSeverity || minSeverity === 'info') {
    return '';
  }
  return `严重度过滤：只处理 ${SEVERITY_LABEL[minSeverity]} 及以上；低于该等级的问题只报告，不改代码。`;
}

/**
 * prompt 里出现的“项目事实”只允许来自 plan.json / upgrade-policy.json / pom。
 * Java 级别、框架目标、buildGate、分组顺序都不写死在文案里：
 * 同一段 prompt 里写出两个版本边界，AI 只会按先读到的那个执行。
 */
interface PromptFacts {
  plan?: UpgradePlanFile;
  javaSource?: string;
  javaTarget?: string;
  frameworkFrom?: string;
  frameworkTarget?: string;
  buildGate: string;
  runTests: boolean;
  groups: { name: string; label: string; count: number }[];
  /** 计划候选里涉及的项目属性名（去重） */
  properties: string[];
}

const HIGHER_JAVA_FALLBACK = '11/17/21';

function higherJavaLines(source?: string): string {
  const current = Number(source);
  if (!Number.isFinite(current)) {
    return HIGHER_JAVA_FALLBACK;
  }
  const lines = [11, 17, 21].filter((version) => version > current);
  return lines.length ? lines.join('/') : '更高版本';
}

/** 下一步可能需要的 Java 大版本：已授权迁移时按目标级别算，避免又说“升到 11” */
function nextJavaLine(facts: PromptFacts): string {
  return higherJavaLines(facts.javaTarget ?? facts.javaSource);
}

function readPromptFacts(root: string, options: AgentPromptOptions): PromptFacts {
  let plan: UpgradePlanFile | undefined;
  try {
    plan = readUpgradePlan(root, options.planId);
  } catch {
    plan = undefined;
  }
  let loaded: ReturnType<typeof loadPolicy> | undefined;
  try {
    loaded = loadPolicy(root);
  } catch {
    loaded = undefined;
  }

  let frameworkFrom = plan?.project.frameworkVersion;
  if (!frameworkFrom) {
    try {
      frameworkFrom = inferFrameworkVersion(fs.readFileSync(path.join(root, 'pom.xml'), 'utf8'));
    } catch {
      frameworkFrom = undefined;
    }
  }

  const javaTarget = plan?.project.javaVersion ?? loaded?.targetJavaVersion ?? loaded?.javaVersion;
  const javaSource =
    plan?.project.sourceJavaVersion ?? plan?.project.javaVersion ?? loaded?.javaVersion ?? javaTarget;
  const frameworkTarget = plan?.project.frameworkTarget ?? loaded?.frameworkTarget;
  const buildGate = loaded?.policy.buildGate ?? 'package';
  const runTests = loaded?.policy.runTests ?? true;
  const groups = plan
    ? plan.groups.map((group) => ({ name: group.name, label: group.label, count: group.candidates.length }))
    : PLAN_GROUP_ORDER.map((name) => ({ name, label: PLAN_GROUP_LABEL[name], count: 0 }));
  const properties = Array.from(
    new Set(
      (plan?.candidates ?? [])
        .map((candidate) => candidate.property)
        .filter((value): value is string => Boolean(value))
    )
  );

  return {
    plan,
    javaSource,
    javaTarget,
    frameworkFrom,
    frameworkTarget,
    buildGate,
    runTests,
    groups,
    properties
  };
}

function javaSourceLabel(facts: PromptFacts): string {
  if (!facts.javaSource) {
    return 'Java 版本以 pom 为准';
  }
  if (facts.javaTarget && facts.javaTarget !== facts.javaSource) {
    return `Java ${facts.javaSource} → ${facts.javaTarget}（upgrade-policy.json 的 targetJavaVersion 已授权迁移）`;
  }
  return `Java ${facts.javaSource}`;
}

function frameworkLabel(facts: PromptFacts): string {
  if (!facts.frameworkFrom && !facts.frameworkTarget) {
    return '框架版本以 pom 为准';
  }
  if (!facts.frameworkTarget || facts.frameworkTarget === facts.frameworkFrom) {
    return `框架 ${facts.frameworkFrom ?? '未知'}`;
  }
  return `框架 ${facts.frameworkFrom ?? '未知'} → ${facts.frameworkTarget}`;
}

/** 全篇唯一的边界描述：源码 Java 级别 / 框架当前 → 目标 */
function boundaryLine(facts: PromptFacts): string {
  return `${javaSourceLabel(facts)} / ${frameworkLabel(facts)}`;
}

/** 分组顺序取自计划本身，没计划时才退回通用顺序 */
function groupSequence(facts: PromptFacts, pick?: { excludeCrossLine?: boolean }): string {
  const groups = pick?.excludeCrossLine
    ? facts.groups.filter((group) => group.name !== 'cross-line')
    : facts.groups;
  return groups
    .map((group) =>
      facts.plan ? `${group.name}(${group.label} ${group.count} 项)` : `${group.name}(${group.label})`
    )
    .join(' → ');
}

function gateLabel(facts: PromptFacts): string {
  return facts.runTests
    ? `buildGate=${facts.buildGate}（runTests=true，会真的跑测试）`
    : `buildGate=${facts.buildGate}（runTests=false，构建不跑测试，汇报必须注明测试未验证）`;
}

function propertyPhrase(facts: PromptFacts): string {
  return facts.properties.length
    ? `计划涉及的属性（${facts.properties.slice(0, 4).join('、')}）`
    : '计划里的项目属性（以 plan.json 的 property 字段为准）';
}

/**
 * 启动前确认项：prompt 与 brief(JSON) 共用这一份文案。
 * 分成函数而不是各写一遍，面板、CLI、MCP 才不会出现两套边界。
 */
function confirmQuestions(facts: PromptFacts, mode: 'autopilot' | 'drive'): string[] {
  if (mode === 'drive') {
    return [
      `1. JDK：计划按 ${boundaryLine(facts)}。生产/目标运行环境是否也是这个 JDK？若不是，按第 4 条冲突处理，不要直接停：先区分“只换运行 JDK”与“源码也升 JDK”。`,
      `2. 门禁：是否接受策略里的 ${gateLabel(facts)}？是否允许跳过测试？默认不允许。`,
      '3. 跨大版本：计划里的 cross-line 项是否本次处理？默认先不动，推进到该组再人工确认。',
      `4. 属性与代码修复：${propertyPhrase(facts)}是否允许随框架 BOM 对齐？是否允许按 explain 做最小编译修复（例如删除无用 import）？`
    ];
  }
  return [
    '1. 目标范围：本次是否处理“静态代码 + 确定性修复 + 依赖/CVE 升级 + 依赖收敛”的全部可修复项（默认是），还是只修高危/CVE？',
    `2. 版本边界：当前项目事实是 ${boundaryLine(facts)}；遇到必须升 JDK ${nextJavaLine(facts)} 或 Spring Boot 3.x 的项，是本次处理、跳过，还是先停下问用户（默认停下询问）？`,
    `3. 门禁与权限：${gateLabel(facts)}、不改测试；允许项目属性覆盖和“删无用 import / 调整修饰符顺序 / 简化布尔比较”等最小代码修复；安全设计、密钥轮换、架构重构只报告不擅自改。是否接受？`
  ];
}

export interface AgentFactsPayload {
  /** 一句话边界：Java 级别 / 框架当前 → 目标 */
  boundary: string;
  javaSource?: string;
  javaTarget?: string;
  frameworkFrom?: string;
  frameworkTarget?: string;
  buildGate: string;
  runTests: boolean;
  groups: { name: string; label: string; count: number }[];
  properties: string[];
  planId?: string;
  /** 启动前确认项，与 prompt 完全同源；assist 模式为空 */
  confirmQuestions: string[];
}

/** 给面板 / CLI --json / MCP 的结构化事实；文案仍以 prompt 为准 */
export function buildAgentFacts(root: string, options: AgentPromptOptions = {}): AgentFactsPayload {
  const facts = readPromptFacts(root, options);
  const mode = options.mode ?? 'assist';
  return {
    boundary: boundaryLine(facts),
    javaSource: facts.javaSource,
    javaTarget: facts.javaTarget,
    frameworkFrom: facts.frameworkFrom,
    frameworkTarget: facts.frameworkTarget,
    buildGate: facts.buildGate,
    runTests: facts.runTests,
    groups: facts.groups,
    properties: facts.properties,
    planId: facts.plan?.planId,
    confirmQuestions: mode === 'assist' ? [] : confirmQuestions(facts, mode)
  };
}

function normalizeScopes(options: AgentPromptOptions): AgentScope[] {
  const raw = options.scopes && options.scopes.length ? options.scopes : [options.scope ?? 'all'];
  if (raw.includes('all') || ALL_SCOPES.every((scope) => raw.includes(scope))) {
    return ['all'];
  }
  const picked = ALL_SCOPES.filter((scope) => raw.includes(scope));
  return picked.length ? picked : ['all'];
}

/** 多选范围：只列被选中的边界，避免 AI 把未选类别也一起改 */
function buildCombinedAgentPrompt(root: string, scopes: Exclude<AgentScope, 'all'>[], options: AgentPromptOptions): string {
  const labels = scopes.map((scope) => SCOPE_LABEL[scope]).join('、');
  const ordered = ALL_SCOPES.filter((scope) => scopes.includes(scope));
  const boundaries: Record<Exclude<AgentScope, 'all'>, string> = {
    upgrade:
      '依赖升级：只通过 quality_upgrade_plan/apply 写 pom，按组 apply → build，失败先 explain；cross-line 默认不动；不调用 quality_fix。',
    consolidation:
      '依赖收敛：先列重复库、引用文件与迁移顺序；先改代码、编译通过、最后删依赖；不自动删依赖，不改版本（版本属于 upgrade）。',
    code:
      '代码质量：只做 quality_fix 能处理的无用导入/冗余导入/ModifierOrder/SimplifiedBoolean；不改 pom、测试、配置。',
    secrets:
      '密钥：绝不打印原值；先让用户轮换，再迁移环境变量/配置中心；不能确认轮换时只报告。',
    static:
      '静态缺陷：只处理 SpotBugs/qcsec；局部改动，每 20 条或每 10 分钟 build；安全设计/架构问题只报告。'
  };
  const sevLine = severityBoundary(options.minSeverity);
  const lines = [
    `你本次处理以下范围：${labels}。未列出的类别只报告、不修改；不要用“全面修复”默认扩大授权。`,
    ...(sevLine ? [sevLine] : []),
    `处理顺序：${ordered.map((scope) => SCOPE_LABEL[scope]).join(' → ')}。`,
    '每个范围完成后执行 quality_build + quality_scan；失败先 quality_explain，同一类连续两次失败就停手。',
    '',
    '范围边界：'
  ];
  for (const scope of ordered) {
    lines.push(`- ${boundaries[scope]}`);
  }
  lines.push(
    '',
    '事实源：.quality-center/issues.json（issues + suggestions）与 report.md；不要凭记忆推断数量。',
    '编辑器内优先用 quality_* MCP，没有 MCP 时用 .quality-center/bin/qc.cjs。',
    '换会话或状态不确定时，调用 quality_agent_brief 必须带同一组 scopes，不要退回默认 all。',
    '',
    '通用硬性规则：',
    '1. 不读、不打印、不提交密钥原值。',
    '2. 不跳过测试、不降低 buildGate、不改测试来换通过。',
    '3. 最终汇报：范围、处理前/后数量、改动文件、构建与复扫结果、剩余人工项。'
  );
  if (options.failure && options.failure.trim()) {
    lines.push('', '失败现场（从这里开始判断）：', '```', options.failure.trim().slice(-3000), '```');
  }
  return lines.join('\n');
}

/**
 * 单一范围的执行指令。范围和“全面修复”共用同一套事实源，但授权边界不同：
 * AI 只能改当前 scope 允许的内容，其他类别只报告。
 */
function buildScopedAgentPrompt(root: string, scope: Exclude<AgentScope, 'all'>, options: AgentPromptOptions): string {
  const label = SCOPE_LABEL[scope];
  const sevLine = severityBoundary(options.minSeverity);
  const lines: string[] = [
    `你本次只处理「${label}」，其他类别只报告、不修改；不要因为“顺手”去改 pom、依赖、测试、配置或无关代码。`,
    ...(sevLine ? [sevLine] : []),
    '事实源仍然是 .quality-center/issues.json / suggestions / report.md；不要凭聊天记忆推断问题数量。',
    '编辑器内优先用 quality_* MCP；没有 MCP 时用 .quality-center/bin/qc.cjs。',
    ''
  ];

  if (scope === 'upgrade') {
    const facts = readPromptFacts(root, options);
    const planContext = facts.plan
      ? `当前计划 ${facts.plan.planId}：${boundaryLine(facts)}。`
      : '当前还没有升级计划。';
    lines.push(
      planContext,
      '执行顺序：',
      '1. 没有计划：quality_upgrade_plan（或 `qc upgrade plan . --reuse`）生成；只生成计划，不改 pom。',
      `2. 按 ${groupSequence(facts, { excludeCrossLine: true })} 逐组 quality_upgrade_apply write=true；每组后 quality_build；失败先 quality_explain，同组两次失败 quality_upgrade_revert 并列为阻塞。`,
      '3. cross-line 默认不动；需要跨大版本时停下等用户确认，不得自行 --allow-cross-line。',
      '4. 每轮用 quality_next 重新取状态，不要沿用上一轮判断；最后 quality_scan + quality_finalize。',
      '边界：不得调用 quality_fix，不得改静态代码、密钥、依赖收敛项；不得手改 pom 或跳测试。'
    );
  } else if (scope === 'consolidation') {
    lines.push(
      '第一步：读 issues.json 的 suggestions，只取 category=duplicate；按 impact 从高到低列出：',
      '- 能力类别（JSON / 日志 / HTTP / BOM）',
      '- 重复库、引用文件数、当前用途',
      '- 保留哪一个、迁移顺序、不能自动删除的原因',
      '第二步：先给用户看迁移清单（这一步不能省略）；确认后按“先改代码、编译通过、再删依赖”的顺序小步执行。',
      '第三步：每完成一个能力类别，quality_build + quality_scan；有新增编译错误立即停手并汇报，不要继续删下一个库。',
      '边界：不改依赖版本（那是 upgrade）；不自动删依赖；不为了统一 JSON 而重写业务序列化协议；BOM 项只改显式 version 并提示用 mvn dependency:tree 复核。'
    );
  } else if (scope === 'code') {
    lines.push(
      '只处理可确定性修复项：无用导入、冗余导入、ModifierOrder、SimplifyBooleanExpression。',
      '1. quality_fix write=false 先预览，确认 diff 只包含上述规则。',
      '2. quality_fix write=true 落盘；随后 quality_build，失败先 quality_explain。',
      '3. quality_scan 复核，确认对应规则数量下降且没有新增编译错误。',
      '边界：不改 pom、不改依赖、不改测试、不改配置；不做语义重构。'
    );
  } else if (scope === 'secrets') {
    lines.push(
      '只处理 gitleaks 硬编码密钥。',
      '1. 先按文件/规则分组，绝不打印、复制或提交密钥原值。',
      '2. 先建议轮换密钥（已进入版本库即视为泄露），再迁移到环境变量或配置中心，代码只保留占位符。',
      '3. 用户确认轮换完成后，再做代码替换并 quality_scan 复核；不能确认轮换时只报告，不改代码。',
      '边界：不改依赖、不改业务逻辑、不把密钥写进示例配置或日志。'
    );
  } else if (scope === 'static') {
    lines.push(
      '只处理 SpotBugs / qcsec 静态缺陷。',
      '1. quality_report format=json 取剩余项，按严重度排序，先 critical/high。',
      '2. 每条修复必须说明规则、调用上下文和影响范围；只做局部、可编译验证的改动。',
      '3. 每修 20 条或每 10 分钟 quality_build；最后 quality_scan 复核。',
      '边界：安全设计、权限模型、架构重构只报告；不改依赖、不改测试。'
    );
  }

  lines.push(
    '',
    '通用硬性规则：',
    '1. 不读、不打印、不提交密钥原值。',
    '2. 不跳过测试、不降低 buildGate、不改测试来换通过。',
    '3. 失败先 quality_explain；同一类连续两次失败就停手，不碰运气。',
    '4. 换会话或状态不确定时，调用 quality_agent_brief 时必须带同一个 scope，不要退回默认 all。',
    '5. 最终汇报：范围、处理前/后数量、改动文件、构建与复扫结果、剩余人工项。'
  );

  if (options.failure && options.failure.trim()) {
    lines.push('', '失败现场（从这里开始判断）：', '```', options.failure.trim().slice(-3000), '```');
  }
  return lines.join('\n');
}

export function buildAgentPrompt(root: string, options: AgentPromptOptions = {}): string {
  const scopes = normalizeScopes(options);
  if (scopes.length > 1) {
    return buildCombinedAgentPrompt(root, scopes as Exclude<AgentScope, 'all'>[], options);
  }
  const scope = scopes[0] ?? 'all';
  if (scope !== 'all') {
    return buildScopedAgentPrompt(root, scope, options);
  }
  const drive = options.mode === 'drive';
  const autopilot = options.mode === 'autopilot';
  const lines: string[] = [
    autopilot
      ? '你已被授权一次性完成本项目的质量整改：静态问题、可确定修复项、依赖版本升级与依赖收敛。先做一次“目标确认”，用户确认后连续执行到收尾，不要执行一步就停下等用户再次发起；只有硬阻塞才再次询问。'
      : drive
        ? '你已被授权驱动整个依赖升级与 CVE 整改流程；但启动前必须先完成一次“开始前确认”，之后不需要每一步等用户确认，且始终服从插件的状态机和止损规则。'
        : '按 quality-center 的标准化流程完成本项目依赖升级与 CVE 整改。',
    ''
  ];
  const baseSevLine = severityBoundary(options.minSeverity);
  if (baseSevLine) {
    lines.push(baseSevLine, '');
  }

  const facts = readPromptFacts(root, options);

  if (autopilot) {
    lines.push(
      '启动前只做一次「目标确认」，一次问清下面 3 项，不要拆成多轮、不要逐项追问：',
      ...confirmQuestions(facts, 'autopilot'),
      '用户确认后：按下面默认参数连续执行到收尾，不再每一步征求同意，也不要在完成一个组后停下等用户再发起。',
      '只有出现硬阻塞时才再次询问；用户回答后继续剩余项，不要从头重来。',
      '',
      '确认后的默认参数：',
      `1. JDK：${
        facts.javaTarget && facts.javaSource && facts.javaTarget !== facts.javaSource
          ? `源码按策略迁移到 Java ${facts.javaTarget}（source/target 会一起改）`
          : '源码保持当前 Java 版本'
      }（${boundaryLine(facts)}）；只允许运行时是更高 JDK，不允许擅自改 source/target。`,
      `2. 门禁：沿用 upgrade-policy.json 的 ${gateLabel(facts)}；不通过跳过测试、改测试或降低门禁来换通过。`,
      `3. 跨大版本：默认不写；只有某个 CVE 在当前 ${facts.javaSource ? `Java ${facts.javaSource}` : 'Java 级别'} 下没有兼容修复版本时，才把它列为“需要升级 JDK/框架”的阻塞项，不得自行 apply。`,
      '4. 属性覆盖与最小代码修复：允许；允许删除无用 import、调整修饰符顺序、简化布尔比较等可逆小改；不允许大范围重构。',
      '5. 静态问题：按下面阶段批量修，不要一条一条问用户。',
      ''
    );
  }

  if (drive) {
    lines.push(
      '启动前确认（第 0 步，必须先问用户并等待回答；未回答不得执行 apply）：',
      '先发一条简短的「开始前确认」，一次问清下面 4 项，不要逐项反复追问：',
      ...confirmQuestions(facts, 'drive'),
      '若用户没有回答：停在 plan，不落盘，等用户补充。',
      '若用户回答与当前计划冲突：不要执行旧计划，也不要只回一句“冲突”；按下面的方式调整并给出新计划：',
      `   - JDK：只换运行 JDK 时，确认 ${facts.frameworkTarget ?? '当前框架目标'} 可在该 JDK 运行，计划不变；源码也升时必须改策略并重新 plan。`,
      '   - 源码升 JDK：在 `upgrade-policy.json` 写 `targetJavaVersion`，并在 `frameworkTargets` 里给同一 key 设框架目标；跨 Boot 3.x 才设 `allowNextFrameworkLine=true`。改完运行 `qc upgrade plan .`（不要 `--reuse`），对比新旧 diff。',
      '   - 门禁：按用户回答改 `buildGate`（compile/package/test），不要命令行绕过。',
      '   - 跨大版本：不做就停在 needs-confirm，不得自行加 `--allow-cross-line`。',
      ''
    );
  }

  lines.push(
    '第一步：执行 `node .quality-center/bin/qc.cjs next .`（MCP: quality_next），读它返回的',
    'state / action / command / why / blockers，以及 `.quality-center/handoff.md`。',
    '它是唯一状态机：不要自己推断流程，也不要在已有 issues.json 时重新全量扫描。',
    '编辑器内 AI 优先用已配置的 quality_* MCP 工具；没有 MCP 时再用上面的 CLI。'
  );

  lines.push(
    '',
    '事实源（按需读，不要重复搬运）：handoff.md（状态、执行流程与规则）｜issues.json / report.md（问题）｜upgrade-policy.json（边界）｜skills/quality-center-java-upgrade/SKILL.md（判断）',
    `- 本次边界（来源：plan.json 与 upgrade-policy.json）：${boundaryLine(facts)}；${gateLabel(facts)}`,
    '- 若上面这行与 `qc next` / handoff.md 冲突，一律以 next 为准：状态机是唯一事实。'
  );

  let planLine = '';
  if (facts.plan) {
    const plan = facts.plan;
    planLine = [
      '',
      `当前计划：${plan.planId}`,
      `- 边界：${boundaryLine(facts)}`,
      `- 分组顺序：${groupSequence(facts) || '无候选'}`,
      `- 补丁预览：${path.join('.quality-center', 'upgrade', plan.planId, 'pom.diff')}`
    ].join('\n');
    const pomFile = path.join(root, 'pom.xml');
    if (fs.existsSync(pomFile)) {
      const hash = `sha256:${createHash('sha256').update(fs.readFileSync(pomFile, 'utf8')).digest('hex')}`;
      planLine += `\n- 当前 pomHash：${hash}（apply 时 --hash 用它，落盘后换新的）`;
    }
    lines.push(planLine);
  } else {
    lines.push('', '还没有升级计划：先执行 `qc upgrade plan . --reuse`（或 MCP quality_upgrade_plan）。');
  }

  lines.push(
    '',
    '硬性规则：',
    '1. 只通过 `node .quality-center/bin/qc.cjs upgrade apply`（或 MCP）写 pom；禁止手改、禁止 sed/批量替换版本号。',
    `2. 一次只推进一组：${groupSequence(facts)}；这组构建没过，不开下一组。`,
    '3. 每组之后 build → upgrade check；失败先 explain，同组两次失败 revert（回到计划前）；细节见 handoff.md「规则」。',
    '4. 跨大版本默认不写；要用户确认后才加 `--allow-cross-line`。',
    '5. `upgrade check` 出现 drift：立刻停手，重新 plan。'
  );

  if (drive) {
    lines.push(
      '',
      '执行授权与边界：',
      '8. 这是执行任务，不是给建议：每轮直接执行 next 返回的 action，直到 done 或触发退出条件；不要停在“下一步可以…”。',
      '9. 不得为了通过构建删依赖、跳过测试、改测试、降低 buildGate，也不得把失败版本换一个再碰运气。',
      '10. 不读、不打印、不提交任何密钥原值；密钥问题只报位置与处置建议。',
      '11. 如果你既不能执行终端、也没有 quality_* MCP 工具：不要假装执行；只输出第一条命令并说明需要用户执行。',
      '',
      '执行循环（最多 10 轮，每轮都重新 qc next，不要沿用上一轮判断）：',
      '1. `node .quality-center/bin/qc.cjs next . --json`。',
      '2. 按 action 分支：',
      '   - plan → `node .quality-center/bin/qc.cjs upgrade plan . --reuse`',
      '   - apply → 原样执行 next 返回的 command；不要自己拼 --hash/--group，执行前确认 pomHash 未变',
      '   - build → `node .quality-center/bin/qc.cjs build .`',
      '   - explain → `node .quality-center/bin/qc.cjs explain .`，按「原因/影响/建议」处理，不连续碰运气',
      '   - rescan → `node .quality-center/bin/qc.cjs scan . --json --detail summary`',
      '   - revert → 执行 `node .quality-center/bin/qc.cjs upgrade revert . --plan <id>` 后停止并汇报',
      '   - none / verify / done → 停止',
      '   - confirm / needs-confirm / blocked / install / integrate → 停止并汇报，不要绕过',
      '3. 每次 apply 后必须 build；build 失败必须 explain；同一组连续两次失败必须 revert 并停。',
      '4. 每轮只向用户报一行：`第N组 组名：成功/失败，applied x/y，下一步 action`；不要贴整段 Maven 日志。',
      '',
      '退出条件（任一命中立即停止）：done；needs-confirm；blocked；同一组连续两次失败；pom drift；需要跨大版本；超过 10 轮。',
      '停止时汇报：计划 id、已完成组/总数、失败原因/影响/建议、执行过的命令、剩余人工项。',
      'done 时：复扫、最终 build、`qc upgrade check` 应为 applied，并给出 CVE 前后数量与仍需人工判断的条目。'
    );
  }

  if (autopilot) {
    lines.push(
      '',
      '一次性执行流程（阶段流程；详细命令与判定见 handoff.md「执行流程」；以 `qc next` 的 action 为准）：quality_build 建基线 → quality_scan → quality_fix → quality_upgrade_plan/apply（逐组 build/check）→ 阶段 3.5 依赖收敛 → quality_phase(static_fix) → quality_scan 复核 → quality_finalize 收尾。',
      '关键约束：只允许一个升级计划；需要新增 `<dependencyManagement>` 时先看策略白名单，不在白名单就列为阻塞；计数按来源分别说明；`tests=skipped` 不能说“测试通过”，`drift=true` 不能说“可验收”。',
      '',
      '硬阻塞（命中就停这一类，不要停整个流程）：',
      `- 需要把源码 ${facts.javaSource ? `Java ${facts.javaSource}` : 'Java 级别'} 升到 ${nextJavaLine(facts)}，或需要 Spring Boot 3.x / javax→jakarta；`,
      `- 某 CVE 在当前 ${facts.javaSource ? `Java ${facts.javaSource}` : 'Java'} 下无兼容修复版本，或 cross-line 依赖只能靠大版本解决；`,
      '- 构建失败无法用 quality_explain 归因，或测试失败是代码语义变化导致；',
      '- 密钥/凭证泄露需要轮换、权限模型需要产品决策、需要大范围重构。',
      '命中硬阻塞时：先问用户“这一项本次处理 / 跳过 / 先记录”，不要强行改 source/target、不要跳测试、不要 --allow-cross-line；用户回答后继续其他可修项，最后统一汇总。用户不回答则跳过该项并在最终汇总里列出。',
      '',
      '用户沟通规则：',
      '- 除目标确认与硬阻塞外不提问；每个阶段只报一行：阶段、已修数、构建结果。',
      '- 不要每完成一组就停下来等用户再次发起；确认后一次执行到底。',
      '- 最终汇总：修复前 → 修复后（按来源）、剩余与阻塞、改动文件、复验命令；不要只说“已完成”。'
    );
  }

  if (options.failure && options.failure.trim()) {
    lines.push('', '失败现场（从这里开始判断，别从头重来）：', '```', options.failure.trim().slice(-3000), '```');
  }

  return lines.join('\n');
}
