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
  emptyWorkbench: h.includes("case 'scan':") && h.includes('wz-empty') && !h.includes("wizard('开始扫描'"),
  msgBarActions: h.includes("action('构建并扫描'"),
  scopeCopyAi: h.includes('data-wz="copyScopes"') && h.includes('wz-scope-run'),
  scopeCaret: h.includes('wz-scope-caret'),
  fixCaret: h.includes('wz-fixplan-caret') && h.includes('wz-fixplan-fold'),
  msgBarDedupesPlan: !h.includes("action('一键修复'") && !h.includes("action('自动修复'"),
  onePlanActionCenter: !h.includes('升级计划待执行') && h.indexOf('id="wizard"') < h.indexOf('id="tabs"'),
  planDetail: h.includes('wz-fixsection') && h.includes('n.plan.candidates') &&
    !h.includes('<details class="wz-plan">'),
  fullRepairPlan: h.includes('升级计划明细'),
  overviewFirst: h.includes('扫描结果总览') && h.indexOf('扫描结果总览') < h.indexOf('var gate =') &&
    h.indexOf('扫描结果总览') < h.indexOf('var primaryRow'),
  choiceRoutes: h.includes('wz-choices') && h.includes('wz-choice-grid') &&
    ['升级依赖', '自动修复', '全部依赖', 'AI 修复'].every((label) => h.includes(label)),
  choiceButtons: ["btn('chooseUpgrade'", "btn('fixAll'", "btn('upgradeDeps'", 'data-wz="copyScopes"'].every((key) =>
    h.includes(key)
  ),
  routeGate: h.includes('function buildGate(includeDependency)') &&
    h.includes('globalBlocks') && h.includes('buildGate(upgradeFlow || !hubMode)') &&
    h.includes('buildGate(false)') === false,
  routeBack: h.includes("btn('showRoutes'") && h.includes('wz-route-head') &&
    h.includes('升级计划明细'),
  aiFirstHub: h.includes('wz-ai-first') && h.includes('wz-star') && h.includes('★') &&
    !h.includes('为什么 AI 优先') && !h.includes('建议先交给 AI') && !h.includes('AI 负责编排'),
  upgradeDetailOnly: h.includes('<strong>升级计划明细</strong>') &&
    !h.includes('配置安全（qcsec）') && !h.includes('SpotBugs / qcsec 不在一键修复范围内'),
  detailsLast: h.includes('upgradeFlow ? fixPlan') && h.indexOf('hubMode ? choiceHub') > h.indexOf('var primaryRow'),
  noDuplicateGroupChips: !h.includes('<div class="wz-groups">'),
  noLongPurpose: !h.includes('先选范围：全面修复交给 AI'),
  notesInsideFixPlan: h.includes('<div class="wz-fixbody">') && !h.includes('notes +'),
  blockersAboveFold: h.includes('var gate =') && h.includes('wz-gate block') &&
    h.indexOf('var primaryRow') > h.indexOf('var gate ='),
  rollbackEverywhere: h.includes('function addRevert()') && h.includes("'回滚到计划前', false, 'danger'") &&
    h.includes('addRevert();'),
  busyLocksWrites: h.includes('var writeKeys') && h.includes('busy && writeKeys[key]'),
  openPolicyPrimary: h.includes("btn('openPolicy'") && h.includes("type: 'openPolicyPreview'") &&
    provider.includes('openPolicyPreview'),
  noHandoffCtaAfterPlan: !provider.includes('升级第一组'),
  aiFirstInPlanCard: h.includes('data-wz="copyScopes"') && h.includes('AI 修复'),
  scopeChooser: h.includes('wz-scope-picker') && h.includes('scopePickSummary') && h.includes('data-scope-pick="'),
  scopePlanInMenu: !h.includes('scopePlanBtn') && !h.includes('wz-scope-menu-foot'),
  scopeMenuOverlay: h.includes('position: absolute; left: 0; right: 0; top: calc(100% + 4px)'),
  autoFixInPlan: h.includes("btn('fixAll', '安全自动修复 ") && h.includes("type: 'fixAll'"),
  singlePrimaryAction: h.includes('wz-primary-row') && h.includes('wz-primary') &&
    !h.includes('wz-actions'),
  advancedRepairs: h.includes('高级修复') && h.includes("btn('deepFix'") && h.includes("btn('upgradeDeps'"),
  noToolbarWrites: !h.includes('id="deepfix"') && !h.includes('id="upgrade"'),
  upgradePreviewPage: provider.includes('await this.showUpgradePreview'),
  upgradePreviewOnlySkips: fs.readFileSync(path.join(__dirname, '..', 'src', 'panel', 'deepFixPanel.ts'), 'utf8')
    .includes('直接依赖已处理完'),
  upgradePreviewExplain: fs.readFileSync(path.join(__dirname, '..', 'src', 'panel', 'deepFixPanel.ts'), 'utf8')
    .includes('id="authorizeSkips"') && provider.includes("message.type === 'authorizeSkips'"),
  autoFixPreviewPage: provider.includes('showAutoFixPreview') && fs.existsSync(path.join(__dirname, '..', 'src', 'panel', 'autoFixPreview.ts')),
  skippedDecision: h.includes('需要你决定 · ') && h.includes('wz-gate warn') &&
    !h.includes('wz-decision-btn') && !h.includes('打开升级预览，一并选择'),
  skippedPlainReason: !h.includes('策略未授权或需人工处理') && !h.includes('allowDependencyManagement=false'),
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
