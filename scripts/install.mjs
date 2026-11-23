#!/usr/bin/env node
/**
 * 一键安装 Quality Center 到本机编辑器，Windows / macOS / Linux 通用。
 *
 * 用法：
 *   node scripts/install.mjs                 # 自动挑一个编辑器，优先 Trae CN
 *   node scripts/install.mjs --cli trae-cn   # 指定 CLI（名称或绝对路径）
 *   node scripts/install.mjs --vsix <path>   # 指定已打好的 vsix
 *   node scripts/install.mjs --build         # 先编译再打包，然后安装
 *   node scripts/install.mjs --list          # 只列出检测到的编辑器
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const args = process.argv.slice(2);

function flag(name) {
  return args.includes(name);
}

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function log(message) {
  console.log(`[quality-center] ${message}`);
}

/** 在 PATH 里查找命令（Windows 只认 PATHEXT 里的可执行后缀，避免误选无后缀 shim） */
function which(command) {
  const exts = isWin ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const dirs = (process.env.PATH || '')
    .split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${command}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // 继续找
      }
    }
  }
  return undefined;
}

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

/** 编辑器 CLI 候选，顺序即优先级：Trae CN 优先 */
const EDITORS = [
  {
    id: 'trae-cn',
    label: 'Trae CN',
    names: ['trae-cn'],
    paths: isWin
      ? [path.join(localAppData, 'Programs', 'Trae CN', 'bin', 'trae-cn.cmd')]
      : isMac
        ? ['/Applications/Trae CN.app/Contents/Resources/app/bin/trae-cn']
        : ['/usr/share/trae-cn/bin/trae-cn', path.join(os.homedir(), '.local/share/trae-cn/bin/trae-cn')]
  },
  {
    id: 'trae',
    label: 'Trae',
    names: ['trae'],
    paths: isWin
      ? [path.join(localAppData, 'Programs', 'Trae', 'bin', 'trae.cmd')]
      : isMac
        ? ['/Applications/Trae.app/Contents/Resources/app/bin/trae']
        : ['/usr/share/trae/bin/trae', path.join(os.homedir(), '.local/share/trae/bin/trae')]
  },
  {
    id: 'cursor',
    label: 'Cursor',
    names: ['cursor'],
    paths: isWin
      ? [path.join(localAppData, 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd')]
      : isMac
        ? ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor']
        : ['/usr/bin/cursor', path.join(os.homedir(), '.local/bin/cursor')]
  },
  {
    id: 'code',
    label: 'VS Code',
    names: ['code'],
    paths: isWin
      ? [path.join(localAppData, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd')]
      : isMac
        ? ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code']
        : ['/usr/bin/code', '/snap/bin/code']
  },
  {
    id: 'codium',
    label: 'VSCodium',
    names: ['codium'],
    paths: isWin ? [path.join(localAppData, 'Programs', 'VSCodium', 'bin', 'codium.cmd')] : []
  }
];

function resolveEditor(only) {
  if (only) {
    if (fs.existsSync(only)) {
      return { id: path.basename(only), label: only, cli: only };
    }
    const onPath = which(only);
    const known = EDITORS.find((item) => item.id === only || item.names.includes(only));
    const knownPath = known?.paths.find((candidate) => fs.existsSync(candidate));
    const cli = knownPath || onPath;
    return cli ? { id: known?.id || only, label: known?.label || only, cli } : undefined;
  }
  for (const editor of EDITORS) {
    const hit = editor.paths.find((candidate) => fs.existsSync(candidate));
    if (hit) {
      return { id: editor.id, label: editor.label, cli: hit };
    }
    for (const name of editor.names) {
      const onPath = which(name);
      if (onPath) {
        return { id: editor.id, label: editor.label, cli: onPath };
      }
    }
  }
  return undefined;
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

function findVsix(explicit) {
  if (explicit) {
    const resolved = path.isAbsolute(explicit) ? explicit : path.join(repoRoot, explicit);
    if (!fs.existsSync(resolved)) {
      throw new Error(`找不到 vsix：${resolved}`);
    }
    return resolved;
  }
  const version = packageVersion();
  const exact = version ? path.join(repoRoot, `quality-center-${version}.vsix`) : undefined;
  if (exact && fs.existsSync(exact)) {
    return exact;
  }
  const candidates = fs
    .readdirSync(repoRoot)
    .filter((name) => /^quality-center-.*\.vsix$/i.test(name))
    .map((name) => {
      const full = path.join(repoRoot, name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.full;
}

function build() {
  const npm = isWin ? 'npm.cmd' : 'npm';
  log('编译 TypeScript…');
  execFileSync(npm, ['run', 'compile'], { cwd: repoRoot, stdio: 'inherit', shell: isWin });
  log('打包 vsix…');
  execFileSync(npm, ['run', 'package'], { cwd: repoRoot, stdio: 'inherit', shell: isWin });
}

/** 调用编辑器 CLI：Windows 上路径常含空格（如 "Trae CN"），必须自己加引号再走 shell */
function runCli(cli, cliArgs, options = {}) {
  const quote = (value) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  if (isWin) {
    return execFileSync([quote(cli), ...cliArgs.map(quote)].join(' '), { shell: true, ...options });
  }
  return execFileSync(cli, cliArgs, options);
}

function installedIds(cli) {
  try {
    return runCli(cli, ['--list-extensions'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return '';
  }
}

function main() {
  const editor = resolveEditor(option('--cli'));

  if (flag('--list') || !editor) {
    log(`平台：${process.platform} (${os.arch()})`);
    for (const item of EDITORS) {
      const found = resolveEditor(item.id);
      console.log(`  ${found ? '✓' : '·'} ${item.label}${found ? ` — ${found.cli}` : '（未安装）'}`);
    }
    if (!editor && !flag('--list')) {
      throw new Error('没有检测到可用的编辑器 CLI，可用 --cli <路径> 指定');
    }
    return;
  }

  log(`目标编辑器：${editor.label} (${editor.cli})`);

  let vsix = findVsix(option('--vsix'));
  if (!vsix || flag('--build')) {
    build();
    vsix = findVsix(option('--vsix'));
  }
  if (!vsix) {
    throw new Error('没有可安装的 vsix，请先执行 npm run package');
  }
  log(`安装包：${vsix}`);

  runCli(editor.cli, ['--install-extension', vsix, '--force'], {
    cwd: repoRoot,
    stdio: 'inherit'
  });

  const list = installedIds(editor.cli);
  const ok = list.includes('dsda56180.quality-center');
  log(ok ? '安装完成：dsda56180.quality-center 已在扩展列表中' : '命令已执行，但未在扩展列表中确认到 quality-center');
  log(`重启 ${editor.label} 后生效（或执行命令面板的「Developer: Reload Window」）`);
}

try {
  main();
} catch (error) {
  console.error(`[quality-center] 安装失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
