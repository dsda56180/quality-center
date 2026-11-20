export interface SnapshotIssue {
  id: number;
  source: string;
  severity: string;
  file: string;
  abs: string;
  line: number;
  rule: string;
  message: string;
  link: string;
  fixable: boolean;
  deepFixable: boolean;
  packageName: string;
  installedVersion: string;
  fixedVersion: string;
  zhSummary: string;
  advice: string;
  title: string;
  description: string;
  cvss: number;
  cwe: string[];
  references: string[];
  publishedAt: string;
  category: string;
}

export interface SnapshotSuggestion {
  category: string;
  title: string;
  detail: string;
  impact: number;
}

export interface Snapshot {
  type: 'state';
  scanning: boolean;
  deepFix?: { stage: string; startedAt: number } | null;
  scanStartedAt?: number | null;
  scanProgress?: { done: number; total: number; active: string[] };
  finishedAt: number | null;
  issues: SnapshotIssue[];
  ignored: SnapshotIssue[];
  suggestions: SnapshotSuggestion[];
  errors: { source: string; message: string }[];
  skipped: { source: string; reason: string }[];
  agentFile?: string;
  buildHint?: string;
  upgradeEnabled?: boolean;
  scanOptions?: {
    checkstyle: boolean;
    gitleaks: boolean;
    trivy: boolean;
    spotbugs: boolean;
    scanOnSave: boolean;
  };
}

