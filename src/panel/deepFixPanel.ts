import * as fs from 'fs';

export interface DeepFixPreviewInfo {
  label?: string;
  project: string;
  recipes: string[];
  advice: string[];
  dirtyCount: number;
  /** 是否允许勾选部分文件应用 */
  selectable: boolean;
  patchFile?: string;
  files: string[];
}

interface FileDiff {
  file: string;
  added: number;
  removed: number;
  lines: string[];
  truncated: boolean;
}

const MAX_LINES = 400;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function collectDiffs(patchFile: string | undefined, files: string[]): FileDiff[] {
  const sections = new Map<string, string[]>();
  files.forEach((file) => sections.set(file, []));

  if (patchFile && fs.existsSync(patchFile)) {
    let current: string | undefined;
    for (const line of fs.readFileSync(patchFile, 'utf8').split(/\r?\n/)) {
      // 兼容 `diff --git a/x b/x` 与只有 `+++ b/x` 的补丁格式
      const gitHeader = /^diff --git a\/(.+?) b\/(.+?)$/.exec(line);
      const plusHeader = /^\+\+\+ b\/(.+)$/.exec(line);
      const next = gitHeader ? gitHeader[2] : plusHeader ? plusHeader[1] : undefined;
      if (next) {
        current = next;
        if (!sections.has(current)) {
          sections.set(current, []);
        }
        if (gitHeader) {
          continue;
        }
      }
      if (current) {
        sections.get(current)!.push(line);
      }
    }
  }

  return files.map((file) => {
    const lines = sections.get(file) ?? [];
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        added += 1;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        removed += 1;
      }
    }
    return {
      file,
      added,
      removed,
      lines: lines.slice(0, MAX_LINES),
      truncated: lines.length > MAX_LINES
    };
  });
}

function lineClass(line: string): string {
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) {
    return 'meta';
  }
  if (line.startsWith('@@')) {
    return 'hunk';
  }
  if (line.startsWith('+')) {
    return 'add';
  }
  if (line.startsWith('-')) {
    return 'del';
  }
  return 'ctx';
}

