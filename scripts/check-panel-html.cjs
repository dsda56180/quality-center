const { getHtml } = require('../out/panel/html.js');
const h = getHtml({ cspSource: 'x', nonce: 'n' });
const checks = {
  aiBusy: h.includes('body.ai-busy'),
  aiStatus: h.includes('id="aistatus"'),
  aiBeforeSummary: h.indexOf('id="aistatus"') >= 0 && h.indexOf('id="aistatus"') < h.indexOf('id="summary"'),
  mcpButton: h.includes('id="mcpbtn"') && h.includes('>MCP</button>'),
  msgBar: h.includes('id="msgbar"'),
  msgBarBeforeAi: h.indexOf('id="msgbar"') >= 0 && h.indexOf('id="msgbar"') < h.indexOf('id="aistatus"'),
  progressSeparated: h.includes('progressBusy'),
  catFallback: h.includes('猫咪正在准备扫描'),
  finalReport: h.includes('最终验收')
};
console.log(checks);
if (Object.values(checks).some((value) => !value)) {
  process.exit(1);
}
