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
  /**
   * assist：让 AI 协助推进，每步可等用户决定；
   * drive：用户已授权 AI 连续执行，按 qc next 循环到 done 或触发退出条件。
   */
  mode?: 'assist' | 'drive';
}

export function buildAgentPrompt(root: string, options: AgentPromptOptions = {}): string {
  const drive = options.mode === 'drive';
  const lines: string[] = [
    drive
      ? '你已被授权驱动整个依赖升级与 CVE 整改流程；但启动前必须先完成一次“开始前确认”，之后不需要每一步等用户确认，且始终服从插件的状态机和止损规则。'
      : '按 quality-center 的标准化流程完成本项目依赖升级与 CVE 整改。',
    ''
  ];

  let planContext = '';
  try {
    const plan = readUpgradePlan(root, options.planId);
    planContext = ` Java ${plan.project.javaVersion ?? '未知'} / 框架 ${plan.project.frameworkVersion ?? '未知'} → ${plan.project.frameworkTarget ?? '未声明'}`;
  } catch {
    // 没有计划时，启动前确认里只用通用说法
  }

  if (drive) {
    lines.push(
      '启动前确认（第 0 步，必须先问用户并等待回答；未回答不得执行 apply）：',
      '先发一条简短的「开始前确认」，一次问清下面 4 项，不要逐项反复追问：',
      '1. JDK：计划按' + (planContext || '当前计划的 Java 版本') + '。生产/目标运行环境是否也是这个 JDK？若不是，先停，不要套用这份计划。',
      '2. 门禁：是否接受策略里的 buildGate（默认 package，会跑测试）？是否允许跳过测试？默认不允许。',
      '3. 跨大版本：计划里的 cross-line 项是否本次处理？默认先不动，推进到该组再人工确认。',
      '4. 属性与代码修复：mysql、okhttp 等项目属性是否允许随框架 BOM 对齐？是否允许按 explain 做最小编译修复（例如删除无用 import）？',
      '若用户没有回答，或回答与计划冲突：停在 plan，不落盘，并说明冲突点。',
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
    '事实源（按需读，不要重复搬运）：',
    '- .quality-center/handoff.md（一页交接：做到哪、下一步、阻塞与规则）',
    '- .quality-center/issues.json / report.md（或 MCP: quality_report format=json）',
    '- .quality-center/upgrade-policy.json（框架上限、禁用依赖、构建门禁）',
    '- .quality-center/skills/quality-center-java-upgrade/SKILL.md（判断类知识）'
  );

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

  if (options.failure && options.failure.trim()) {
    lines.push('', '失败现场（从这里开始判断，别从头重来）：', '```', options.failure.trim().slice(-3000), '```');
  }

  return lines.join('\n');
}
