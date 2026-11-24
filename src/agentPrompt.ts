/**
 * 交给编辑器 / CLI 里的 AI 的启动指令。
 *
 * 这里不放事实本身：issues.json、report.md、plan.json 已经是事实源，
 * 把上下文重复塞进 prompt 只会过期。指令只做三件事：
 * 1) 指明去读哪些文件（或调哪些 MCP 工具）；
 * 2) 规定推进顺序与落盘方式（一组一验证，禁止手改 pom）；
 * 3) 给出止损条件（连续失败、drift、跨大版本）。
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
    '事实源（先读，不要重新扫描）：',
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
    lines.push('', '还没有升级计划：先执行 `qc upgrade plan`（或 MCP quality_upgrade_plan），生成 plan.json 与 pom.diff。');
  }

  lines.push(
    '',
    '硬性规则：',
    '1. 只通过 `qc upgrade apply`（或 MCP quality_upgrade_apply）写 pom；禁止手改、禁止 sed/批量替换版本号。',
    '2. 一次只推进一组：framework → family → independent → cross-line；这组构建没过，不开下一组。',
    '3. 每组之后：`qc build`（MCP quality_build，errors 里有文件与行号）→ `qc upgrade check` 必须到 applied。',
    '4. 跨大版本默认不写；要我确认后才加 `--allow-cross-line`。',
    '5. 同一组连续两次失败就停手：先 `qc upgrade revert` 回到该组之前，再说明两次失败的差异。',
    '6. `upgrade check` 出现 drift 说明 pom 被手工改过：立刻停手，重新 `upgrade plan`。'
  );

  if (options.failure && options.failure.trim()) {
    lines.push('', '失败现场（从这里开始判断，别从头重来）：', '```', options.failure.trim().slice(-3000), '```');
  }

  return lines.join('\n');
}
