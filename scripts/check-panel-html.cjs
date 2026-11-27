const fs = require('fs');
const path = require('path');
const { getHtml } = require('../out/panel/html.js');
const h = getHtml({ cspSource: 'x', nonce: 'n' });
const chooseBranch = h.slice(h.indexOf("key === 'chooseUpgrade'"), h.indexOf("} else if (key === 'showRoutes'"));
const provider = fs.readFileSync(path.join(__dirname, '..', 'src', 'panel', 'QualityViewProvider.ts'), 'utf8');
const finalize = fs.readFileSync(path.join(__dirname, '..', 'src', 'finalize.ts'), 'utf8');
const extension = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
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
  severityPicker: h.includes('id="sevPick"') && h.includes('严重度') &&
    h.includes('minSeverity'),
  scopeCaret: h.includes('wz-scope-caret'),
  fixCaret: h.includes('wz-fixplan-caret') && h.includes('wz-fixplan-fold'),
  msgBarDedupesPlan: !h.includes("action('一键修复'") && !h.includes("action('自动修复'"),
  onePlanActionCenter: !h.includes('升级计划待执行') && h.indexOf('id="wizard"') < h.indexOf('id="tabs"'),
  planDetail: h.includes('wz-fixsection') && h.includes('n.plan.candidates') &&
    !h.includes('<details class="wz-plan">'),
  fullRepairPlan: h.includes('升级计划明细'),
  overviewFirst: h.includes('扫描结果总览') && h.indexOf('扫描结果总览') < h.indexOf('var gate =') &&
    h.indexOf('扫描结果总览') < h.indexOf('var primaryRow'),
  overviewSingleLine: h.includes('.wz-overview-cell .label') &&
    h.includes('white-space: nowrap; overflow: hidden; text-overflow: ellipsis'),
  overviewMergedLabels: h.includes('代码质量+语义') && h.includes('静态+配置') &&
    h.includes('Checkstyle '),
  reportLink: h.includes('data-msg="openReport"') && h.includes('查看报告'),
  reportLinkBound: h.includes('querySelector(\'[data-msg="openReport"]\')') &&
    h.includes("vscode.postMessage({ type: 'openReport' })"),
  choiceRoutes: h.includes('wz-choices') && h.includes('wz-choice-grid') &&
    ['升级依赖', '自动修复', '全部依赖', 'AI 修复'].every((label) => h.includes(label)),
  choiceSingleRow: h.includes('grid-template-columns: repeat(3, minmax(0, 1fr))') &&
    !h.includes('wz-choice-full'),
  choiceCardsFitContent: h.includes('align-items: stretch') &&
    h.includes('min-height: 2.8em; margin-top: 3px'),
  choiceNoWrap: h.includes('flex-wrap: nowrap') &&
    h.includes('white-space: nowrap') &&
    h.includes("'安全修复 ' + fixableCount"),
  noManualLabel: !h.includes('>手动处理<'),
  aiButtonBeforeScope: h.indexOf('id="scopeCopyBtn"') < h.indexOf('class="wz-scope-picker"'),
  choiceButtons: ["btn('chooseUpgrade'", "btn('fixAll'", "btn('upgradeDeps'", 'data-wz="copyScopes"'].every((key) =>
    h.includes(key)
  ),
  chooseUpgradeOpensPreview: chooseBranch.includes("postMessage({ type: 'upgradeDeps' })") &&
    !chooseBranch.includes("routePick = 'upgrade'"),
  routeGate: h.includes('function buildGate(includeDependency)') &&
    h.includes('globalBlocks') && h.includes('buildGate(upgradeFlow || !hubMode)') &&
    h.includes('buildGate(false)') === false,
  routeBack: h.includes("btn('showRoutes'") && h.includes('wz-route-head') &&
    h.includes('升级计划明细'),
  aiFirstHub: h.includes('wz-ai-first') && h.includes('wz-star') && h.includes('★') &&
    !h.includes('为什么 AI 优先') && !h.includes('建议先交给 AI') && !h.includes('AI 负责编排'),
  aiFirstGreen: h.includes('border: 2px solid #3fb950'),
  primaryButtonsBlue: h.includes('#scan,') &&
    h.includes('.wz-ai-first .wz-scope-run') &&
    h.includes('background: #0e639c'),
  hubTitleHidden: h.includes("if (hubMode) title = '';"),
  compactChoiceButtons: h.includes('.wz-choice .secondary') && h.includes('align-self: flex-start; width: auto'),
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
  scopeMenuOverlay: h.includes('position: absolute; left: 0; right: auto; top: calc(100% + 4px)') &&
    h.includes('min-width: 262px'),
  autoFixInPlan: h.includes("btn('fixAll', '安全自动修复 ") && h.includes("type: 'fixAll'"),
  singlePrimaryAction: h.includes('wz-primary-row') && h.includes('wz-primary') &&
    !h.includes('wz-actions'),
  advancedRepairs: h.includes('深度重构（OpenRewrite）') && h.includes("btn('deepFix'") &&
    h.includes("btn('deepScan'") && h.includes('opt-rewritescan'),
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
  projectSwitcher: h.includes('id="projectbar"') && h.includes('id="project-select"') &&
    h.includes("type: 'selectProject'") && !h.includes('全部项目'),
  projectHidesSingle: h.includes('projects.length <= 1') && h.includes("bar.style.display = 'none'"),
  projectOnlyActive: h.includes('只扫描和操作当前项目') && h.includes('projectmeta'),
  finalReport: h.includes('最终验收'),
  finalResultCard: h.includes('本次修复结果') && h.includes('wz-result') &&
    h.includes('state.final') && h.includes('bySource'),
  finalResultExplainsLimits: h.includes('待授权 · ') && h.includes('跨大版本 · ') &&
    h.includes('剩余 · ') && h.includes('可 AI 尝试'),
  finalResultDecisionActions: h.includes("data-wz=\"openPolicy\"") &&
    h.includes("data-wz=\"openHandoff\"") && h.includes("data-wz=\"copyRemaining\"") &&
    h.includes("data-wz=\"openFinalReport\"") && h.includes("data-wz=\"focusIssues\""),
  finalResultProviderWiring: provider.includes("case 'openFinalReport'") &&
    provider.includes("case 'copyRemaining'") && provider.includes('copyRemainingPrompt') &&
    provider.includes('openFinalReport()'),
  finalResultManualGuidance: h.includes('手动：打开升级预览逐项勾选') &&
    h.includes('手动：按来源筛选问题') && h.includes('手动：在交接文件确认兼容性'),
  finalResultEntry: h.includes("focus('查看结果', 'wizard')") &&
    h.includes('项未自动处理'),
  finalResultStaleVisible: h.includes('上一轮修复结果') && h.includes('wz-result-stale') &&
    h.includes('currentPlanId') && provider.includes("staleReason: 'new-plan'") &&
    provider.includes("'newer-scan'"),
  finalScanNotice: h.includes('正在重新扫描') && h.includes('扫描完成后刷新') &&
    h.includes('重扫中') && extension.includes('agentRunActive') &&
    provider.includes('agentRunActive(): boolean'),
  finalHistoryCollapsed: h.includes('wz-result-history') && h.includes('已生效，非当前') &&
    h.includes('historyBlock') && !h.includes('🧾 上一轮验收') &&
    !h.includes('上一轮验收已归档'),
  finalHistoryAtBottom: h.includes('+ historyBlock') && h.includes('当前计划 · ') && h.includes('待执行'),
  finalHistoryNoActions: h.includes('.wz-result-history .wz-result-actions') &&
    h.includes('.wz-result-history .wz-result-row'),
  staticAiAttempt: h.includes('AI 可试') && h.includes('scopeStats.static.ai') &&
    h.includes('totals.ai') && h.includes('AI 先给 diff') &&
    h.includes('copyStaticScopes') && h.includes("scopes: ['static']"),
  finalResultPlanScoped: h.includes('f.planSkipped') && h.includes('f.planCrossLine') &&
    provider.includes('planSkipped') && provider.includes('planCrossLine') &&
    provider.includes("'plan.json'"),
  scopeTruthTotals: h.includes('scopeStats') && h.includes('scopeTotals') &&
    h.includes('scopeTruthText') && h.includes('需确认') && h.includes('只报告'),
  scopeTruthMenu: h.includes('wz-scope-detail') && h.includes('待授权') &&
    h.includes('可自动 '),
  scopeTruthGate: h.includes('当前范围没有可自动写入项') &&
    h.includes('密钥只能报告位置'),
  reportOnlyOverride: h.includes('copyReportOnly') && h.includes('尝试修复只报告项') &&
    provider.includes('copyReportOnlyPrompt') && provider.includes("case 'copyReportOnly'") &&
    provider.includes('先生成 diff'),
  finalReportComplete: finalize.includes('remaining?:') && finalize.includes('policyDenied') &&
    finalize.includes('crossLine') && finalize.includes('reportOnly') &&
    finalize.includes('## 剩余项') && finalize.includes('## 下一步') &&
    finalize.includes('授权覆盖'),
  finalResultNotDuplicated: !h.includes('本次 AI 修复已生成最终验收（') &&
    h.includes('最终验收的明细由下方结果卡展示')
};
console.log(checks);
if (Object.values(checks).some((value) => !value)) {
  process.exit(1);
}
