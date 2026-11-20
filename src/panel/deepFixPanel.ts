import * as fs from 'fs';

export type UpgradePreviewMode = 'parent' | 'bom' | 'plugin' | 'property' | 'extract' | 'manage';

export interface UpgradePreviewChange {
  label: string;
  old: string;
  new: string;
}

export interface UpgradePreviewEntry {
  packageName: string;
  from: string;
  to: string;
  cveCount: number;
  /** 写回 pom 的方式，用于界面标注 */
  mode: UpgradePreviewMode;
  /** 当前版本来源（父 POM / BOM / pom 声明 / 传递依赖） */
  source: string;
  /** 本次升级一并解决的依赖 */
  affects?: string[];
  /** 版本冲突说明 */
  conflicts?: string[];
  /** 附加说明，如插件版本对齐 */
  note?: string;
  /** 可选目标版本，多个时让用户确认 */
  alternatives?: string[];
  /** pom 中的逐条改动 */
  changes: UpgradePreviewChange[];
}

export interface UpgradePreviewInfo {
  project: string;
  entries: UpgradePreviewEntry[];
  skipped: Array<{ packageName: string; reason: string }>;
}

export function buildUpgradePreviewHtml(nonce: string, info: UpgradePreviewInfo): string {
  const MODE_LABEL: Record<UpgradePreviewMode, string> = {
    parent: '父 POM',
    bom: 'BOM',
    plugin: '构建插件',
    property: '属性',
    extract: '版本抽离',
    manage: '版本覆盖'
  };
  const renderCard = (entry: UpgradePreviewEntry, index: number): string => {
    const lines = (value: string, kind: 'del' | 'add'): string =>
      value
        .split(/\r?\n/)
        .map((line) => `<div class="ln ${kind}">${escapeHtml(line) || '&nbsp;'}</div>`)
        .join('');
    const changes = entry.changes
      .map(
        (change) =>
          `<div class="change"><div class="change-label">${escapeHtml(change.label)}</div>`
          + `<pre class="code">${change.old ? lines(change.old, 'del') : ''}${
            change.new ? lines(change.new, 'add') : ''
          }</pre></div>`
      )
      .join('');
    const alternatives =
      entry.alternatives && entry.alternatives.length > 1
        ? `<div class="row"><span class="row-key">目标版本</span>`
          + `<select class="ver-pick" data-pkg="${escapeHtml(entry.packageName)}">`
          + entry.alternatives
            .map(
              (version) =>
                `<option value="${escapeHtml(version)}"${version === entry.to ? ' selected' : ''}>${escapeHtml(
                  version
                )}</option>`
            )
            .join('')
          + '</select><span class="row-hint">多个可用版本，请确认后升级</span></div>'
        : '';
    const affects =
      entry.affects && entry.affects.length
        ? `<div class="row"><span class="row-key">一并解决</span><span class="row-val">${escapeHtml(
            entry.affects.slice(0, 8).join('、')
          )}${entry.affects.length > 8 ? ` 等 ${entry.affects.length} 项` : ''}</span></div>`
        : '';
    const conflicts =
      entry.conflicts && entry.conflicts.length
        ? `<div class="row warn"><span class="row-key">版本冲突</span><span class="row-val">${entry.conflicts
            .map((item) => escapeHtml(item))
            .join('<br>')}</span></div>`
        : '';
    const note = entry.note ? `<div class="row"><span class="row-key">说明</span><span class="row-val">${escapeHtml(entry.note)}</span></div>` : '';
    return `<section class="card" id="u-${index}">
  <label class="card-head">
    <input type="checkbox" class="pick" data-pkg="${escapeHtml(entry.packageName)}" checked />
    <span class="pkg">${escapeHtml(entry.packageName)}</span>
    <span class="ver">${escapeHtml(entry.from)} → <b class="target">${escapeHtml(entry.to)}</b></span>
    <span class="kind">${MODE_LABEL[entry.mode] ?? ''}</span>
    <span class="cve">${entry.cveCount ? entry.cveCount + ' 条漏洞' : '配套升级'}</span>
  </label>
  <div class="row"><span class="row-key">版本来源</span><span class="row-val">${escapeHtml(entry.source)}</span></div>
  ${alternatives}
  ${affects}
  ${conflicts}
  ${changes}
  ${note}
</section>`;
  };
  const framework = info.entries.filter(
    (entry) => entry.mode === 'parent' || entry.mode === 'bom' || entry.mode === 'plugin'
  );
  const direct = info.entries.filter((entry) => entry.mode === 'property' || entry.mode === 'extract');
  const managed = info.entries.filter((entry) => entry.mode === 'manage');
  const cards =
    (framework.length
      ? `<h2>框架 / BOM 升级（${framework.length}）<span class="hint">一次升级整组版本，子依赖不再逐个固定</span></h2>`
        + framework.map((entry) => renderCard(entry, info.entries.indexOf(entry))).join('')
      : '')
    + (direct.length
      ? `<h2>直接依赖（${direct.length}）<span class="hint">版本号统一抽离到 &lt;properties&gt;</span></h2>`
        + direct.map((entry) => renderCard(entry, info.entries.indexOf(entry))).join('')
      : '')
    + (managed.length
      ? `<h2>版本覆盖（${managed.length}）<span class="hint">未直接声明，通过 dependencyManagement 覆盖</span></h2>`
        + managed.map((entry) => renderCard(entry, info.entries.indexOf(entry))).join('')
      : '');

  const groups = new Map<string, string[]>();
  info.skipped.forEach((item) => {
    if (!groups.has(item.reason)) {
      groups.set(item.reason, []);
    }
    groups.get(item.reason)!.push(item.packageName);
  });
  const skipped = groups.size
    ? `<details class="skipped">
  <summary>未纳入自动升级（${info.skipped.length} 项）</summary>
  ${Array.from(groups.entries())
    .map(([reason, names]) => {
      const shown = names.slice(0, 10).join('、') + (names.length > 10 ? ` 等 ${names.length} 项` : '');
      return `<div class="skip-group"><div class="skip-reason">${escapeHtml(reason)}（${names.length}）</div>`
        + `<div class="skip-list">${escapeHtml(shown)}</div></div>`;
    })
    .join('')}
</details>`
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
  main { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 14px; }
  h2 { margin: 10px 0 6px; font-size: 12px; font-weight: 600; }
  h2 .hint { margin-left: 6px; font-weight: 400; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .card { margin-bottom: 12px; }
  .card-head {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px; border-radius: 3px;
    background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.08));
    cursor: pointer;
  }
  .card-head .pick { accent-color: var(--vscode-button-background); }
  .pkg { font-weight: 600; font-family: var(--vscode-editor-font-family, monospace); }
  .ver { color: var(--vscode-descriptionForeground); }
  .ver .target { color: var(--vscode-foreground); }
  .cve { margin-left: auto; font-size: 11px; color: var(--vscode-editorWarning-foreground, #d7a35f); }
  .row { display: flex; gap: 8px; padding: 3px 8px 0; font-size: 11px; line-height: 1.5; }
  .row.warn .row-val { color: var(--vscode-editorWarning-foreground, #d7a35f); }
  .row-key { flex: 0 0 58px; color: var(--vscode-descriptionForeground); }
  .row-val { flex: 1 1 auto; word-break: break-word; }
  .row-hint { flex: 0 0 auto; color: var(--vscode-descriptionForeground); }
  select.ver-pick {
    flex: 0 0 auto; padding: 1px 4px; font-size: 11px;
    background: var(--vscode-dropdown-background, var(--vscode-input-background));
    color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
    border-radius: 3px;
  }
  .change { margin-top: 4px; }
  .change-label { padding-left: 8px; font-size: 10px; color: var(--vscode-descriptionForeground); }
  pre.code {
    margin: 2px 0 0; padding: 2px 0; overflow-x: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px; line-height: 1.45;
  }
  .ln { white-space: pre; padding: 0 8px; }
  .ln.add { background: rgba(46,160,67,.18); }
  .ln.del { background: rgba(248,81,73,.16); }
  .kind {
    padding: 0 6px; border-radius: 8px; font-size: 10px;
    background: rgba(128,128,128,.2); color: var(--vscode-descriptionForeground);
  }
  .skipped { margin-top: 14px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .skipped summary { cursor: pointer; user-select: none; margin-bottom: 6px; }
  .skip-group { margin: 6px 0 10px; padding-left: 6px; border-left: 2px solid var(--vscode-panel-border); }
  .skip-reason { color: var(--vscode-foreground); margin-bottom: 2px; }
  .skip-list { line-height: 1.7; word-break: break-all; }
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
  <div class="title">依赖升级预览</div>
  <div class="sub">${escapeHtml(info.project)} · ${info.entries.length} 个可升级项 · 勾选后执行升级并校验编译</div>
</header>
<main>${cards}${skipped}</main>
<footer>
  <span class="count" id="count"></span>
  <button id="cancel" class="secondary">取消</button>
  <button id="apply">升级并校验编译</button>
</footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const boxes = Array.from(document.querySelectorAll('input.pick'));
  const applyBtn = document.getElementById('apply');
  const countEl = document.getElementById('count');

  function picked() {
    return boxes.filter(function (box) { return box.checked; })
      .map(function (box) { return box.getAttribute('data-pkg'); });
  }

  function sync() {
    const selected = picked().length;
    countEl.textContent = '已选 ' + selected + ' / ' + boxes.length + ' 项';
    applyBtn.disabled = selected === 0;
  }

  boxes.forEach(function (box) { box.addEventListener('change', sync); });

  document.querySelectorAll('select.ver-pick').forEach(function (select) {
    select.addEventListener('change', function () {
      const card = select.closest('.card');
      const target = card ? card.querySelector('.target') : null;
      if (target) {
        target.textContent = select.value;
      }
    });
  });

  document.getElementById('cancel').addEventListener('click', function () {
    vscode.postMessage({ type: 'cancel' });
  });

  applyBtn.addEventListener('click', function () {
    const selected = picked();
    if (!selected.length) {
      return;
    }
    const versions = {};
    selected.forEach(function (name) {
      const select = document.querySelector('select.ver-pick[data-pkg="' + name + '"]');
      if (select) {
        versions[name] = select.value;
      }
    });
    vscode.postMessage({ type: 'apply', packages: selected, versions: versions });
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

/** 读取补丁文件：优先按 UTF-8，失败时回退到 GB18030（Windows 下 Maven 可能用平台编码写文件） */
export function readPatchText(patchFile: string): string {
  const buffer = fs.readFileSync(patchFile);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    for (const encoding of ['gb18030', 'big5']) {
      try {
        return new TextDecoder(encoding).decode(buffer);
      } catch {
        // 尝试下一种编码
      }
    }
    return buffer.toString('utf8');
  }
}

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
    for (const line of readPatchText(patchFile).split(/\r?\n/)) {
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
    ? `<div class="meta-line">配方建议：${info.advice.map((item) => escapeHtml(item)).join('、')}</div>`
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
