#!/usr/bin/env node
/**
 * 可复现的 VSIX 打包脚本。
 *
 * 为什么不用 `vsce package --no-dependencies`：
 *   --no-dependencies 会把 node_modules 整体排除，@ast-grep/napi 与 @ast-grep/lang-java
 *   打不进包，用户在 IDE 里会看到「语义规则：AST 引擎不可用（Cannot find module '@ast-grep/napi')」。
 *
 * 做法：在临时目录建一棵干净的运行时树（只装 dependencies），补齐各平台 AST 二进制，
 * 再在那里跑 vsce，最后校验 vsix 里确实带上了 napi 原生模块。
 *
 * 用法：
 *   node scripts/pack.mjs                      # 用 package.json 里的版本号
 *   node scripts/pack.mjs --version 0.27.8     # 临时指定版本（不改仓库 package.json）
 *   node scripts/pack.mjs --skip-platforms     # 只带当前平台（本地快速验证）
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { version: null, out: null, skipPlatforms: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--version') out.version = argv[(i += 1)];
    else if (a === '--out') out.out = argv[(i += 1)];
    else if (a === '--skip-platforms') out.skipPlatforms = true;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

function log(message) {
  console.log(`[pack] ${message}`);
}

function copyIfExists(from, to) {
  if (!fs.existsSync(from)) return;
  fs.cpSync(from, to, { recursive: true });
}

function listZip(vsix) {
  // Windows/macOS/Linux 的 tar 都能直接列 zip 内容，避免再引一个 zip 依赖
  return execFileSync('tar', ['-tf', vsix], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split(/\r?\n/)
    .filter(Boolean);
}

function assertAstBundled(vsix) {
  const entries = listZip(vsix);
  const required = [
    'extension/node_modules/@ast-grep/napi/index.js',
    'extension/node_modules/@ast-grep/lang-java/index.js'
  ];
  const missing = required.filter((e) => !entries.includes(e));
  const hasNative = entries.some((e) => /^extension\/node_modules\/@ast-grep\/napi-[^/]+\/.*\.node$/.test(e));
  if (missing.length || !hasNative) {
    throw new Error(
      `VSIX 缺少 AST 引擎，装上后语义规则会整类跳过。缺失：${missing.join(', ') || '(无)'} 原生模块：${hasNative ? '有' : '无'}`
    );
  }
  const platforms = new Set(
    entries
      .map((e) => e.match(/^extension\/node_modules\/(@ast-grep\/napi-[^/]+)\//))
      .filter(Boolean)
      .map((m) => m[1])
  );
  log(`AST 引擎已打包，平台：${[...platforms].join(', ')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const version = args.version ?? pkg.version;
  const vsix = path.resolve(args.out ?? path.join(repoRoot, `quality-center-${version}.vsix`));

  if (!fs.existsSync(path.join(repoRoot, 'out', 'extension.js')) && !fs.existsSync(path.join(repoRoot, 'out', 'cli.js'))) {
    throw new Error('缺少编译产物 out/，请先执行 npm run compile');
  }

  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'qc-pack-'));
  log(`暂存目录 ${staging}`);
  try {
    for (const item of ['package.json', '.vscodeignore', 'README.md', 'CHANGELOG.md', 'LICENSE.txt', 'out', 'skills', 'media']) {
      copyIfExists(path.join(repoRoot, item), path.join(staging, item));
    }

    const stagedPkgPath = path.join(staging, 'package.json');
    const stagedPkg = JSON.parse(fs.readFileSync(stagedPkgPath, 'utf8'));
    stagedPkg.version = version;
    fs.writeFileSync(stagedPkgPath, `${JSON.stringify(stagedPkg, null, 2)}\n`);
    log(`版本 ${version}`);

    log('安装运行时依赖…');
    execSync('npm install --omit=dev --no-audit --no-fund --ignore-scripts', { cwd: staging, stdio: 'inherit' });

    if (!args.skipPlatforms) {
      fs.mkdirSync(path.join(staging, 'scripts'), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, 'scripts', 'fetch-astgrep.mjs'), path.join(staging, 'scripts', 'fetch-astgrep.mjs'));
      log('补齐各平台 AST 二进制…');
      execFileSync(process.execPath, ['scripts/fetch-astgrep.mjs'], { cwd: staging, stdio: 'inherit' });
    }

    log('调用 vsce 打包…');
    const vsceBin = path.join(repoRoot, 'node_modules', '@vscode', 'vsce', 'vsce');
    execFileSync(process.execPath, [vsceBin, 'package', '--out', vsix], { cwd: staging, stdio: 'inherit' });

    assertAstBundled(vsix);
    const size = fs.statSync(vsix).size;
    log(`完成 ${vsix}（${(size / 1024 / 1024).toFixed(1)} MB）`);
    console.log(vsix);
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[pack] 失败：${error.message}`);
  process.exit(1);
});
