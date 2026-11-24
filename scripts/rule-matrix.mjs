#!/usr/bin/env node
/**
 * 规则矩阵：拿 fixtures/ 下的样例跑真实扫描，把「应该报什么」和「实际报了什么」对齐。
 *
 * 用法：
 *   npm run rules:matrix              # 跑全部用例
 *   npm run rules:matrix -- --no-build  # 不自动编译（要求 target/classes 已存在）
 *   npm run rules:matrix -- cors       # 只跑 id 含 cors 的用例
 *
 * 状态含义：
 *   PASS  必须命中的规则都命中了，且没有出现禁止命中的规则
 *   FAIL  与 expect 不符（规则失效 / 误报 / 接线断了）
 *   GAP   该层还没有扫描器（例如配置层的 qcsec 未实现），只记录不判负
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const cli = path.join(repoRoot, 'out', 'cli.js');
const casesDir = path.join(repoRoot, 'fixtures', 'cases');

const argv = process.argv.slice(2);
const noBuild = argv.includes('--no-build');
const filter = argv.find((item) => !item.startsWith('--'));

if (!fs.existsSync(cli)) {
  console.error(`[matrix] 找不到 ${cli}，先执行 npm run compile`);
  process.exit(2);
}

const run = (command, args, cwd, useShell = false) => {
  // Windows 下 mvn 是 .cmd，Node 18+ 不能直接 spawn，必须走 shell；
  // 但 node 可执行文件路径含空格，走 shell 会被截断，所以只在 mvn 上开 shell。
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 600_000,
    shell: useShell && process.platform === 'win32'
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

const analyze = (caseDir, scanners) => {
  const only = scanners.length > 0 ? ['--only', scanners.join(',')] : [];
  const result = run(
    process.execPath,
    [cli, 'scan', caseDir, '--json', '--fail-on', 'none', '--no-export', ...only],
    caseDir
  );
  const lastJson = result.stdout.slice(result.stdout.indexOf('{'));
  try {
    return JSON.parse(lastJson);
  } catch {
    return { error: `输出无法解析（退出码 ${result.code}）：${result.stderr.slice(-500)}` };
  }
};

const ensureBuilt = (caseDir) => {
  if (noBuild) {
    return '';
  }
  const classes = path.join(caseDir, 'target', 'classes');
  if (fs.existsSync(classes) && fs.readdirSync(classes).length > 0) {
    return '';
  }
  console.error(`[matrix] 编译 ${path.basename(caseDir)} …`);
  const build = run('mvn', ['-B', '-q', 'compile'], caseDir, true);
  if (build.code !== 0) {
    const tail = (build.stderr || build.stdout)
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .slice(-3)
      .join(' / ');
    return `编译失败：${tail || `退出码 ${build.code}`}`;
  }
  return '';
};

const cases = fs
  .readdirSync(casesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => !filter || name.includes(filter))
  .sort();

const rows = [];
let failed = 0;

for (const name of cases) {
  const caseDir = path.join(casesDir, name);
  const meta = JSON.parse(fs.readFileSync(path.join(caseDir, 'expect.json'), 'utf8'));
  const scanners = Array.isArray(meta.scanners) ? meta.scanners : [];

  if (scanners.length === 0) {
    rows.push({ name, layer: meta.layer, status: 'GAP', detail: '该层暂无扫描器', rules: [] });
    continue;
  }

  if (meta.requiresBuild) {
    const buildError = ensureBuilt(caseDir);
    if (buildError) {
      rows.push({ name, layer: meta.layer, status: 'FAIL', detail: buildError, rules: [] });
      failed += 1;
      continue;
    }
  }

  const payload = analyze(caseDir, scanners);
  if (payload.error) {
    rows.push({ name, layer: meta.layer, status: 'FAIL', detail: payload.error, rules: [] });
    failed += 1;
    continue;
  }

  const actual = Array.from(new Set((payload.issues || []).map((issue) => issue.rule)));
  const mustFire = meta.expect?.mustFire ?? [];
  const mustNotFire = meta.expect?.mustNotFire ?? [];
  const missing = mustFire.filter((rule) => !actual.includes(rule));
  const unexpected = mustNotFire.filter((rule) => actual.includes(rule));

  if (missing.length === 0 && unexpected.length === 0) {
    rows.push({ name, layer: meta.layer, status: 'PASS', detail: actual.join(', ') || '无告警', rules: actual });
  } else {
    failed += 1;
    const parts = [];
    if (missing.length > 0) parts.push(`未命中 ${missing.join(', ')}`);
    if (unexpected.length > 0) parts.push(`误报 ${unexpected.join(', ')}`);
    rows.push({ name, layer: meta.layer, status: 'FAIL', detail: parts.join('；'), rules: actual });
  }
}

const pad = (text, width) => String(text).padEnd(width, ' ');
const nameWidth = Math.max(24, ...rows.map((row) => row.name.length + 2));

console.log(`${pad('用例', nameWidth)}${pad('层', 8)}${pad('状态', 8)}说明`);
console.log('-'.repeat(nameWidth + 8 + 8 + 40));
for (const row of rows) {
  console.log(`${pad(row.name, nameWidth)}${pad(row.layer, 8)}${pad(row.status, 8)}${row.detail}`);
}

const pass = rows.filter((row) => row.status === 'PASS').length;
const gap = rows.filter((row) => row.status === 'GAP').length;
const fail = rows.filter((row) => row.status === 'FAIL').length;
console.log(`\n合计 ${rows.length} 个用例：PASS ${pass} / GAP ${gap} / FAIL ${fail}`);
console.log('GAP = 清单里已有规则定义、但还没有扫描器实现（见 docs/RULES.md）');

process.exit(fail > 0 ? 1 : 0);