export function getHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 10px;
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .toolbar { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
  button {
    flex: 1 1 auto;
    padding: 5px 8px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    cursor: pointer;
    font-size: 12px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .45; cursor: default; filter: none; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border-color: var(--vscode-panel-border);
  }
  .summary {
    display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
    padding: 8px; margin-bottom: 10px;
    border-radius: 4px;
    background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.1));
  }
  .catbar { display: none; margin: 0 0 10px; }
  .catbar.on { display: block; }
  .cat-stage { position: relative; height: 26px; }
  .cat-track {
    position: absolute; left: 0; right: 0; bottom: 2px; height: 9px;
    border-radius: 9px; overflow: hidden;
    background: var(--vscode-input-background, rgba(128,128,128,.15));
    border: 1px solid var(--vscode-panel-border);
  }
  .cat-fill {
    position: absolute; top: 0; bottom: 0; width: 34%;
    border-radius: 9px; transition: width .3s ease;
    background: linear-gradient(90deg,
      transparent 0%,
      var(--vscode-progressBar-background, #3794ff) 30%,
      #8fd3ff 50%,
      var(--vscode-progressBar-background, #3794ff) 70%,
      transparent 100%);
    filter: blur(.3px);
    animation: catFill 3.2s linear infinite;
  }
  .cat-runner {
    position: absolute; bottom: 6px; left: -24px;
    font-size: 20px; line-height: 1;
    animation: catRun 3.2s linear infinite;
    will-change: left;
    pointer-events: none;
  }
  .cat-runner .cat {
    display: inline-block;
    animation: catBob .5s ease-in-out infinite alternate;
    filter: drop-shadow(0 1px 1px rgba(0,0,0,.25));
  }
  .cat-tip {
    display: block; margin-top: 2px;
    font-size: 10px; color: var(--vscode-descriptionForeground);
  }
  .cat-tip::after { content: ''; animation: catDots 1.4s steps(4, end) infinite; }
  @keyframes catRun {
    from { left: -24px; }
    to { left: calc(100% - 18px); }
  }
  @keyframes catBob {
    from { transform: translateY(0) rotate(-8deg); }
    to { transform: translateY(-5px) rotate(8deg); }
  }
  @keyframes catFill {
    from { left: -38%; }
    to { left: 100%; }
  }
  @keyframes catDots {
    0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; }
  }
  .ai-link {
    margin-left: auto; flex: none; padding: 1px 8px;
    font-size: 10px; border-radius: 10px;
    background: transparent; color: var(--vscode-textLink-foreground);
    border: 1px solid var(--vscode-panel-border); cursor: pointer;
  }
  .ai-link:hover { background: var(--vscode-list-hoverBackground); }
  .chip { padding: 2px 8px; border-radius: 10px; font-size: 11px; white-space: nowrap; }
  .chip[data-sev], .chip[data-clear] { cursor: pointer; user-select: none; }
  .chip[data-sev]:hover, .chip[data-clear]:hover { filter: brightness(1.15); }
  .chip.active { outline: 1px solid currentColor; outline-offset: 1px; font-weight: 600; }
  .c-critical { background: rgba(209,52,56,.18); color: #e05c5c; }
  .c-high     { background: rgba(224,123,57,.18); color: #e08a4f; }
  .c-medium   { background: rgba(217,161,11,.18); color: #d9a10b; }
  .c-low      { background: rgba(58,141,219,.18); color: #4a9fe0; }
  .c-info     { background: rgba(140,140,140,.18); color: #9d9d9d; }
  .tabs {
    display: flex; flex-wrap: wrap; gap: 2px 4px;
    margin-bottom: 8px; padding-bottom: 2px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .tab {
    flex: 0 0 auto; padding: 4px 7px; font-size: 11px;
    background: transparent; color: var(--vscode-descriptionForeground);
    border: none; border-bottom: 2px solid transparent; border-radius: 0;
    white-space: nowrap;
  }
  .tab:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
  .tab.active {
    color: var(--vscode-foreground); font-weight: 600;
    border-bottom-color: var(--vscode-focusBorder, #007acc);
  }
  input[type="search"] {
    width: 100%; padding: 4px 6px; margin-bottom: 10px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 3px;
  }
  .group-title {
    margin: 12px 0 6px; font-weight: 600; font-size: 11px;
    text-transform: uppercase; letter-spacing: .04em;
    color: var(--vscode-descriptionForeground);
  }
  .item {
    padding: 6px 8px; margin-bottom: 4px;
    border-left: 3px solid var(--vscode-panel-border);
    border-radius: 3px;
    background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.08));
    cursor: pointer;
  }
  .item:hover { background: var(--vscode-list-hoverBackground); }
  .item .head { display: flex; gap: 6px; align-items: baseline; }
  .sev { font-size: 10px; padding: 0 5px; border-radius: 8px; flex: none; }
  .rule { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: .85; }
  .copy-one, .fix-one, .detail-toggle {
    flex: none; padding: 1px 6px; font-size: 10px;
    background: transparent; color: var(--vscode-textLink-foreground);
    border: 1px solid var(--vscode-panel-border); border-radius: 3px;
  }
  .copy-one:hover, .fix-one:hover, .detail-toggle:hover { background: var(--vscode-list-hoverBackground); }
  .actions { margin-left: auto; display: flex; gap: 4px; flex: none; }
  .fixbar {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px; margin-bottom: 8px; border-radius: 4px;
    background: rgba(58,141,219,.14); font-size: 11px;
  }
  .fixbar button { flex: none; padding: 2px 10px; font-size: 11px; }
  .buildbar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 6px 8px; margin-bottom: 8px; border-radius: 4px;
    background: rgba(217,161,11,.14); font-size: 11px; line-height: 1.5;
  }
  .buildbar span { flex: 1 1 160px; }
  .buildbar button { flex: none; padding: 2px 10px; font-size: 11px; }
  .loc { margin-top: 3px; font-size: 11px; color: var(--vscode-descriptionForeground); word-break: break-all; }
  .msg { margin-top: 2px; line-height: 1.45; word-break: break-word; }
  .empty, .hint { color: var(--vscode-descriptionForeground); padding: 8px 0; line-height: 1.6; }
  .notice { margin-top: 8px; font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.6; }
  .sug {
    padding: 8px 10px; margin-bottom: 8px; border-radius: 4px;
    background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.08));
    border-left: 3px solid var(--vscode-focusBorder, #007acc);
  }
  .sug-head { display: flex; gap: 6px; align-items: baseline; }
  .sug-tag {
    flex: none; font-size: 10px; padding: 0 5px; border-radius: 8px;
    background: rgba(58,141,219,.18); color: #4a9fe0;
  }
  .sug-title { font-weight: 600; line-height: 1.4; }
  .sug-detail { margin-top: 4px; line-height: 1.55; color: var(--vscode-descriptionForeground); }
  .sug-actions { margin-top: 6px; }
  .copy-sug {
    flex: none; padding: 1px 6px; font-size: 10px;
    background: transparent; color: var(--vscode-textLink-foreground);
    border: 1px solid var(--vscode-panel-border); border-radius: 3px;
  }
  .copy-sug:hover { background: var(--vscode-list-hoverBackground); }
  .msg.clamp {
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .more { margin-top: 4px; font-size: 10px; color: var(--vscode-textLink-foreground); }
  .detail {
    margin-top: 6px; padding-top: 6px; display: none;
    border-top: 1px dashed var(--vscode-panel-border);
  }
  .detail.open { display: block; }
  .d-row { display: flex; gap: 6px; margin-bottom: 4px; line-height: 1.5; }
  .d-key {
    flex: none; width: 62px; font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  .d-val { flex: 1 1 auto; word-break: break-word; }
  .d-sec { margin: 8px 0 3px; font-weight: 600; font-size: 11px; }
  .d-en { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
  .d-actions { margin-top: 6px; display: flex; gap: 4px; flex-wrap: wrap; }
  .link-one {
    padding: 1px 6px; font-size: 10px;
    background: transparent; color: var(--vscode-textLink-foreground);
    border: 1px solid var(--vscode-panel-border); border-radius: 3px;
  }
  .link-one:hover { background: var(--vscode-list-hoverBackground); }
  .mask {
    position: fixed; inset: 0; z-index: 20; display: none;
    align-items: center; justify-content: center;
    background: rgba(0, 0, 0, .45);
  }
  .mask.on { display: flex; }
  .dialog {
    width: min(320px, 92vw);
    padding: 12px;
    border-radius: 6px;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    box-shadow: 0 8px 24px rgba(0, 0, 0, .35);
  }
  .dlg-title { font-weight: 600; font-size: 13px; margin-bottom: 8px; }
  .dlg-presets { display: flex; gap: 6px; margin-bottom: 8px; }
  .dlg-row {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 0; font-size: 12px; cursor: pointer;
  }
  .dlg-row input { accent-color: var(--vscode-button-background); }
  .dlg-hint { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 8px 0 4px; line-height: 1.5; }
  .dlg-actions { display: flex; gap: 6px; margin-top: 10px; }
</style>
</head>
<body>
  <div class="toolbar">
    <button id="scan">重新扫描</button>
    <button id="deepfix" class="secondary">深度修复</button>
    <button id="upgrade" class="secondary">升级依赖</button>
    <button id="copy" class="secondary">复制给 AI</button>
    <button id="save" class="secondary">导出报告</button>
    <button id="settings" class="secondary" title="配置扫描类型与自动扫描">设置</button>
  </div>
  <div id="mask" class="mask">
    <div class="dialog">
      <div class="dlg-title">扫描设置</div>
      <div class="dlg-presets">
        <button id="preset-fast" class="secondary">快速模式</button>
        <button id="preset-full" class="secondary">完整模式</button>
      </div>
      <label class="dlg-row"><input type="checkbox" id="opt-checkstyle" /> 代码质量（Checkstyle）</label>
      <label class="dlg-row"><input type="checkbox" id="opt-gitleaks" /> 密钥泄露（Gitleaks）</label>
      <label class="dlg-row"><input type="checkbox" id="opt-trivy" /> 依赖漏洞（Trivy）</label>
      <label class="dlg-row"><input type="checkbox" id="opt-spotbugs" /> 静态缺陷（SpotBugs，较慢）</label>
      <label class="dlg-row"><input type="checkbox" id="opt-scansave" /> 保存文件后自动扫描</label>
      <div class="dlg-hint">快速模式关闭 SpotBugs，约 15 秒；完整模式约 35 秒。已缓存的结果不会重复执行。</div>
      <div class="dlg-actions">
        <button id="set-cancel" class="secondary">取消</button>
        <button id="set-apply">应用并扫描</button>
      </div>
    </div>
  </div>
  <div id="catbar" class="catbar">
    <div class="cat-stage">
      <div class="cat-track"><div class="cat-fill"></div></div>
      <div class="cat-runner"><span class="cat">🐱</span></div>
    </div>
    <span class="cat-tip" id="cattip">猫咪正在奔跑检查代码</span>
  </div>
  <div id="summary" class="summary"><span class="hint">尚未扫描</span></div>
  <div class="tabs" id="tabs">
    <button class="tab active" data-tab="all">全部</button>
    <button class="tab" data-tab="checkstyle">代码质量</button>
    <button class="tab" data-tab="gitleaks">密钥泄露</button>
    <button class="tab" data-tab="trivy">依赖漏洞</button>
    <button class="tab" data-tab="spotbugs">静态缺陷</button>
    <button class="tab" data-tab="ignored">已忽略</button>
    <button class="tab" data-tab="suggest">建议</button>
  </div>
  <input type="search" id="q" placeholder="搜索文件、规则或描述">
  <div id="notice" class="notice"></div>
  <div id="fixbar" class="fixbar" style="display:none">
    <span id="fixtip"></span>
    <button id="fixall">一键修复</button>
  </div>
  <div id="buildbar" class="buildbar" style="display:none">
    <span id="buildtip"></span>
    <button id="build">构建并扫描</button>
  </div>
  <div id="list"><div class="empty">点击「重新扫描」开始</div></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const SRC_LABEL = { checkstyle: '代码质量', gitleaks: '密钥泄露', trivy: '依赖漏洞', spotbugs: '静态缺陷' };
  const CAT_LABEL = {
    SECURITY: '安全漏洞',
    CORRECTNESS: '逻辑正确性',
    MALICIOUS_CODE: '可变对象暴露',
    BAD_PRACTICE: '不良实践',
    PERFORMANCE: '性能问题',
    STYLE: '可疑代码',
    I18N: '国际化'
  };
  const SUG_LABEL = { framework: '框架升级', dependency: '依赖升级', secret: '密钥治理', manual: '人工处理' };
  const SEV_LABEL = { critical: '严重', high: '高危', medium: '中危', low: '低危', info: '提示' };
  const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
  let state = { scanning: false, deepFix: null, scanStartedAt: null, scanProgress: { done: 0, total: 0, active: [] }, finishedAt: null, issues: [], ignored: [], suggestions: [], errors: [], skipped: [], upgradeEnabled: true, scanOptions: { checkstyle: true, gitleaks: true, trivy: true, spotbugs: true, scanOnSave: true } };
  let activeTab = 'all';
  let severityFilter = [];
  let query = '';

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function updateTabs() {
    const issues = state.issues || [];
    const ignored = state.ignored || [];
    const suggestions = state.suggestions || [];
    document.querySelectorAll('.tab').forEach(function (tab) {
      const key = tab.getAttribute('data-tab');
      const count = key === 'all'
        ? issues.length
        : (key === 'ignored'
            ? ignored.length
            : (key === 'suggest'
                ? suggestions.length
                : issues.filter(function (i) { return i.source === key; }).length));
      const label = key === 'all'
        ? '全部'
        : (key === 'ignored' ? '已忽略' : (key === 'suggest' ? '修复建议' : SRC_LABEL[key]));
      tab.textContent = label + ' ' + count;
      tab.classList.toggle('active', activeTab === key);
    });
  }

  function detailHtml(issue) {
    function row(key, val) {
      return val
        ? '<div class="d-row"><span class="d-key">' + key + '</span><span class="d-val">' + esc(val) + '</span></div>'
        : '';
    }
    var html = '';
    if (issue.source === 'trivy') {
      html += row('漏洞编号', issue.rule);
      html += row('影响组件', issue.packageName + ' ' + issue.installedVersion);
      html += row('修复版本', issue.fixedVersion || '暂无');
      if (issue.cvss) {
        html += row('CVSS', String(issue.cvss) + ((issue.cwe || []).length ? '（' + issue.cwe.join(', ') + '）' : ''));
      } else if ((issue.cwe || []).length) {
        html += row('CWE', issue.cwe.join(', '));
      }
      if (issue.publishedAt) {
        html += row('披露时间', issue.publishedAt);
      }
    } else {
      html += row('规则', issue.rule);
      if (issue.title) {
        html += row('类型', issue.title);
      }
      if (issue.category) {
        html += row('类别', CAT_LABEL[issue.category] || issue.category);
      }
      if ((issue.cwe || []).length) {
        html += row('CWE', issue.cwe.join(', '));
      }
      html += row('位置', (issue.file || '') + (issue.line ? ':' + issue.line : ''));
    }
    if (issue.zhSummary) {
      html += '<div class="d-sec">问题说明</div><div class="d-en">' + esc(issue.zhSummary) + '</div>';
    }
    if (issue.advice) {
      html += '<div class="d-sec">修复建议</div><div class="d-en">' + esc(issue.advice) + '</div>';
    }
    if (issue.source === 'trivy' && (issue.title || issue.description)) {
      html += '<div class="d-sec">英文原文</div><div class="d-en">' + esc(issue.title || '')
        + (issue.description ? '<br/>' + esc(issue.description) : '') + '</div>';
    } else if (issue.source !== 'trivy' && issue.message) {
      html += '<div class="d-sec">原始信息</div><div class="d-en">' + esc(issue.message) + '</div>';
    }
    var links = '';
    if (issue.source === 'trivy' && issue.packageName && issue.fixedVersion && state.upgradeEnabled !== false) {
      links += '<button class="link-one upgrade-one" data-upgrade="' + esc(issue.packageName) + '">升级此依赖</button>';
    }
    if (issue.link) {
      links += '<button class="link-one" data-url="' + esc(issue.link) + '">打开漏洞库</button>';
    }
    (issue.references || []).forEach(function (ref, index) {
      links += '<button class="link-one" data-url="' + esc(ref) + '">参考 ' + (index + 1) + '</button>';
    });
    if (activeTab === 'ignored') {
      links += '<button class="link-one unignore-one" data-unignore="' + issue.id + '">恢复此问题</button>';
    } else {
      if (issue.deepFixable) {
        links += '<button class="link-one rule-fix" data-rulefix="' + issue.id + '">深度修复此规则</button>';
      }
      links += '<button class="link-one ignore-one" data-ignore="' + issue.id + '">忽略此问题</button>';
    }
    if (activeTab !== 'ignored') {
      links += '<button class="copy-one" data-copy="' + issue.id + '">复制详情给 AI</button>';
    }
    html += '<div class="d-actions">' + links + '</div>';
    return html;
  }

  function toggleDetail(node, issue) {
    var box = node.querySelector('.detail');
    if (!box) return;
    if (!box.innerHTML) {
      box.innerHTML = detailHtml(issue);
    }
    var open = box.classList.toggle('open');
    var more = node.querySelector('.more');
    if (more) {
      more.textContent = open ? '收起详情 ▴' : '点击查看详情与修复建议 ▸';
    }
  }

  function scanSeconds() {
    return state.scanStartedAt ? Math.max(0, Math.floor((Date.now() - state.scanStartedAt) / 1000)) : 0;
  }

  function scanProgressText() {
    var progress = state.scanProgress || { done: 0, total: 0, active: [] };
    var parts = [];
    if (progress.total) {
      parts.push('已完成 ' + progress.done + '/' + progress.total);
    }
    var sec = scanSeconds();
    if (sec > 0) {
      parts.push('已用 ' + sec + ' 秒');
    }
    return parts.join(' · ');
  }

  function catTipText() {
    if (state.deepFix) {
      var sec = Math.max(0, Math.floor((Date.now() - state.deepFix.startedAt) / 1000));
      return '猫咪正在深度修复：' + state.deepFix.stage + ' · 已用 ' + sec + ' 秒';
    }
    if (state.scanning) {
      var progress = scanProgressText();
      return '猫咪正在奔跑检查代码' + (progress ? '（' + progress + '）' : '');
    }
    return '';
  }

  function render() {
    updateTabs();
    var upgradeBtn = document.getElementById('upgrade');
    if (upgradeBtn) {
      upgradeBtn.style.display = state.upgradeEnabled === false ? 'none' : '';
    }
    var deep = state.deepFix;
    var busy = !!state.scanning || !!deep;
    ['scan', 'deepfix', 'upgrade'].forEach(function (id) {
      var button = document.getElementById(id);
      if (button) {
        button.disabled = busy;
      }
    });
    document.getElementById('catbar').classList.toggle('on', busy);
    document.getElementById('cattip').textContent = catTipText();
    var fill = document.querySelector('.cat-fill');
    var progress = state.scanProgress || { done: 0, total: 0 };
    if (fill) {
      fill.style.width = progress.total
        ? Math.max(8, Math.round((progress.done / progress.total) * 100)) + '%'
        : '34%';
    }
    const sum = document.getElementById('summary');
    if (!state.finishedAt) {
      // 进度只在顶部猫咪进度条展示，这里保持安静，避免同一组数字重复三遍
      sum.style.display = busy ? 'none' : '';
      sum.innerHTML = '<span class="hint">尚未扫描</span>';
    } else {
      sum.style.display = '';
      const issues = state.issues || [];
      const chips = SEV_ORDER.map(function (sev) {
        const total = issues.filter(function (i) { return i.severity === sev; }).length;
        const active = severityFilter.indexOf(sev) >= 0;
        if (!total && !active) return '';
        return '<span class="chip c-' + sev + (active ? ' active' : '') + '" data-sev="' + sev
          + '" title="' + (active ? '取消该等级' : '加入筛选（可多选）') + '">'
          + SEV_LABEL[sev] + ' ' + total + '</span>';
      }).join('');
      const time = new Date(state.finishedAt).toLocaleTimeString();
      const visible = severityFilter.length === 0
        ? issues.length
        : issues.filter(function (i) { return severityFilter.indexOf(i.severity) >= 0; }).length;
      const totalText = severityFilter.length === 0
        ? '共 ' + issues.length + ' 项'
        : '共 ' + visible + ' / ' + issues.length + ' 项';
      const aiButton = state.agentFile
        ? '<button class="ai-link" title="AI agent 可直接读取 ' + esc(state.agentFile) + '">AI 数据</button>'
        : '';
      const clearChip = severityFilter.length > 0
        ? '<span class="chip c-info" data-clear="1" title="清除等级筛选">✕ 清除等级</span>'
        : '';
      sum.innerHTML = (issues.length ? chips : '<span class="chip c-info">未发现问题</span>')
        + '<span class="chip">' + totalText + ' · ' + time + '</span>'
        + clearChip
        + aiButton;
    }

    const list = document.getElementById('list');
    if (state.scanning && !state.finishedAt) {
      list.innerHTML = '<div class="empty">扫描完成后将在这里列出问题</div>';
    } else if (!state.finishedAt) {
      list.innerHTML = deep
        ? '<div class="empty">深度修复进行中，完成后会自动重新扫描。</div>'
        : '<div class="empty">点击「重新扫描」开始</div>';
    } else if (activeTab === 'suggest') {
      const suggestions = state.suggestions || [];
      list.innerHTML = suggestions.length
        ? suggestions.map(function (s, i) {
            return '<div class="sug">'
              + '<div class="sug-head"><span class="sug-tag">' + (SUG_LABEL[s.category] || esc(s.category)) + '</span>'
              + '<span class="sug-title">' + esc(s.title) + '</span></div>'
              + '<div class="sug-detail">' + esc(s.detail) + '</div>'
              + '<div class="sug-actions"><button class="copy-sug" data-sug="' + (i + 1) + '">复制建议</button>'
              + '<span class="sug-impact"> 可覆盖 ' + s.impact + ' 项问题</span></div></div>';
          }).join('')
        : '<div class="empty">暂无可推导的修复建议</div>';
    } else {
      const sourceIssues = activeTab === 'ignored' ? (state.ignored || []) : (state.issues || []);
      const filtered = sourceIssues.filter(function (issue) {
        if (activeTab !== 'all' && activeTab !== 'ignored' && issue.source !== activeTab) return false;
        if (severityFilter.length > 0 && severityFilter.indexOf(issue.severity) < 0) return false;
        if (!query) return true;
        const hay = (issue.file + ' ' + issue.rule + ' ' + issue.message + ' ' + (issue.zhSummary || '')).toLowerCase();
        return hay.indexOf(query) >= 0;
      });
      if (!filtered.length) {
        list.innerHTML = '<div class="empty">' + (activeTab === 'ignored' ? '还没有忽略的问题' : '没有匹配的问题')
          + (severityFilter.length > 0
              ? '（当前只看' + severityFilter.map(function (s) { return SEV_LABEL[s]; }).join('、') + '，再次点击标签可取消）'
              : '')
          + '</div>';
      } else {
        list.innerHTML = ['checkstyle', 'gitleaks', 'spotbugs', 'trivy'].map(function (source) {
          const group = filtered.filter(function (i) { return i.source === source; });
          if (!group.length) return '';
          const items = group.map(function (issue) {
            const isCve = issue.source === 'trivy';
            const loc = isCve
              ? esc(issue.packageName) + ' ' + esc(issue.installedVersion)
                + ' → ' + esc(issue.fixedVersion || '暂无修复版本')
              : (issue.file
                  ? esc(issue.file) + (issue.line ? ':' + issue.line : '')
                  : '依赖清单');
            const linkAttr = issue.link ? ' data-link="' + esc(issue.link) + '"' : '';
            const text = issue.zhSummary || issue.message;
            return '<div class="item" data-id="' + issue.id + '" data-abs="' + esc(issue.abs)
              + '" data-line="' + (issue.line || 0) + '"' + linkAttr + '>'
              + '<div class="head"><span class="sev c-' + issue.severity + '">' + SEV_LABEL[issue.severity] + '</span>'
              + '<span class="rule">' + esc(issue.rule) + '</span>'
              + '<span class="actions">'
              + (activeTab === 'ignored'
                  ? '<button class="unignore-one" data-unignore="' + issue.id + '">恢复</button>'
                  : (issue.fixable ? '<button class="fix-one" data-fix="' + issue.id + '">修复</button>' : ''))
              + (issue.zhSummary ? '<button class="detail-toggle" data-detail="' + issue.id + '">详情</button>' : '')
              + (activeTab === 'ignored' ? '' : '<button class="copy-one" data-copy="' + issue.id + '">复制</button>')
              + '</span></div>'
              + '<div class="msg' + (issue.zhSummary ? ' clamp' : '') + '">' + esc(text) + '</div>'
              + '<div class="loc">' + loc + '</div>'
              + (issue.zhSummary && !issue.abs ? '<div class="more">点击查看详情与修复建议 ▸</div>' : '')
              + '<div class="detail" id="d-' + issue.id + '"></div>'
              + '</div>';
          }).join('');
          return '<div class="group-title">' + SRC_LABEL[source] + ' (' + group.length + ')</div>' + items;
        }).join('');
      }
    }

    const notes = [];
    (state.errors || []).forEach(function (e) { notes.push('⚠ ' + (SRC_LABEL[e.source] || e.source) + ' 扫描异常：' + esc(e.message)); });
    (state.skipped || []).forEach(function (s) { notes.push('· 已跳过 ' + (SRC_LABEL[s.source] || s.source) + '：' + esc(s.reason)); });
    document.getElementById('notice').innerHTML = notes.join('<br>');

    const fixable = (state.issues || []).filter(function (i) { return i.fixable; }).length;
    const bar = document.getElementById('fixbar');
    if (!busy && fixable > 0) {
      bar.style.display = 'flex';
      document.getElementById('fixtip').textContent =
        '可自动修复 ' + fixable + ' 项（无用导入 / 冗余导入 / 修饰符顺序 / 布尔表达式简化）';
    } else {
      bar.style.display = 'none';
    }

    const buildbar = document.getElementById('buildbar');
    if (!busy && state.finishedAt && state.buildHint) {
      buildbar.style.display = 'flex';
      document.getElementById('buildtip').textContent = state.buildHint;
    } else {
      buildbar.style.display = 'none';
    }
  }

  document.getElementById('summary').addEventListener('click', function (e) {
    if (e.target.getAttribute && e.target.getAttribute('data-clear')) {
      severityFilter = [];
      render();
      return;
    }
    const sevChip = e.target.closest ? e.target.closest('[data-sev]') : null;
    if (sevChip) {
      const sev = sevChip.getAttribute('data-sev');
      const index = severityFilter.indexOf(sev);
      if (index >= 0) {
        severityFilter.splice(index, 1);
      } else {
        severityFilter.push(sev);
      }
      render();
      return;
    }
    if (e.target.classList && e.target.classList.contains('ai-link')) {
      vscode.postMessage({ type: 'openAgent' });
    }
  });
  document.getElementById('scan').addEventListener('click', function () {
    vscode.postMessage({ type: 'scan' });
  });
  document.getElementById('deepfix').addEventListener('click', function () {
    vscode.postMessage({ type: 'deepFix' });
  });
  document.getElementById('upgrade').addEventListener('click', function () {
    vscode.postMessage({ type: 'upgradeDeps' });
  });

  var SETTING_KEYS = ['checkstyle', 'gitleaks', 'trivy', 'spotbugs'];
  function settingBox(key) {
    return document.getElementById('opt-' + key);
  }
  function openSettings() {
    var options = state.scanOptions || {};
    SETTING_KEYS.forEach(function (key) {
      settingBox(key).checked = options[key] !== false;
    });
    document.getElementById('opt-scansave').checked = options.scanOnSave !== false;
    document.getElementById('mask').classList.add('on');
  }
  function closeSettings() {
    document.getElementById('mask').classList.remove('on');
  }
  function applyPreset(fast) {
    SETTING_KEYS.forEach(function (key) {
      settingBox(key).checked = fast ? key !== 'spotbugs' : true;
    });
  }
  document.getElementById('settings').addEventListener('click', openSettings);
  document.getElementById('set-cancel').addEventListener('click', closeSettings);
  document.getElementById('mask').addEventListener('click', function (event) {
    if (event.target === document.getElementById('mask')) {
      closeSettings();
    }
  });
  document.getElementById('preset-fast').addEventListener('click', function () {
    applyPreset(true);
  });
  document.getElementById('preset-full').addEventListener('click', function () {
    applyPreset(false);
  });
  document.getElementById('set-apply').addEventListener('click', function () {
    var options = { scanOnSave: document.getElementById('opt-scansave').checked };
    SETTING_KEYS.forEach(function (key) {
      options[key] = settingBox(key).checked;
    });
    closeSettings();
    vscode.postMessage({ type: 'saveSettings', options: options });
  });
  document.getElementById('copy').addEventListener('click', function () {
    vscode.postMessage({ type: 'copy' });
  });
  document.getElementById('save').addEventListener('click', function () {
    vscode.postMessage({ type: 'save' });
  });
  document.getElementById('q').addEventListener('input', function (e) {
    query = e.target.value.trim().toLowerCase();
    render();
  });
  document.getElementById('tabs').addEventListener('click', function (e) {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    activeTab = tab.getAttribute('data-tab');
    render();
  });
  document.getElementById('fixall').addEventListener('click', function () {
    vscode.postMessage({ type: 'fixAll' });
  });
  document.getElementById('build').addEventListener('click', function () {
    vscode.postMessage({ type: 'buildAndScan' });
  });
  document.getElementById('list').addEventListener('click', function (e) {
    if (e.target.classList && e.target.classList.contains('copy-sug')) {
      vscode.postMessage({ type: 'copySuggestion', id: Number(e.target.getAttribute('data-sug')) });
      e.stopPropagation();
      return;
    }
    if (e.target.classList && e.target.classList.contains('fix-one')) {
      vscode.postMessage({ type: 'fixIssue', id: Number(e.target.getAttribute('data-fix')) });
      e.stopPropagation();
      return;
    }
    if (e.target.classList && e.target.classList.contains('copy-one')) {
      vscode.postMessage({ type: 'copyIssue', id: Number(e.target.getAttribute('data-copy')) });
      e.stopPropagation();
      return;
    }
    if (e.target.classList && e.target.classList.contains('unignore-one')) {
      vscode.postMessage({ type: 'unignore', id: Number(e.target.getAttribute('data-unignore')) });
      e.stopPropagation();
      return;
    }
    if (e.target.classList && e.target.classList.contains('ignore-one')) {
      vscode.postMessage({ type: 'ignore', id: Number(e.target.getAttribute('data-ignore')) });
      e.stopPropagation();
      return;
    }
    if (e.target.classList && e.target.classList.contains('rule-fix')) {
      vscode.postMessage({ type: 'deepFixRule', id: Number(e.target.getAttribute('data-rulefix')) });
      e.stopPropagation();
      return;
    }
    if (e.target.classList && e.target.classList.contains('upgrade-one')) {
      vscode.postMessage({ type: 'upgradeDeps', pkg: e.target.getAttribute('data-upgrade') });
      e.stopPropagation();
      return;
    }
    if (e.target.classList && e.target.classList.contains('detail-toggle')) {
      const target = e.target.closest('.item');
      const detailId = Number(e.target.getAttribute('data-detail')) || 0;
      const detailPool = activeTab === 'ignored' ? (state.ignored || []) : (state.issues || []);
      const detailIssue = detailPool.filter(function (i) { return i.id === detailId; })[0];
      if (target && detailIssue) {
        toggleDetail(target, detailIssue);
      }
      e.stopPropagation();
      return;
    }
    if (e.target.classList && e.target.classList.contains('link-one')) {
      const url = e.target.getAttribute('data-url');
      if (url) {
        vscode.postMessage({ type: 'openLink', url: url });
      }
      e.stopPropagation();
      return;
    }
    const node = e.target.closest('.item');
    if (!node) return;
    const id = Number(node.getAttribute('data-id')) || 0;
    const pool = activeTab === 'ignored' ? (state.ignored || []) : (state.issues || []);
    const issue = pool.filter(function (i) { return i.id === id; })[0];
    const abs = node.getAttribute('data-abs');
    const line = Number(node.getAttribute('data-line')) || 0;
    const link = node.getAttribute('data-link');
    if (!abs && !link && issue && issue.zhSummary) {
      // 没有代码位置可跳转（如 CVE），点击条目展开详情
      toggleDetail(node, issue);
      return;
    }
    if (abs) {
      vscode.postMessage({ type: 'open', file: abs, line: line });
    } else if (link) {
      vscode.postMessage({ type: 'openLink', url: link });
    }
  });

  window.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'state') {
      state = event.data;
      render();
    }
  });
  setInterval(function () {
    if (!state.scanning && !state.deepFix) {
      return;
    }
    var tip = document.getElementById('cattip');
    if (tip) tip.textContent = catTipText();
  }, 1000);
  render();
</script>
</body>
</html>`;
}
