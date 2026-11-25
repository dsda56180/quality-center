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
  scopeCopyAi: h.includes('data-wz="copyScope:all"') && h.includes('wz-scope-btn primary'),
  msgBarDedupesPlan: h.includes('var planPending') && h.includes('fixable > 0 && !planPending'),
  onePlanActionCenter: !h.includes('升级计划待执行') && h.indexOf('id="wizard"') < h.indexOf('id="tabs"'),
  planDetail: h.includes('计划明细') && h.includes('n.plan.cveTotal') && h.includes('n.plan.candidates'),
  fullRepairPlan: h.includes('全面修复方案') && h.includes('不只依赖升级') && h.includes("duplicate: '收敛'"),
  noHandoffCtaAfterPlan: !provider.includes('升级第一组'),
  aiFirstInPlanCard: h.includes('data-wz="copyScope:all"') && h.includes('全面修复'),
  scopeChooser: h.includes('选择修复范围') && h.includes("data-wz=\"createPlan\"") && h.includes('修复某一块'),
  scopeDistinct: ['consolidation', 'code', 'secrets', 'static'].every((s) =>
    h.includes(`data-wz="copyScope:${s}"`) || h.includes(`scopeBtn('${s}'`)
  ),
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
