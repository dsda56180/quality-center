const fs = require('fs');
const path = require('path');
const { getHtml } = require('../out/panel/html.js');
const h = getHtml({ cspSource: 'x', nonce: 'n' });
const provider = fs.readFileSync(path.join(__dirname, '..', 'src', 'panel', 'QualityViewProvider.ts'), 'utf8');
const checks = {
  aiBusy: h.includes('body.ai-busy'),
  aiStatus: h.includes('id="aistatus"'),
  aiBeforeSummary: h.indexOf('id="aistatus"') >= 0 && h.indexOf('id="aistatus"') < h.indexOf('id="summary"'),
  mcpButton: h.includes('id="mcpbtn"') && h.includes('>MCP</button>'),
  mcpOnRight: h.indexOf('class="spacer"') >= 0 && h.indexOf('class="spacer"') < h.indexOf('id="mcpbtn"'),
  msgBar: h.includes('id="msgbar"'),
  msgBarBeforeAi: h.indexOf('id="msgbar"') >= 0 && h.indexOf('id="msgbar"') < h.indexOf('id="aistatus"'),
  noFixBar: !h.includes('id="fixbar"') && !h.includes('id="buildbar"'),
  msgBarActions: h.includes("wizard('生成计划'") || h.includes("wizard('开始扫描'"),
  scopeCopyAi: h.includes('data-wz="copyScopes"') && h.includes('wz-scope-run'),
  msgBarDedupesPlan: h.includes('var planPending') && h.includes('fixable > 0 && !planPending'),
  onePlanActionCenter: !h.includes('升级计划待执行') && h.indexOf('id="wizard"') < h.indexOf('id="tabs"'),
  planDetail: h.includes('wz-fixsection') && h.includes('n.plan.candidates') &&
    !h.includes('<details class="wz-plan">'),
  fullRepairPlan: h.includes('修复方案') && h.includes('静态与配置') &&
    h.includes('配置安全（qcsec）') && h.includes('语义规则（astgrep）'),
  noDuplicateGroupChips: !h.includes('<div class="wz-groups">'),
  noLongPurpose: !h.includes('先选范围：全面修复交给 AI'),
  notesInsideFixPlan: h.includes('<div class="wz-fixbody">') && h.includes('wz-note block'),
  noHandoffCtaAfterPlan: !provider.includes('升级第一组'),
  aiFirstInPlanCard: h.includes('data-wz="copyScopes"') && h.includes('全面修复'),
  scopeChooser: h.includes('wz-scope-picker') && h.includes('scopePickSummary') && h.includes('data-scope-pick="'),
  scopePlanInMenu: h.includes('wz-scope-menu-foot') && h.includes('只生成计划文件，不改 pom'),
  scopeMenuOverlay: h.includes('position: absolute; left: 0; right: 0; top: calc(100% + 4px)'),
  autoFixInPlan: h.includes("btn('fixAll', '自动修复可自动项 ") && h.includes("type: 'fixAll'"),
  convergenceUsesProject: h.includes('按当前 pom 与源码 import 统计'),
  staticNotOneClick: h.includes('SpotBugs / qcsec 不在一键修复范围内'),
  scopeDistinct: ['upgrade', 'consolidation', 'code', 'secrets', 'static'].every((s) =>
    h.includes(`key: '${s}', label:`)
  ),
  scopeCheckboxWiring: h.includes('updateScopePickerUI') && h.includes("type: 'copyScopes'") &&
    provider.includes("case 'copyScopes'"),
  pageScroll: h.includes('overflow-y: auto') && h.includes('#list { overflow: visible; }'),
  planInsideFixPlan: !h.includes('<details class="wz-plan">'),
  fixPlanFolded: h.includes('<details class="wz-fixplan">'),
  mcpReadyHidden: !h.includes("if (mcp.state === 'ready')"),
  noAiDataButton: !h.includes('AI 数据'),
  planUsesNormalizedIssues: (provider.match(/createUpgradePlan\(root, readIssues\(root\)/g) || []).length >= 3,
  progressSeparated: h.includes('progressBusy'),
  catFallback: h.includes('猫咪正在准备扫描'),
  finalReport: h.includes('最终验收')
};
console.log(checks);
if (Object.values(checks).some((value) => !value)) {
  process.exit(1);
}
