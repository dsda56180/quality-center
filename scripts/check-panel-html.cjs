const { getHtml } = require('../out/panel/html.js');
const h = getHtml({ cspSource: 'x', nonce: 'n' });
const checks = {
  aiBusy: h.includes('body.ai-busy'),
  aiStatus: h.includes('id="aistatus"'),
  aiBeforeSummary: h.indexOf('id="aistatus"') >= 0 && h.indexOf('id="aistatus"') < h.indexOf('id="summary"'),
  mcpButton: h.includes('id="mcpbtn"') && h.includes('>MCP</button>'),
  mcpOnRight: h.indexOf('class="spacer"') >= 0 && h.indexOf('class="spacer"') < h.indexOf('id="mcpbtn"'),
  msgBar: h.includes('id="msgbar"'),
  msgBarBeforeAi: h.indexOf('id="msgbar"') >= 0 && h.indexOf('id="msgbar"') < h.indexOf('id="aistatus"'),
  noFixBar: !h.includes('id="fixbar"') && !h.includes('id="buildbar"'),
  msgBarActions: h.includes("wizard('生成升级计划'") || h.includes("wizard('确认并执行'"),
  msgBarCopyAi: h.includes("action('复制给 AI', 'copyDrivePrompt'"),
  mcpReadyHidden: !h.includes("if (mcp.state === 'ready')"),
  progressSeparated: h.includes('progressBusy'),
  catFallback: h.includes('猫咪正在准备扫描'),
  finalReport: h.includes('最终验收')
};
console.log(checks);
if (Object.values(checks).some((value) => !value)) {
  process.exit(1);
}
