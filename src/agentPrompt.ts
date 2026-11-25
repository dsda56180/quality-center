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
   * drive：用户已授权 AI 连续执行，启动前做 4 项确认；
   * autopilot：默认参数已授权，不逐项提问，一次修到可修完，最后复扫。
   */
  mode?: 'assist' | 'drive' | 'autopilot';
}

export function buildAgentPrompt(root: string, options: AgentPromptOptions = {}): string {
  const drive = options.mode === 'drive';
  const autopilot = options.mode === 'autopilot';
  const lines: string[] = [
    autopilot
      ? '你已被授权一次性完成本项目的质量整改：静态问题、可确定修复项与依赖升级。先做一次“目标确认”，用户确认后连续执行到收尾，不要执行一步就停下等用户再次发起；只有硬阻塞才再次询问。'
      : drive
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

  if (autopilot) {
    lines.push(
      '启动前只做一次「目标确认」，一次问清下面 3 项，不要拆成多轮、不要逐项追问：',
      '1. 目标范围：本次是否处理“静态代码 + 确定性修复 + 依赖/CVE 升级”的全部可修复项（默认是），还是只修高危/CVE？',
      '2. 版本边界：源码保持 Java 8 / Spring Boot 2.7.18；遇到必须升 JDK 11/17/21 或 Spring Boot 3.x 的项，是本次处理、跳过，还是先停下问用户（默认停下询问）？',
      '3. 门禁与权限：buildGate=package、不跳测试、不改测试；允许项目属性覆盖和“删无用 import / 调整修饰符顺序 / 简化布尔比较”等最小代码修复；安全设计、密钥轮换、架构重构只报告不擅自改。是否接受？',
      '用户确认后：按下面默认参数连续执行到收尾，不再每一步征求同意，也不要在完成一个组后停下等用户再发起。',
      '只有出现硬阻塞时才再次询问；用户回答后继续剩余项，不要从头重来。',
      '',
      '确认后的默认参数：',
      '1. JDK：源码保持当前 Java 版本（' + (planContext || '以 pom 为准') + '）；只允许运行时是更高 JDK，不允许擅自改 source/target。',
      '2. 门禁：沿用 upgrade-policy.json 的 buildGate（默认 package），不跳过测试、不改测试、不降低门禁。',
      '3. 跨大版本：默认不写；只有某个 CVE 在当前 Java 8 下没有兼容修复版本时，才把它列为“需要升级 JDK/框架”的阻塞项，不得自行 apply。',
      '4. 属性覆盖与最小代码修复：允许；允许删除无用 import、调整修饰符顺序、简化布尔比较等可逆小改；不允许大范围重构。',
      '5. 静态问题：按下面阶段批量修，不要一条一条问用户。',
      ''
    );
  }

  if (drive) {
    lines.push(
      '启动前确认（第 0 步，必须先问用户并等待回答；未回答不得执行 apply）：',
      '先发一条简短的「开始前确认」，一次问清下面 4 项，不要逐项反复追问：',
      '1. JDK：计划按' + (planContext || '当前计划的 Java 版本') + '。生产/目标运行环境是否也是这个 JDK？若不是，按第 4 条冲突处理，不要直接停：先区分“只换运行 JDK”与“源码也升 JDK”。',
      '2. 门禁：是否接受策略里的 buildGate（默认 package，会跑测试）？是否允许跳过测试？默认不允许。',
      '3. 跨大版本：计划里的 cross-line 项是否本次处理？默认先不动，推进到该组再人工确认。',
      '4. 属性与代码修复：mysql、okhttp 等项目属性是否允许随框架 BOM 对齐？是否允许按 explain 做最小编译修复（例如删除无用 import）？',
      '若用户没有回答：停在 plan，不落盘，等用户补充。',
      '若用户回答与当前计划冲突：不要执行旧计划，也不要只回一句“冲突”；按下面的方式调整并给出新计划：',
      '   - JDK：先区分“运行环境换 JDK，但源码仍按 Java 8 编”与“源码也升到新 JDK/Boot 3.x”。前者确认 Boot 2.7.18 可在该 JDK 运行即可，计划不变；后者必须改策略并重新生成计划。',
      '   - 源码升 JDK：在 `.quality-center/upgrade-policy.json` 写 `targetJavaVersion`（如 "17"），并在 `frameworkTargets` 里给同一 key 设目标框架（如 "17": "3.2.12"）；明确要 Boot 3.x 时同时设 `allowNextFrameworkLine=true`。',
      '   - 门禁：按用户回答改 `buildGate`（compile / package / test），不要用命令行临时绕过。',
      '   - 框架目标：按用户目标改 `frameworkTargets`；只有明确要跨到 Boot 3.x 时才设 `allowNextFrameworkLine=true`。',
      '   - 跨大版本：把用户“本次做/不做”的结论记下来；不做就保留在计划里但停在 needs-confirm，不得自行加 `--allow-cross-line`。',
      '   - 改完策略后运行 `qc upgrade plan .` 生成新计划（不要 `--reuse`），对比旧/新计划的目标版本、分组与 pom.diff，把差异告诉用户；旧计划保留，不删除。',
      '   - 新计划生成后仍不要直接 apply：先让用户确认关键变化，再按 `qc next` 执行。',
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

  if (autopilot) {
    lines.push(
      '',
      '一次性执行流程（优先 MCP，工具不存在才用 CLI；不要每步问用户）：',
      '阶段 1 基线：`quality_scan`（全量）→ `quality_report format=summary` 记录修复前的总数、按来源/严重度计数。',
      '阶段 2 确定性修复：`quality_fix write=true`；然后 `quality_build`（或仅在 pom 未变时先做一次轻量编译）确认没有引入编译失败。',
      '阶段 3 依赖升级：`quality_upgrade_plan` → 按 framework/family/independent 顺序逐组 `quality_upgrade_apply write=true` → 每组 `quality_build` → 失败先 `quality_explain`，同组两次失败 `quality_upgrade_revert` 并把该组列为阻塞。',
      '阶段 4 静态代码：`quality_report format=json` 取剩余问题；按 `.quality-center/skills/quality-center-java-upgrade/SKILL.md` 的判定，优先修有明确文件/行号、改动局部、可编译验证的 Checkstyle/SpotBugs/astgrep 问题；安全设计类、需要改架构或密钥轮换的只记录不擅自改。每修 20 条或每 10 分钟做一次 `quality_build`。',
      '阶段 5 单问题复核：修完后 `quality_scan`（全量）→ `quality_report` 对比修复前/后；不要用旧 issues.json 冒充复验。',
      '阶段 6 收尾：`quality_build` 一次最终构建；若升级计划仍有组未完成，`quality_upgrade_check` 确认没有 drift；输出修复前/后计数、已修文件、剩余问题、阻塞项与证据文件。',
      '',
      '硬阻塞（命中就停这一类，不要停整个流程）：',
      '- 需要把源码 Java 升到 11/17/21，或需要 Spring Boot 3.x / javax→jakarta；',
      '- 某 CVE 在 Java 8 下无兼容修复版本，或 cross-line 依赖只能靠大版本解决；',
      '- 构建失败无法用 quality_explain 归因，或测试失败是代码语义变化导致；',
      '- 密钥/凭证泄露需要轮换、权限模型需要产品决策、需要大范围重构。',
      '命中硬阻塞时：先问用户“这一项本次处理 / 跳过 / 先记录”，不要强行改 source/target、不要跳测试、不要 --allow-cross-line；用户回答后继续其他可修项，最后统一汇总。用户不回答则跳过该项并在最终汇总里列出。',
      '',
      '用户沟通规则：',
      '- 除了启动目标确认和硬阻塞，过程不提问；每完成一个阶段只输出一行进度（阶段、已修数、构建结果）。',
      '- 确认后一次执行到底，不要每完成一组就停下来等用户再次发起。',
      '- 只有上述硬阻塞出现时才明确说“这一项需要升级 JDK/框架或人工决策”，其余情况继续执行。',
      '- 最终必须给出一份汇总：修复前 → 修复后、按来源变化、剩余与阻塞、改动文件、复验命令；不要只说“已完成”。'
    );
  }

  if (options.failure && options.failure.trim()) {
    lines.push('', '失败现场（从这里开始判断，别从头重来）：', '```', options.failure.trim().slice(-3000), '```');
  }

  return lines.join('\n');
}
