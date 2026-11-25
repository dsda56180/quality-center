const fs = require('fs');
const os = require('os');
const path = require('path');
const rs = require('../out/runState.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-runstate-'));
try {
  rs.setRunActor({ kind: 'mcp', client: 'Trae' });
  rs.beginRun(root, 'autopilot', { phase: 'fix' });
  rs.beginTool(root, 'quality_fix', { write: true });
  // CLI 兜底命令不能把整轮 AI 收尾
  rs.setRunActor({ kind: 'cli' });
  rs.finishRun(root, 'done');
  let state = rs.readRunState(root);
  const delegatedKeepsRunning = state && state.status === 'running' && state.phase !== 'done';

  rs.setRunActor({ kind: 'mcp', client: 'Trae' });
  rs.recordScan(root, { generatedAt: new Date().toISOString(), total: 10, bySource: { spotbugs: 10 } });
  rs.setPhase(root, 'done');
  rs.beginTool(root, 'quality_build', {});
  state = rs.readRunState(root);
  const buildRestoresPhase = state && state.phase === 'static_fix';

  const rawError = JSON.stringify({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          exitCode: 1,
          gate: 'package',
          tests: { state: 'executed', total: 3, failures: 0, errors: 1 }
        })
      }
    ]
  });
  rs.endTool(root, 'quality_build', { ok: false, durationMs: 10, error: rawError });
  state = rs.readRunState(root);
  const conciseError = state && state.lastToolError === '执行失败 · exitCode 1 · gate package · 测试 executed：3 个，失败 0，错误 1';

  const checks = { delegatedKeepsRunning, buildRestoresPhase, conciseError };
  console.log(checks, state);
  if (!delegatedKeepsRunning || !buildRestoresPhase || !conciseError) {
    process.exit(1);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
