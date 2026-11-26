export interface SkippedPreviewItem {
  packageName: string;
  reason: string;
  decision: string;
  installedVersion?: string;
  fixedVersion?: string;
  cveCount?: number;
  /** dependency:tree 里直接引入该包的父节点 */
  introducedBy?: string[];
}

export interface SkippedPreviewInfo {
  project: string;
  planId: string;
  directCount: number;
  items: SkippedPreviewItem[];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isPolicyDenied(item: SkippedPreviewItem): boolean {
  return item.decision === 'policy-denied' || /dependencyManagement|策略未授权/.test(item.reason);
}

/** 「未自动处理的依赖」说明页：讲清原因、展示引入方、只授权选中项 */
export function buildSkippedPreviewHtml(nonce: string, info: SkippedPreviewInfo): string {
  const sorted = info.items
    .slice()
    .sort((a, b) => (b.cveCount ?? 0) - (a.cveCount ?? 0) || a.packageName.localeCompare(b.packageName));
  const policyItems = sorted.filter(isPolicyDenied);
  const manualItems = sorted.filter((item) => !isPolicyDenied(item));

  const rows = policyItems
    .map((item) => {
      const owners = (item.introducedBy ?? []).filter(Boolean);
      const ownerText = owners.length
        ? `由 ${owners.map((owner) => `<code>${escapeHtml(owner)}</code>`).join('、')} 带入`
        : '引入方未解析；它没有被 pom.xml 直接声明';
      return `<label class="item">
  <input type="checkbox" class="pick" data-pkg="${escapeHtml(item.packageName)}" />
  <span class="pkg">${escapeHtml(item.packageName)}</span>
  <span class="ver">${escapeHtml(item.installedVersion || '?')} → ${escapeHtml(item.fixedVersion || '待确认')}</span>
  <span class="cve">${item.cveCount ? `${item.cveCount} 个漏洞` : '未关联漏洞'}</span>
  <span class="owner">${ownerText}</span>
</label>`;
    })
    .join('');

  const manualRows = manualItems
    .map(
      (item) =>
        `<div class="manual-row"><code>${escapeHtml(item.packageName)}</code><span>${escapeHtml(
          item.reason
        )}</span></div>`
    )
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
  header { flex: none; padding: 14px 16px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  .title { font-size: 15px; font-weight: 600; }
  .sub { margin-top: 5px; color: var(--vscode-descriptionForeground); line-height: 1.55; }
  main { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px 16px 18px; }
  .section { margin-bottom: 16px; }
  .section h2 { margin: 0 0 8px; font-size: 12px; font-weight: 600; }
  .why {
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;
  }
  .why-card {
    padding: 9px 10px; border-radius: 4px; line-height: 1.55;
    background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.08));
    border: 1px solid var(--vscode-panel-border);
  }
  .why-card b { display: block; margin-bottom: 3px; font-size: 11px; }
  .why-card span { color: var(--vscode-descriptionForeground); }
  .notice {
    padding: 8px 10px; border-radius: 4px; line-height: 1.6;
    border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
    background: var(--vscode-inputValidation-warningBackground, rgba(204,167,0,.1));
  }
  .option {
    margin-top: 9px; padding: 10px 12px; border-radius: 4px;
    border: 1px solid var(--vscode-panel-border);
  }
  .option-head { display: flex; align-items: center; gap: 7px; font-weight: 600; }
  .tag { flex: none; padding: 1px 5px; border-radius: 3px; font-size: 9px; font-weight: 600; }
  .tag.recommend { background: rgba(46,160,67,.2); color: var(--vscode-testing-iconPassed, #2ea043); }
  .tag.secondary { background: rgba(128,128,128,.15); color: var(--vscode-descriptionForeground); }
  .option p { margin: 6px 0 0; color: var(--vscode-descriptionForeground); line-height: 1.6; }
  .option code, .manual-row code, .item code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12));
    padding: 0 3px; border-radius: 2px;
  }
  .list-head { display: flex; align-items: center; gap: 12px; margin: 10px 0 6px; }
  .list-head label { cursor: pointer; color: var(--vscode-descriptionForeground); }
  .list { border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; }
  .item {
    display: grid; grid-template-columns: 14px minmax(170px, 1.3fr) 90px 72px minmax(150px, 1fr);
    align-items: center; gap: 8px; padding: 6px 8px; line-height: 1.45;
    border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer;
  }
  .item:last-child { border-bottom: 0; }
  .item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.08)); }
  .item .pkg { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
  .item .ver { color: var(--vscode-descriptionForeground); }
  .item .cve { color: var(--vscode-editorWarning-foreground, #cca700); }
  .item .owner { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .manual-row { display: flex; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .manual-row:last-child { border-bottom: 0; }
  .manual-row span { color: var(--vscode-descriptionForeground); }
  footer { flex: none; display: flex; align-items: center; gap: 8px; padding: 9px 16px; border-top: 1px solid var(--vscode-panel-border); }
  footer .count { flex: 1 1 auto; color: var(--vscode-descriptionForeground); }
  footer .hint { color: var(--vscode-descriptionForeground); }
  button { flex: 0 0 auto; padding: 5px 12px; cursor: pointer; font-size: 12px; border-radius: 3px; border: 1px solid transparent; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border-color: var(--vscode-panel-border); }
  button:disabled { opacity: .45; cursor: default; }
  input[type=checkbox] { width: 13px; height: 13px; margin: 0; }
  @media (max-width: 760px) {
    .why { grid-template-columns: 1fr; }
    .item { grid-template-columns: 14px minmax(150px, 1fr) 84px 60px; }
    .item .owner { grid-column: 2 / -1; }
  }
</style>
</head>
<body>
<header>
  <div class="title">${info.items.length} 项依赖没有自动升级</div>
  <div class="sub">${escapeHtml(info.project)} · 计划 ${escapeHtml(info.planId)}。扫描已经发现它们，但插件没有直接改 pom。这里只解释原因，并由你决定怎么处理。</div>
</header>
<main>
  <section class="section">
    <h2>为什么没有升级按钮</h2>
    <div class="why">
      <div class="why-card"><b>它们是传递依赖</b><span>pom.xml 里没有直接声明，是被其他依赖间接带入的。</span></div>
      <div class="why-card"><b>修它们要写版本锁定</b><span>需要往 dependencyManagement 里加版本覆盖，才不会被上游依赖改回去。</span></div>
      <div class="why-card"><b>当前策略没有授权</b><span>你关闭了“自动写版本覆盖”，所以插件只报告、不生成执行按钮。</span></div>
    </div>
    <div class="notice" style="margin-top:8px">这不是漏扫，也不是升级失败。直接依赖的 ${info.directCount} 项仍然可以正常升级；这 ${policyItems.length} 项需要单独决定。</div>
  </section>

  <section class="section">
    <h2>怎么处理</h2>
    <div class="option">
      <div class="option-head"><span class="tag recommend">推荐</span>先升级把它们带进来的直接依赖</div>
      <p>每行末尾的「由 xxx 带入」就是引入方。先升级引入方，复扫后如果这个包被带到安全版本，就不需要写版本覆盖；风险通常更低。引入链不明确的项，可先在终端执行 <code>mvn dependency:tree</code> 确认。</p>
    </div>
    <div class="option">
      <div class="option-head"><span class="tag secondary">按项授权</span>只让你选中的包写版本覆盖</div>
      <p>勾选后，插件会把这几个包加入 <code>.quality-center/upgrade-policy.json</code> 的按项白名单，然后重新生成计划。它不会打开全局开关，也不会直接改 pom；应用前仍会在「依赖升级预览」里逐条展示 diff，由你勾选确认。应用后会跑构建门禁；不兼容当前框架的版本会失败并保留回滚点。</p>
      <div class="list-head"><label><input type="checkbox" id="all" /> 全选</label><span>默认不勾选，避免一次授权太多</span></div>
      <div class="list">${rows || '<div class="manual-row"><span>没有需要按项授权的包。</span></div>'}</div>
    </div>
    ${
      manualRows
        ? `<div class="option"><div class="option-head"><span class="tag secondary">需人工判断</span>其余未纳入项</div><div class="list" style="margin-top:8px">${manualRows}</div></div>`
        : ''
    }
  </section>
</main>
<footer>
  <span class="count" id="count"></span>
  <button id="cancel" class="secondary">暂不处理</button>
  <button id="authorize" disabled>授权选中项并重新生成计划</button>
</footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const boxes = Array.from(document.querySelectorAll('input.pick'));
  const all = document.getElementById('all');
  const authorizeBtn = document.getElementById('authorize');
  const countEl = document.getElementById('count');
  function sync() {
    const picked = boxes.filter(function (box) { return box.checked; });
    countEl.textContent = '已选 ' + picked.length + ' / ' + boxes.length + ' 项';
    authorizeBtn.disabled = picked.length === 0;
    all.checked = picked.length === boxes.length && boxes.length > 0;
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
  authorizeBtn.addEventListener('click', function () {
    const packages = boxes.filter(function (box) { return box.checked; })
      .map(function (box) { return box.getAttribute('data-pkg'); });
    if (!packages.length) return;
    vscode.postMessage({ type: 'authorize', packages: packages });
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') vscode.postMessage({ type: 'cancel' });
  });
  sync();
</script>
</body>
</html>`;
}
