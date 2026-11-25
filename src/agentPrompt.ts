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
import { PLAN_GROUP_LABEL, readUpgradePlan } from './upgradePlanFile';

export interface AgentPromptOptions {
  /** 失败现场（如 Maven 尾部或编译错误），附在最后一段 */
  failure?: string;
  /** 指定计划；缺省取最新一份 */
  planId?: string;
}

export function buildAgentPrompt(root: string, options: AgentPromptOptions = {}): string {
  const lines: string[] = [
    '按 quality-center 的标准化流程完成本项目依赖升级与 CVE 整改。',
    '',
    '第一步：执行 `node .quality-center/bin/qc.cjs next .`（MCP: quality_next），读它返回的',
    'state / action / command / why / blockers，以及 `.quality-center/handoff.md`。',
    '它是唯一状态机：不要自己推断流程，也不要在已有 issues.json 时重新全量扫描。',
    '',
    '事实源（按需读，不要重复搬运）：',
    '- .quality-center/handoff.md（一页交接：做到哪、下一步、阻塞与规则）',
    '- .quality-center/issues.json / report.md（或 MCP: quality_report format=json）',
    '- .quality-center/upgrade-policy.json（框架上限、禁用依赖、构建门禁）',
    '- .quality-center/skills/quality-center-java-upgrade/SKILL.md（判断类知识）'
  ];

  let planLine = '';
  try {
    const plan = readUpgradePlan(root, options.planId);
    const groupSummary = plan.groups
      .map((group) => `${group.name}(${PLAN_GROUP_LABEL[group.name]} ${group.candidates.length} 项)`)
      .join(' → ');
    planLine = [
      '',
      `当前计划：${plan.planId}`,
      `- 框架：${plan.project.frameworkVersion ?? '未知'} → ${plan.project.frameworkTarget ?? '未声明'}（Java ${plan.project.javaVersion ?? '未知'}）`,
      `- 分组顺序：${groupSummary || '无候选'}`,
      `- 补丁预览：${path.join('.quality-center', 'upgrade', plan.planId, 'pom.diff')}`
    ].join('\n');
    const pomFile = path.join(root, 'pom.xml');
    if (fs.existsSync(pomFile)) {
      const hash = `sha256:${createHash('sha256').update(fs.readFileSync(pomFile, 'utf8')).digest('hex')}`;
      planLine += `\n- 当前 pomHash：${hash}（apply 时 --hash 用它，落盘后换新的）`;
    }
    lines.push(planLine);
  } catch {
    lines.push('', '还没有升级计划：先执行 `qc upgrade plan . --reuse`（或 MCP quality_upgrade_plan）。');
  }

  lines.push(
    '',
    '硬性规则：',
    '1. 只通过 `node .quality-center/bin/qc.cjs upgrade apply`（或 MCP quality_upgrade_apply）写 pom；禁止手改、禁止 sed/批量替换版本号。',
    '2. 一次只推进一组：framework → family → independent → cross-line；这组构建没过，不开下一组。',
    '3. 每组之后：`node .quality-center/bin/qc.cjs build`（按策略 buildGate，失败先跑 `qc explain`）→ `qc upgrade check`；组后应为 partial 且 appliedCount 增加，全部组完成才是 applied。',
    '4. 构建失败先 `node .quality-center/bin/qc.cjs explain .`（MCP quality_explain）：按原因/影响/建议处理；不要在失败上继续 apply 或换版本碰运气。',
    '5. 跨大版本默认不写；要用户确认后才加 `--allow-cross-line`。',
    '6. 同一组连续两次失败就停手：`qc upgrade revert` 回到计划前（注意不是单组回退），再说明两次失败的差异。',
    '7. `upgrade check` 出现 drift 说明 pom 被手工改过：立刻停手，重新 `qc upgrade plan`。'
  );

  if (options.failure && options.failure.trim()) {
    lines.push('', '失败现场（从这里开始判断，别从头重来）：', '```', options.failure.trim().slice(-3000), '```');
  }

  return lines.join('\n');
}
