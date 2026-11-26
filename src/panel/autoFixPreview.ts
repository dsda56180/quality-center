export interface AutoFixPreviewItem {
  /** 面板快照里的 issue id（从 1 开始） */
  id: number;
  file: string;
  line: number;
  rule: string;
  ruleLabel: string;
  oldText: string;
  newText: string;
  deleted: boolean;
}

export interface AutoFixPreviewInfo {
  project: string;
  items: AutoFixPreviewItem[];
  skipped: number;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 自动修复预览：一个编辑器页签，按文件列出逐行改动，勾选后应用 */
export function buildAutoFixPreviewHtml(nonce: string, info: AutoFixPreviewInfo): string {
  const files = new Map<string, AutoFixPreviewItem[]>();
  for (const item of info.items) {
    if (!files.has(item.file)) {
      files.set(item.file, []);
    }
    files.get(item.file)!.push(item);
  }

  const sections = Array.from(files.entries())
    .map(([file, items]) => {
      const rows = items
        .map(
          (item) => `<section class="item">
  <label class="item-head">
    <input type="checkbox" class="pick" data-id="${item.id}" checked />
    <span class="rule">${escapeHtml(item.ruleLabel)}</span>
    <span class="line">第 ${item.line} 行</span>
  </label>
  <pre class="diff"><div class="ln del">- ${escapeHtml(item.oldText) || '&nbsp;'}</div><div class="ln add">+ ${
    item.deleted ? '（删除此行）' : escapeHtml(item.newText) || '&nbsp;'
  }</div></pre>
</section>`
        )
        .join('');
      return `<h2>${escapeHtml(file)}<span class="hint">${items.length} 项</span></h2>${rows}`;
    })
    .join('');

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
  .toolbar { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  main { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 14px; }
  h2 {
    display: flex; align-items: baseline; gap: 6px;
    margin: 12px 0 6px; font-size: 12px; font-weight: 600;
    font-family: var(--vscode-editor-font-family, monospace); word-break: break-all;
  }
  h2 .hint { flex: none; font-family: var(--vscode-font-family); font-weight: 400; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .item { margin-bottom: 10px; }
  .item-head { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 3px; background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.08)); cursor: pointer; }
  .item-head .pick { accent-color: var(--vscode-button-background); }
  .rule { font-weight: 600; }
  .line { color: var(--vscode-descriptionForeground); }
  pre.diff { margin: 2px 0 0; padding: 2px 0; overflow-x: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.45; }
  .ln { white-space: pre; padding: 0 8px; }
  .ln.del { background: rgba(248,81,73,.16); }
  .ln.add { background: rgba(46,160,67,.18); }
  footer { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-top: 1px solid var(--vscode-panel-border); }
  footer .count { flex: 1 1 auto; color: var(--vscode-descriptionForeground); }
  button { flex: 0 0 auto; padding: 5px 12px; cursor: pointer; font-size: 12px; border-radius: 3px; border: 1px solid transparent; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border-color: var(--vscode-panel-border); }
  button:disabled { opacity: .45; cursor: default; }
  input[type=checkbox] { width: 13px; height: 13px; margin: 0; }
</style>
</head>
<body>
<header>
  <div class="title">自动修复预览</div>
  <div class="sub">${escapeHtml(info.project)} · 共 ${info.items.length} 项 · ${files.size} 个文件${
    info.skipped ? ` · ${info.skipped} 项无法预览/跳过` : ''
  } · 只改源码，不改 pom</div>
  <div class="toolbar"><label><input type="checkbox" id="all" checked /> 全选</label><span>勾选要应用的修改</span></div>
</header>
<main>${sections || '<p>没有可预览的自动修复项。</p>'}</main>
<footer>
  <span class="count" id="count"></span>
  <button id="cancel" class="secondary">取消</button>
  <button id="apply">应用选中修改</button>
</footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const boxes = Array.from(document.querySelectorAll('input.pick'));
  const all = document.getElementById('all');
  const applyBtn = document.getElementById('apply');
  const countEl = document.getElementById('count');
  function sync() {
    const picked = boxes.filter(function (box) { return box.checked; });
    countEl.textContent = '已选 ' + picked.length + ' / ' + boxes.length + ' 项';
    applyBtn.disabled = picked.length === 0;
    all.checked = picked.length === boxes.length;
    all.indeterminate = picked.length > 0 && picked.length < boxes.length;
  }
  boxes.forEach(function (box) { box.addEventListener('change', sync); });
  all.addEventListener('change', function () {
    boxes.forEach(function (box) { box.checked = all.checked; });
    sync();
  });
  document.getElementById('cancel').addEventListener('click', function () {
    vscode.postMessage({ type: 'cancel' });
  });
  applyBtn.addEventListener('click', function () {
    const ids = boxes.filter(function (box) { return box.checked; })
      .map(function (box) { return Number(box.getAttribute('data-id')); });
    if (!ids.length) return;
    vscode.postMessage({ type: 'apply', ids: ids });
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') vscode.postMessage({ type: 'cancel' });
  });
  sync();
</script>
</body>
</html>`;
}
