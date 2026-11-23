#!/usr/bin/env node
/**
 * 一键发版：bump 版本 → 生成 CHANGELOG 段落 → 编译/打包校验 → commit → tag → push
 *          → gh release create → 等 Actions 发布到 Open VSX → 校验线上版本。
 *
 * 用法：
 *   npm run release                # 版本号自动 +1（patch）
 *   npm run release -- 0.17.17     # 指定版本
 *   npm run release -- --dry-run   # 只打印将要做的事，不改文件、不推送
 *   npm run release -- --no-wait   # 建完 Release 就走，不等 Actions
 *   npm run release -- --branch main
 *   npm run release -- --skip-docs # 跳过 README 覆盖度校验
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';
const argv = process.argv.slice(2);

const DRY = argv.includes('--dry-run');
const NO_WAIT = argv.includes('--no-wait');
const NO_VERIFY = argv.includes('--no-verify');
const SKIP_DOCS = argv.includes('--skip-docs');

let versionArg;
let branch = 'main';
for (let i = 0; i < argv.length; i += 1) {
  const item = argv[i];
  if (item === '--branch') {
    branch = argv[i + 1];
    i += 1;
    continue;
  }
  if (!item.startsWith('-')) {
    versionArg = item;
  }
}

function log(message) {
  console.log(`[release] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function run(cmd, cmdArgs = [], options = {}) {
  const { allowFail = false, quiet = false, shell = false, readOnly = false } = options;
  if (!quiet) {
    console.log(`  $ ${cmd} ${cmdArgs.join(' ')}`);
  }
  if (DRY && !readOnly) {
    return { code: 0, stdout: '', stderr: '' };
  }
  try {
    const stdout = execFileSync(cmd, cmdArgs, {
      cwd: repoRoot,
      encoding: 'utf8',
      shell,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { code: 0, stdout: String(stdout || '').trim(), stderr: '' };
  } catch (error) {
    const stdout = String(error.stdout || '').trim();
    const stderr = String(error.stderr || '').trim();
    if (!allowFail) {
      fail(`${cmd} ${cmdArgs.join(' ')} 执行失败（退出码 ${error.status}）：${stderr || stdout || error.message}`);
    }
    return { code: error.status ?? 1, stdout, stderr };
  }
}

const git = (args, options) => run('git', args, options);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseVersion = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || '').trim());
  return match ? match.slice(1).map(Number) : undefined;
};

const readPackage = () => JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

/** 从 CHANGELOG 里取出某个版本的段落正文 */
function sectionBody(text, version) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start < 0) {
    return undefined;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## +/.test(lines[i]) || /^# +/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

/** 没有对应版本段落时，用上个 tag 以来的提交记录生成 */
function buildBodyFromCommits(commits) {
  const items = commits.filter((subject) => !/^chore\(release\)/i.test(subject));
  if (items.length === 0) {
    return undefined;
  }
  return items.map((subject) => `- ${subject}`).join('\n');
}

/** 在 `# Changelog` 标题下面插入新段落 */
function insertSection(text, version, body) {
  const lines = text.split(/\r?\n/);
  const titleIndex = lines.findIndex((line) => /^# +Changelog/i.test(line));
  const block = ['', `## ${version}`, '', ...body.split('\n'), ''];
  if (titleIndex < 0) {
    return ['# Changelog', ...block, ...lines].join('\n');
  }
  // 标题后通常已有一个空行，避免插出两行空行
  while (lines[titleIndex + 1] !== undefined && lines[titleIndex + 1].trim() === '') {
    lines.splice(titleIndex + 1, 1);
  }
  lines.splice(titleIndex + 1, 0, ...block);
  return lines.join('\n');
}

/**
 * README 就是商店里的扩展介绍页：vsce 会把它打进 vsix，Open VSX / VS Code 市场直接展示正文，
 * package.json 的 description 则用于列表摘要。所以发布前必须确认文档跟得上当前功能。
 */
function checkDocs(pkg, version) {
  const readmeFile = path.join(repoRoot, 'README.md');
  if (!fs.existsSync(readmeFile)) {
    fail('缺少 README.md：Open VSX 的扩展介绍页正文来自它，不能省略');
  }
  const readme = fs.readFileSync(readmeFile, 'utf8');
  const problems = [];

  const settings = Object.keys(pkg.contributes?.configuration?.properties || {}).filter((key) =>
    key.startsWith('qualityCenter.')
  );
  const missingSettings = settings.filter((key) => !readme.includes(key));
  if (missingSettings.length > 0) {
    problems.push(`README 未记录 ${missingSettings.length} 个配置项：${missingSettings.join(', ')}`);
  }

  const commands = (pkg.contributes?.commands || []).map((command) => command.title);
  const missingCommands = commands.filter((title) => !readme.includes(title));
  if (missingCommands.length > 0) {
    problems.push(`README 未记录 ${missingCommands.length} 条命令：${missingCommands.join(' / ')}`);
  }

  const staleVersions = [...readme.matchAll(/quality-center-(\d+\.\d+\.\d+)\.vsix/g)]
    .map((match) => match[1])
    .filter((item, index, list) => list.indexOf(item) === index);
  if (staleVersions.length > 0) {
    problems.push(`README 写死了产物版本号（${staleVersions.join(', ')}），请改成 <version> 占位或与当前 ${version} 一致`);
  }

  const description = String(pkg.description || '').trim();
  if (!description) {
    problems.push('package.json 的 description 为空，Open VSX 列表里会显示空白');
  } else if (description.length > 160) {
    problems.push(`description 有 ${description.length} 字，商店列表会截断，建议 ≤ 160 字`);
  }
  if ((pkg.keywords || []).length === 0) {
    problems.push('package.json 的 keywords 为空，影响市场搜索命中');
  }

  return { problems };
}

/** 轮询 Actions，等这次 tag 的发布任务结束 */
async function waitForRun(tag, timeoutMs = 10 * 60_000) {
  const startedAt = Date.now();
  let runId;
  while (Date.now() - startedAt < timeoutMs) {
    const { stdout } = run(
      'gh',
      ['run', 'list', '--workflow', 'publish.yml', '--limit', '10', '--json', 'databaseId,displayTitle,status,conclusion,url'],
      { quiet: true, allowFail: true }
    );
    if (stdout) {
      const runs = JSON.parse(stdout);
      const hit = runs.find((item) => item.displayTitle === tag);
      if (hit) {
        runId = hit.databaseId;
        log(`发现工作流运行 #${runId}（${hit.status}）`);
        break;
      }
    }
    log('等待 Actions 创建运行…');
    await sleep(10_000);
  }
  if (!runId) {
    fail('10 分钟内没有等到 Actions 运行，请到 Actions 页面手动确认');
  }

  while (Date.now() - startedAt < timeoutMs) {
    const { stdout } = run('gh', ['run', 'view', String(runId), '--json', 'status,conclusion,url'], {
      quiet: true,
      allowFail: true
    });
    if (stdout) {
      const info = JSON.parse(stdout);
      if (info.status === 'completed') {
        return { runId, conclusion: info.conclusion, url: info.url };
      }
      log(`工作流状态：${info.status}`);
    }
    await sleep(10_000);
  }
  fail(`工作流 #${runId} 超时未结束，请到 Actions 页面查看`);
}

/** 等 Open VSX 的 latest 指向新版本（接口有 max-age=600 的缓存） */
async function waitForOpenVsx(extensionId, version, timeoutMs = 10 * 60_000) {
  const url = `https://open-vsx.org/api/${extensionId.replace('.', '/')}/latest`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'quality-center-release' } });
      if (response.ok) {
        const data = await response.json();
        if (data.version === version) {
          return true;
        }
        log(`Open VSX latest 仍是 ${data.version}（列表缓存 max-age=600，继续等）`);
      }
    } catch (error) {
      log(`查询 Open VSX 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(30_000);
  }
  return false;
}

async function main() {
  const pkg = readPackage();
  const current = pkg.version;
  const version = String(versionArg || '').replace(/^v/, '') || `${parseVersion(current).slice(0, 2).join('.')}.${parseVersion(current)[2] + 1}`;

  if (!parseVersion(version)) {
    fail(`版本号不合法：${version}（应为 x.y.z）`);
  }
  const next = parseVersion(version);
  const now = parseVersion(current);
  if (next[0] === now[0] && next[1] === now[1] && next[2] === now[2]) {
    fail(`版本号与当前一致（${current}），请指定更大的版本号`);
  }
  if (next[0] < now[0] || (next[0] === now[0] && next[1] < now[1]) ||
      (next[0] === now[0] && next[1] === now[1] && next[2] < now[2])) {
    fail(`新版本 ${version} 小于当前 ${current}`);
  }

  log(`仓库：${repoRoot}`);
  log(`版本：${current} → ${version}${DRY ? '（dry-run）' : ''}`);

  if (SKIP_DOCS) {
    log('跳过 README 覆盖度校验（--skip-docs）');
  } else {
    const { problems } = checkDocs(pkg, version);
    if (problems.length > 0) {
      fail(`README 与当前功能不一致，请先更新文档再发版（临时可加 --skip-docs）：\n  - ${problems.join('\n  - ')}`);
    }
    log('README 已覆盖全部配置项与命令，可作为商店介绍页使用');
  }

  const status = git(['status', '--porcelain'], { quiet: true, readOnly: true }).stdout;
  if (status) {
    if (DRY) {
      log('注意：工作区有未提交改动，实际发版会拒绝执行');
    } else {
      fail('工作区有未提交改动，请先 commit 再发版');
    }
  }

  const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { quiet: true, readOnly: true }).stdout;
  log(`分支：${currentBranch}（要求 ${branch}）`);
  if (currentBranch !== branch && !DRY) {
    fail(`当前分支是 ${currentBranch}，请切到 ${branch} 或加 --branch ${currentBranch}`);
  }

  const ghAuth = run('gh', ['auth', 'status'], { quiet: true, allowFail: true, readOnly: true });
  if (ghAuth.code !== 0 && !DRY) {
    fail('gh 未登录，请先执行 gh auth login');
  }

  const lastTag = git(['describe', '--tags', '--abbrev=0'], { quiet: true, allowFail: true, readOnly: true }).stdout;
  log(`上一个 tag：${lastTag || '（无）'}`);
  if (
    git(['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`], {
      quiet: true,
      allowFail: true,
      readOnly: true
    }).code === 0
  ) {
    fail(`tag v${version} 已存在，Open VSX 也不允许覆盖同版本号，请换一个版本号`);
  }

  const commits = lastTag
    ? git(['log', `${lastTag}..HEAD`, '--pretty=%s'], { quiet: true, allowFail: true, readOnly: true })
        .stdout.split(/\r?\n/)
        .filter(Boolean)
    : [];

  const changelogFile = path.join(repoRoot, 'CHANGELOG.md');
  const changelog = fs.readFileSync(changelogFile, 'utf8');
  const existing = sectionBody(changelog, version);
  const body = existing || buildBodyFromCommits(commits);
  if (!body) {
    fail(`CHANGELOG 里没有 ${version} 段落，且 ${lastTag || '仓库'} 之后没有提交，无法生成发布说明`);
  }
  log(existing ? `CHANGELOG 已有 ${version} 段落，直接复用` : `CHANGELOG 缺少 ${version} 段落，用提交记录生成`);

  log('发布说明：');
  console.log(body.split('\n').map((line) => `    ${line}`).join('\n'));

  // 先 bump 版本（npm version 要求工作区干净），再改 CHANGELOG
  log('更新 package.json / package-lock.json');
  run(npmCmd, ['version', version, '--no-git-tag-version', '--allow-same-version'], { shell: isWin });

  if (!existing) {
    const updated = insertSection(changelog, version, body);
    if (!DRY) {
      fs.writeFileSync(changelogFile, updated, 'utf8');
    }
  }

  log('编译校验');
  run(npmCmd, ['run', 'compile'], { shell: isWin });

  log('打包校验');
  run(npmCmd, ['run', 'package'], { shell: isWin });

  if (DRY) {
    log('dry-run 结束：未修改文件、未提交、未推送');
    return;
  }

  log('提交并打 tag');
  git(['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
  git(['commit', '-m', `chore(release): ${version}`]);
  git(['tag', `v${version}`]);
  git(['push', 'origin', branch]);
  git(['push', 'origin', `v${version}`]);

  const notesFile = path.join(os.tmpdir(), `quality-center-release-${version}.md`);
  fs.writeFileSync(notesFile, `## ${version}\n\n${body}\n`, 'utf8');
  log('创建 GitHub Release（会触发 publish.yml）');
  const created = run('gh', ['release', 'create', `v${version}`, '--title', `v${version}`, '--notes-file', notesFile]);
  console.log(`  ${created.stdout}`);

  if (NO_WAIT) {
    log('已跳过等待 Actions（--no-wait）');
    return;
  }

  const result = await waitForRun(`v${version}`);
  log(`Actions 结果：${result.conclusion}  ${result.url}`);
  if (result.conclusion !== 'success') {
    const failed = run('gh', ['run', 'view', String(result.runId), '--log-failed'], { allowFail: true });
    if (failed.stdout) {
      console.log(failed.stdout);
    }
    fail('发布工作流失败，请查看上面的日志');
  }

  if (NO_VERIFY) {
    log('已跳过 Open VSX 线上校验（--no-verify）');
    return;
  }

  const extensionId = `${pkg.publisher}.${pkg.name}`;
  log('等待 Open VSX 上线（列表缓存最多 10 分钟）');
  const online = await waitForOpenVsx(extensionId, version);
  if (!online) {
    log('Open VSX 尚未指向新版本，可能仍在同步；可稍后用 npm run release -- --no-verify 之外的方式复查');
    return;
  }
  log(`Open VSX 已上线 ${extensionId}@${version}`);
  log(`Release: https://github.com/${pkg.repository?.url?.split('github.com/')[1]?.replace(/\.git$/, '')}/releases/tag/v${version}`);
}

try {
  await main();
} catch (error) {
  console.error(`[release] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