export function buildDeepFixPreviewHtml(nonce: string, info: DeepFixPreviewInfo): string {
  const diffs = collectDiffs(info.patchFile, info.files);
  const totalAdded = diffs.reduce((sum, diff) => sum + diff.added, 0);
  const totalRemoved = diffs.reduce((sum, diff) => sum + diff.removed, 0);

  const fileItems = diffs
    .map(
      (diff, index) =>
        `<button class="file-item${index === 0 ? ' active' : ''}" data-target="f-${index}" data-file="${escapeHtml(diff.file)}">`
        + (info.selectable
          ? `<input type="checkbox" class="pick" data-file="${escapeHtml(diff.file)}" checked />`
          : '')
        + `<span class="name">${escapeHtml(diff.file)}</span>`
        + `<span class="stat"><i class="plus">+${diff.added}</i> <i class="minus">-${diff.removed}</i></span>`
        + '</button>'
    )
    .join('');

  const diffBlocks = diffs
    .map((diff, index) => {
      const body = diff.lines
        .map((line) => `<div class="ln ${lineClass(line)}">${escapeHtml(line) || '&nbsp;'}</div>`)
        .join('');
      return `<section class="diff" id="f-${index}">
  <div class="diff-head">
    <span class="name">${escapeHtml(diff.file)}</span>
    <span class="stat"><i class="plus">+${diff.added}</i> <i class="minus">-${diff.removed}</i></span>
  </div>
  <pre class="code">${body}${diff.truncated ? '<div class="ln meta">… 差异过长，仅展示前 400 行，完整内容见修改后的文件</div>' : ''}</pre>
</section>`;
    })
    .join('');

  const recipeLines = info.recipes.map((recipe) => `<span class="chip">${escapeHtml(recipe)}</span>`).join('');
  const advice = info.advice.length
    ? `<div class="meta-line">推荐但未启用：${info.advice.map((item) => escapeHtml(item)).join('、')}</div>`
    : '';
  const dirty =
    info.dirtyCount > 0
      ? `<div class="meta-line warn">检测到 ${info.dirtyCount} 处未提交改动，执行前会完整备份；失败或编译不通过可回滚。</div>`
      : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: flex; flex-direction: column; overflow: hidden;
    font-family: var(--vscode-font-family); font-size: 12px;
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
  }
  header { flex: none; padding: 10px 14px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .title { font-size: 14px; font-weight: 600; }
  .sub { margin-top: 4px; color: var(--vscode-descriptionForeground); }
  .chips { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
  .chip {
    padding: 1px 6px; border-radius: 9px; font-size: 11px;
    background: var(--vscode-badge-background, rgba(128,128,128,.2));
    color: var(--vscode-badge-foreground, var(--vscode-foreground));
  }
  .meta-line { margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .meta-line.warn { color: var(--vscode-editorWarning-foreground, #d7a35f); }
  main { flex: 1 1 auto; min-height: 0; display: flex; }
  aside {
    flex: 0 0 230px; min-width: 0; overflow-y: auto; padding: 8px;
    border-right: 1px solid var(--vscode-panel-border);
  }
  .file-item {
    width: 100%; display: flex; align-items: center; gap: 6px;
    padding: 5px 6px; margin-bottom: 2px; text-align: left;
    border: 1px solid transparent; border-radius: 3px;
    background: transparent; color: var(--vscode-foreground);
    cursor: pointer; font-size: 11px;
  }
  .file-item:hover { background: var(--vscode-list-hoverBackground); }
  .file-item.active { border-color: var(--vscode-focusBorder, #007acc); }
  .file-item .pick { flex: none; accent-color: var(--vscode-button-background); }
  .file-item .name {
    flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .stat { flex: none; font-size: 10px; }
  .plus { color: #3fb950; font-style: normal; }
  .minus { color: #f85149; font-style: normal; }
  section.diffs { flex: 1 1 auto; overflow-y: auto; padding: 8px 12px; }
  .diff { margin-bottom: 14px; }
  .diff-head {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border);
    font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
  }
  .diff-head .name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  pre.code {
    margin: 0; padding: 4px 0; overflow-x: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px; line-height: 1.45;
  }
  .ln { white-space: pre; padding: 0 8px; }
  .ln.add { background: rgba(46,160,67,.18); }
  .ln.del { background: rgba(248,81,73,.16); }
  .ln.hunk { color: #79c0ff; }
  .ln.meta { color: var(--vscode-descriptionForeground); }
  footer {
    flex: none; display: flex; align-items: center; gap: 8px;
    padding: 8px 14px; border-top: 1px solid var(--vscode-panel-border);
  }
  footer .count { flex: 1 1 auto; color: var(--vscode-descriptionForeground); }
  button {
    flex: 0 0 auto; padding: 5px 12px; cursor: pointer; font-size: 12px;
    border-radius: 3px; border: 1px solid transparent;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border-color: var(--vscode-panel-border);
  }
  button:disabled { opacity: .45; cursor: default; }
</style>
</head>
<body>
<header>
  <div class="title">深度修复预览${info.label ? '：' + escapeHtml(info.label) : ''}</div>
  <div class="sub">${escapeHtml(info.project)} · 共 ${diffs.length} 个文件 · <span class="plus">+${totalAdded}</span> / <span class="minus">-${totalRemoved}</span>${info.selectable ? ' · 勾选要应用的文件' : ''}</div>
  <div class="chips">${recipeLines}</div>
  ${dirty}
  ${advice}
</header>
<main>
  <aside>${fileItems}</aside>
  <section class="diffs">${diffBlocks}</section>
</main>
<footer>
  <span class="count" id="count"></span>
  <button id="cancel" class="secondary">取消</button>
  <button id="apply">应用选中文件</button>
</footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const selectable = ${info.selectable ? 'true' : 'false'};
  const boxes = Array.from(document.querySelectorAll('input.pick'));
  const applyBtn = document.getElementById('apply');
  const countEl = document.getElementById('count');

  function selectedFiles() {
    if (!selectable) {
      return Array.from(document.querySelectorAll('.file-item')).map(function (item) {
        return item.getAttribute('data-file') || '';
      }).filter(Boolean);
    }
    return boxes.filter(function (box) { return box.checked; })
      .map(function (box) { return box.getAttribute('data-file'); });
  }

  function sync() {
    const picked = selectedFiles().length;
    const total = document.querySelectorAll('.file-item').length;
    countEl.textContent = '已选 ' + picked + ' / ' + total + ' 个文件';
    applyBtn.disabled = picked === 0;
    applyBtn.textContent = picked === total ? '应用全部改动' : '应用选中文件';
  }

  boxes.forEach(function (box) {
    box.addEventListener('change', sync);
    box.addEventListener('click', function (event) { event.stopPropagation(); });
  });

  document.querySelectorAll('.file-item').forEach(function (item) {
    item.addEventListener('click', function () {
      document.querySelectorAll('.file-item').forEach(function (el) { el.classList.remove('active'); });
      item.classList.add('active');
      const target = document.getElementById(item.getAttribute('data-target'));
      if (target) {
        target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    });
  });

  document.getElementById('cancel').addEventListener('click', function () {
    vscode.postMessage({ type: 'cancel' });
  });

  applyBtn.addEventListener('click', function () {
    const files = selectedFiles();
    if (!files.length) {
      return;
    }
    vscode.postMessage({ type: 'apply', files: files });
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      vscode.postMessage({ type: 'cancel' });
    }
  });

  sync();
</script>
</body>
</html>`;
}
