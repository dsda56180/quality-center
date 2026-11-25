const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildAgentPrompt } = require('../out/agentPrompt.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-scope-'));
const base = { mode: 'autopilot' };
const texts = {
  all: buildAgentPrompt(root, base),
  upgrade: buildAgentPrompt(root, { ...base, scope: 'upgrade' }),
  consolidation: buildAgentPrompt(root, { ...base, scope: 'consolidation' }),
  code: buildAgentPrompt(root, { ...base, scope: 'code' }),
  secrets: buildAgentPrompt(root, { ...base, scope: 'secrets' }),
  static: buildAgentPrompt(root, { ...base, scope: 'static' })
};

const checks = {
  allRunsFullFlow: texts.all.includes('一次性执行流程'),
  allIncludesConsolidation: texts.all.includes('阶段 3.5 依赖收敛'),
  upgradeOnly: texts.upgrade.includes('只处理「依赖版本升级 / CVE」') &&
    texts.upgrade.includes('不得调用 quality_fix'),
  consolidationOnly: texts.consolidation.includes('只处理「依赖收敛') &&
    texts.consolidation.includes('不能省略') &&
    texts.consolidation.includes('不自动删依赖'),
  codeOnly: texts.code.includes('quality_fix write=false') &&
    texts.code.includes('不改 pom'),
  secretsOnly: texts.secrets.includes('绝不打印') &&
    texts.secrets.includes('轮换'),
  staticOnly: texts.static.includes('SpotBugs') &&
    texts.static.includes('每修 20 条'),
  noUpgradeFlowInScoped: ['consolidation', 'code', 'secrets', 'static'].every(
    (key) => !texts[key].includes('阶段 2 确定性修复') && !texts[key].includes('quality_upgrade_apply')
  ),
  switchKeepsScope: texts.code.includes('必须带同一个 scope')
};
console.log(checks);
fs.rmSync(root, { recursive: true, force: true });
if (Object.values(checks).some((value) => !value)) {
  process.exit(1);
}
