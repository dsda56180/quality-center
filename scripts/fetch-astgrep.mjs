#!/usr/bin/env node
/**
 * 把 ast-grep 原生模块的各平台二进制补齐到 node_modules/@ast-grep/，
 * 让单个 vsix 在 Windows / macOS / Linux 上都能直接加载 AST 引擎。
 *
 * npm 默认只装当前平台的 optionalDependency，CI 在 Linux 上打包会漏掉 Windows/macOS，
 * 用户在那些平台装上后 AST 层就会降级。这里按 npm registry（国内默认走 npmmirror）把
 * 其余平台的 tarball 拉下来解开，包内结构与 npm 安装一致。
 *
 * 用法：
 *   node scripts/fetch-astgrep.mjs            # 补齐缺失平台
 *   ASTGREP_NPM_REGISTRY=https://registry.npmjs.org node scripts/fetch-astgrep.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = (process.env.ASTGREP_NPM_REGISTRY || 'https://registry.npmmirror.com').replace(/\/+$/, '');

/** 覆盖所有主流桌面 IDE 平台；Windows ARM 与 musl 走降级（AST 层跳过而非报错） */
const TARGETS = [
  'win32-x64-msvc',
  'win32-arm64-msvc',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64-gnu',
  'linux-arm64-gnu'
];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function log(message) {
  console.log(`[astgrep] ${message}`);
}

async function download(url, dest) {
  const response = await fetch(url, { headers: { 'user-agent': 'quality-center-packaging' } });
  if (!response.ok) {
    throw new Error(`下载失败 ${response.status}：${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fsp.writeFile(dest, buffer);
  log(`已下载 ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
}

async function extract(tgz, targetDir) {
  await fsp.mkdir(targetDir, { recursive: true });
  execFileSync('tar', ['-xzf', tgz, '-C', targetDir, '--strip-components=1'], { stdio: 'ignore' });
}

async function main() {
  const napiPkg = path.join(repoRoot, 'node_modules', '@ast-grep', 'napi', 'package.json');
  if (!fs.existsSync(napiPkg)) {
    throw new Error('缺少 node_modules/@ast-grep/napi，请先执行 npm install');
  }
  const optional = readJson(napiPkg).optionalDependencies || {};
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qc-astgrep-'));

  for (const target of TARGETS) {
    const pkgName = `napi-${target}`;
    const version = optional[`@ast-grep/${pkgName}`];
    if (!version) {
      log(`跳过 ${pkgName}：@ast-grep/napi 未声明该平台`);
      continue;
    }
    const targetDir = path.join(repoRoot, 'node_modules', '@ast-grep', pkgName);
    if (fs.existsSync(path.join(targetDir, 'package.json'))) {
      log(`已存在 ${pkgName}@${version}`);
      continue;
    }
    const tgz = path.join(tmpDir, `${pkgName}-${version}.tgz`);
    const url = `${registry}/@ast-grep/${pkgName}/-/${pkgName}-${version}.tgz`;
    try {
      log(`下载 ${pkgName}@${version}`);
      await download(url, tgz);
      await extract(tgz, targetDir);
      log(`就绪 ${pkgName}`);
    } catch (error) {
      // 打包不应因为某个平台拉取失败而整体失败：运行期会降级为 skipped
      log(`警告：${pkgName} 准备失败（${error instanceof Error ? error.message : String(error)}），该平台 AST 层将降级`);
    }
  }

  await fsp.rm(tmpDir, { recursive: true, force: true });
  log('完成');
}

main().catch((error) => {
  console.error(`[astgrep] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
