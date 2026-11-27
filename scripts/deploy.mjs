#!/usr/bin/env node
/**
 * 本地一键部署：编译 → 打包 → 安装到编辑器 → 自动重启。
 *
 * 用法：
 *   npm run deploy                       # 默认 Trae CN，安装后自动重启
 *   npm run deploy -- --editor trae-cn   # 指定编辑器（或传 CLI 绝对路径）
 *   npm run deploy -- --no-restart       # 只安装，不重启
 *   npm run deploy -- --skip-compile     # 复用已有 out/，直接打包
 *   npm run deploy -- --skip-platforms   # 只打当前平台的 AST 二进制（本地快速验证）
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const argv = process.argv.slice(2);

function flag(name) {
  return argv.includes(name);
}

function option(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function log(message) {
  console.log(`[deploy] ${message}`);
}

function run(command, args) {
  const shell = isWin && /\.(cmd|bat)$/i.test(command);
  execFileSync(command, args, { cwd: repoRoot, stdio: 'inherit', shell });
}

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
}

function main() {
  const version = packageVersion();
  log(`版本 ${version}，仓库 ${repoRoot}`);

  if (!flag('--skip-compile')) {
    log('1/4 编译 TypeScript');
    run(npm, ['run', 'compile']);
  } else {
    log('1/4 跳过编译（--skip-compile）');
  }

  log('2/4 打包 VSIX');
  const packArgs = [path.join(repoRoot, 'scripts', 'pack.mjs')];
  if (flag('--skip-platforms')) {
    packArgs.push('--skip-platforms');
  }
  run(process.execPath, packArgs);

  const vsix = path.join(repoRoot, `quality-center-${version}.vsix`);
  if (!fs.existsSync(vsix)) {
    throw new Error(`打包结束但找不到 ${vsix}`);
  }
  const size = fs.statSync(vsix).size;
  log(`3/4 安装 ${path.basename(vsix)}（${(size / 1024 / 1024).toFixed(1)} MB）`);

  const installArgs = [path.join(repoRoot, 'scripts', 'install.mjs'), '--vsix', vsix];
  const editor = option('--editor') || option('--cli');
  if (editor) {
    installArgs.push('--cli', editor);
  }
  if (!flag('--no-restart')) {
    installArgs.push('--restart');
  }
  run(process.execPath, installArgs);

  log('4/4 完成');
  if (flag('--no-restart')) {
    log('已跳过重启（--no-restart），重新打开编辑器后生效。');
  }
}

try {
  main();
} catch (error) {
  console.error(`[deploy] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
