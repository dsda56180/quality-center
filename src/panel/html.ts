import { RecipeDefinition } from '../recipes';

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

/** 与 CLI/MCP 同一个状态机；面板只渲染，不另算一套进度 */
export interface SnapshotNext {
  state: string;
  title: string;
  action: string;
  command: string;
  why: string;
  progress?: string;
  plan?: {
    planId: string;
    state: string;
    appliedCount: number;
    total: number;
    nextGroup?: string;
    nextLabel?: string;
    groups: { name: string; label: string; total: number; applied: number; state: string }[];
  };
  blockers: { code: string; message: string; suggestion: string }[];
  warnings: { code: string; message: string; suggestion: string }[];
  handoffFile?: string;
}

export interface Snapshot {
  type: 'state';
  /** AI / CLI 当前运行态：由扩展读 .quality-center/run-state.json 投影，面板不自己维护 */
  run?: {
    runId: string;
    mode: string;
    phase: string;
    status: string;
    actor: { kind: string; client?: string; tool?: string };
    startedAt: string;
    updatedAt: string;
    ageSeconds: number;
    stalled: boolean;
    lastTool?: string;
    lastToolOk?: boolean;
    lastToolError?: string;
    planId?: string;
    blocked: { code: string; message: string; suggestion?: string }[];
    lastScan?: { at?: string; total: number; bySource: Record<string, number> };
    baselineTotal?: number;
    baselineAt?: string;
    build?: {
      at: string;
      ok: boolean;
      planId?: string;
      drift?: boolean;
      tests?: string;
      seconds?: number;
      gate?: string;
    };
    active: boolean;
    revision: string;
  };
  scanning: boolean;
  /** 插件口径的最终验收（由 quality_finalize 写 final-report.json，面板只读） */
  final?: {
    baselineTotal: number;
    currentTotal: number;
    baselineAt: string;
    currentAt: string;
    added: number;
    removed: number;
    totalChange: number;
    planId?: string;
    planApplied?: number;
    planTotal?: number;
    buildOk?: boolean;
    tests?: string;
    reportFile?: string;
  };
  /** 唯一状态机：现在到哪、下一步只做什么 */
  next?: SnapshotNext;
  deepFix?: { stage: string; startedAt: number; total?: number; done?: number } | null;
  /** 安装外部工具 / 构建 jar 等长任务的实时进度 */
  task?: { label: string; stage: string; startedAt: number } | null;
  scanStartedAt?: number | null;
  scanProgress?: { done: number; total: number; active: string[] };
  paused?: boolean;
  finishedAt: number | null;
  issues: SnapshotIssue[];
  ignored: SnapshotIssue[];
  suggestions: SnapshotSuggestion[];
  errors: { source: string; message: string }[];
  skipped: { source: string; reason: string; tool?: string }[];
  missingTools?: string[];
  agentFile?: string;
  buildHint?: string;
  upgradeEnabled?: boolean;
  scanOptions?: {
    checkstyle: boolean;
    gitleaks: boolean;
    trivy: boolean;
    spotbugs: boolean;
    qcsec: boolean;
    astgrep: boolean;
    scanOnSave: boolean;
    /** 手动启用的深度修复配方 */
    recipes: string[];
    /** 自动启用低风险配方 */
    autoRecipes: boolean;
    /** 显示 discover 列表中的全部配方 */
    showAllRecipes?: boolean;
  };
  /** 内置配方库：由前端按项目画像过滤后渲染 */
  recipeLibrary?: RecipeDefinition[];
  /** discover 是否正在后台加载 */
  recipesDiscovering?: boolean;
  /** 项目画像，用于决定哪些配方适用 */
  projectProfile?: {
    javaVersion?: number;
    springBootVersion?: string;
    junit?: 'junit4' | 'junit5';
  };
  /** MCP 接入状态：配置 + 本地服务自检 */
  mcp?: {
    state: 'checking' | 'missing' | 'configured' | 'ready' | 'broken';
    label: string;
    detail: string;
    configFile?: string;
    editor?: string;
    tools?: number;
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
  html, body { height: 100%; }
  body {
    margin: 0; padding: 10px;
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  .head { flex: 0 0 auto; }
  #list { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; }
  .toolbar { display: flex; gap: 4px; margin-bottom: 8px; flex-wrap: wrap; align-items: center; }
  .toolbar .spacer { flex: 1 1 auto; }
  .mcpbar {
    display: none; align-items: center; gap: 5px; margin: 0 0 6px; padding: 4px 6px;
    border: 1px solid var(--vscode-panel-border); border-radius: 3px;
    font-size: 11px; line-height: 1.35; color: var(--vscode-descriptionForeground);
  }
  .mcpbar .mcp-dot {
    flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%;
    background: #8a8a8a;
  }
  .mcpbar.ready .mcp-dot,
  #mcpbtn.ready .mcp-dot { background: #2ea043; }
  .mcpbar.configured .mcp-dot,
  #mcpbtn.configured .mcp-dot { background: #d29922; }
  .mcpbar.broken .mcp-dot,
  #mcpbtn.broken .mcp-dot { background: #f85149; }
  .mcpbar.checking .mcp-dot,
  #mcpbtn.checking .mcp-dot { background: #58a6ff; }
  #mcpbtn.missing .mcp-dot { background: #8a8a8a; }
  .mcp-status-btn {
    flex: 0 0 auto; height: 23px; padding: 0 7px; display: inline-flex; align-items: center; gap: 4px;
    font-size: 10px; font-weight: 600; letter-spacing: .02em; border-radius: 10px;
    border: 1px solid var(--vscode-panel-border); background: transparent;
    color: var(--vscode-descriptionForeground);
  }
  .mcp-status-btn.ready { color: #2ea043; border-color: #2ea043; background: rgba(46,160,67,.12); }
  .mcp-status-btn.configured { color: #d29922; border-color: #d29922; background: rgba(210,153,34,.12); }
  .mcp-status-btn.broken { color: #f85149; border-color: #f85149; background: rgba(248,81,73,.12); }
  .mcp-status-btn.checking { color: #58a6ff; border-color: #58a6ff; background: rgba(88,166,255,.12); }
  .mcp-status-btn.missing { color: #9a9a9a; border-color: #9a9a9a; }
  .mcp-status-btn .mcp-dot { width: 7px; height: 7px; }
  .mcp-status-btn:hover { filter: brightness(1.15); }
  .mcpbar .mcp-text { flex: 1 1 auto; min-width: 0; cursor: default; }
  .mcpbar .mcp-label { color: var(--vscode-foreground); }
  .mcpbar button { flex: 0 0 auto; padding: 2px 6px; font-size: 10px; }
  .icon-btn {
    flex: 0 0 auto; width: 28px; height: 26px; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .icon-btn svg { display: block; }
  button {
    flex: 1 1 auto;
    padding: 5px 8px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    cursor: pointer;
    font-size: 12px;
    transition: background-color .12s ease, border-color .12s ease, transform .06s ease;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:active { transform: translateY(1px); filter: brightness(.92); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007acc); outline-offset: 1px; }
  button:disabled { opacity: .45; cursor: default; filter: none; transform: none; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border-color: var(--vscode-panel-border);
  }
  button.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground, rgba(90, 93, 94, .45));
    border-color: var(--vscode-focusBorder, #007acc);
  }
  button.preset-on {
    background: var(--vscode-button-background) !important;
    color: var(--vscode-button-foreground) !important;
    border-color: var(--vscode-focusBorder, #007acc) !important;
  }
  .summary {
    display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
    padding: 8px; margin-bottom: 10px;
    border-radius: 4px;
    background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.1));
  }
  /* AI 执行时用状态卡替换所有写操作入口，避免“面板按钮”和“AI 动作”同时可点 */
  body.ai-busy .toolbar button:not(.mcp-status-btn),
  body.ai-busy #fixbar,
  body.ai-busy #buildbar,
  body.ai-busy #wizard,
  body.ai-busy .item .actions,
  body.ai-busy .d-actions,
  body.ai-busy .sug-actions,
  body.ai-busy .tool-link,
  body.ai-busy .ai-link,
  body.ai-busy #mcpcheck,
  body.ai-busy #mcpsetup { display: none !important; }
  .aistatus { display: none; margin: 0 0 10px; padding: 8px 10px; border-radius: 4px;
    border: 1px solid var(--vscode-panel-border); background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.1)); }
  .aistatus.on { display: block; }
  .aistatus.blocked { border-color: var(--vscode-errorForeground, #f48771); }
  .ai-head { display: flex; align-items: center; gap: 6px; font-weight: 600; }
  .ai-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-progressBar-background, #3794ff); animation: aiPulse 1.1s ease-in-out infinite; }
  .aistatus.blocked .ai-dot { background: var(--vscode-errorForeground, #f48771); animation: none; }
  .ai-meta { margin-top: 4px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .ai-steps { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 7px; }
  .ai-step { padding: 2px 6px; border-radius: 8px; font-size: 10px; color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border); }
  .ai-step.current { color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c); border-color: transparent; }
  .ai-step.done { opacity: .65; }
  .ai-warn { margin-top: 6px; font-size: 11px; color: var(--vscode-editorWarning-foreground, #cca700); }
  .ai-block { margin-top: 4px; font-size: 11px; color: var(--vscode-errorForeground, #f48771); }
  @keyframes aiPulse { 0%,100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1.15); } }
  .catbar { display: none; margin: 0 0 10px; }
  .catbar.on { display: block; }
  .cat-stage { position: relative; height: 40px; overflow: hidden; }
  .cat-track {
    position: absolute; left: 0; right: 0; bottom: 3px; height: 11px;
    border-radius: 11px; overflow: hidden;
    background: var(--vscode-input-background, rgba(128,128,128,.15));
    border: 1px solid var(--vscode-panel-border);
  }
  .cat-fill {
    position: absolute; top: 0; bottom: 0; left: 0; width: 34%;
    border-radius: 11px; overflow: hidden;
    transition: width .35s ease;
    background: var(--vscode-progressBar-background, #3794ff);
  }
  .cat-fill::after {
    content: ''; position: absolute; top: 0; bottom: 0; width: 45%;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,.5), transparent);
    animation: catShimmer 1.6s linear infinite;
  }
  .cat-runner {
    position: absolute; left: -60px; bottom: 14px; height: 24px;
    display: flex; gap: 6px; align-items: flex-end;
    pointer-events: none;
  }
  .cat-runner .cat {
    display: inline-block;
    width: 24px; height: 24px;
    transform-origin: 50% 90%;
    animation: catJump 1s ease-in-out infinite alternate;
    transition: opacity .28s ease, transform .28s ease;
  }
  .cat-runner .cat svg { display: block; width: 100%; height: 100%; }
  .cat-runner .cat.gone {
    opacity: 0;
    transform: translateY(-8px) scale(.45);
    animation: none;
  }
  .cat-stage.paused .cat,
  .cat-stage.paused .cat-runner { animation-play-state: paused; }
  .cat-tip {
    display: block; margin-top: 2px;
    font-size: 10px; color: var(--vscode-descriptionForeground);
  }
  .cat-tip::after { content: ''; animation: catDots 1.4s steps(4, end) infinite; }
  @keyframes catJump {
    0% { transform: translate(0, 0) rotate(-5deg); }
    50% { transform: translate(3px, -6px) rotate(0deg); }
    100% { transform: translate(0, 0) rotate(5deg); }
  }
  @keyframes catShimmer {
    from { left: -45%; }
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
    display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 2px; margin-bottom: 8px; padding-bottom: 2px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .tab {
    padding: 4px 2px; font-size: 11px; min-width: 0;
    background: transparent; color: var(--vscode-descriptionForeground);
    border: none; border-bottom: 2px solid transparent; border-radius: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
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
    display: flex; align-items: center; gap: 4px;
    cursor: pointer; user-select: none;
  }
  .group-title:hover { color: var(--vscode-foreground); }
  .group-title .chev { display: inline-block; transition: transform .12s ease; font-size: 10px; }
  .group.collapsed .chev { transform: rotate(-90deg); }
  .group.collapsed .item { display: none; }
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
  .msgbar { display: none; margin: 0 0 8px; font-size: 11px; line-height: 1.5; }
  .msgbar.on { display: block; }
  .msgline {
    display: flex; gap: 6px; align-items: flex-start; margin-bottom: 4px; padding: 5px 7px;
    border-radius: 3px; border-left: 3px solid var(--vscode-panel-border);
    background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.08));
  }
  .msgline.info { border-left-color: #58a6ff; }
  .msgline.ok { border-left-color: #2ea043; }
  .msgline.warn { border-left-color: #d29922; }
  .msgline.error { border-left-color: #f85149; }
  .msgline .msg-text { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; word-break: break-word; }
  .msgline .msg-sub { color: var(--vscode-descriptionForeground); }
  .msgline .msg-actions { flex: 0 0 auto; display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
  .msg-action {
    padding: 1px 6px; font-size: 10px; border-radius: 3px;
    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-textLink-foreground));
    cursor: pointer;
  }
  .msg-action:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.18)); }
  .msgbar .tool-link {
    margin-left: 4px; color: var(--vscode-textLink-foreground);
    text-decoration: underline; cursor: pointer;
  }
  .msgbar .tool-link:hover { color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); }
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
  .copy-sug, .plan-upgrade {
    flex: none; padding: 1px 6px; font-size: 10px;
    background: transparent; color: var(--vscode-textLink-foreground);
    border: 1px solid var(--vscode-panel-border); border-radius: 3px;
  }
  .copy-sug:hover { background: var(--vscode-list-hoverBackground); }
  .wizard {
    margin-top: 8px; padding: 8px 10px; border-radius: 4px;
    background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.08));
    border: 1px solid var(--vscode-panel-border);
    border-left: 3px solid var(--vscode-focusBorder, #007acc);
  }
  .wz-title { font-weight: 600; line-height: 1.45; }
  .wz-meta { margin-top: 3px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .wz-purpose { margin-top: 4px; font-size: 11px; line-height: 1.5; color: var(--vscode-foreground); opacity: .9; }
  .wz-groups { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .wz-chip {
    font-size: 10px; padding: 1px 6px; border-radius: 8px;
    border: 1px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
  }
  .wz-chip.done { border-color: var(--vscode-testing-iconPassed, #3fb950); color: var(--vscode-testing-iconPassed, #3fb950); }
  .wz-chip.doing { border-color: var(--vscode-focusBorder, #007acc); color: var(--vscode-textLink-foreground); }
  .wz-note { margin-top: 5px; font-size: 10px; line-height: 1.5; color: var(--vscode-descriptionForeground); }
  .wz-note.warn { color: var(--vscode-editorWarning-foreground, #d29922); }
  .wz-note.block { color: var(--vscode-editorError-foreground, #f85149); }
  .wz-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .wz-actions button {
    flex: 0 0 auto; padding: 4px 10px; font-size: 11px; line-height: 1.4;
    min-height: 24px; cursor: pointer;
  }
  .wz-actions .wz-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
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
    width: min(420px, 94vw);
    max-height: 86vh; overflow-y: auto;
    padding: 12px;
    border-radius: 6px;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    box-shadow: 0 8px 24px rgba(0, 0, 0, .35);
  }
  .dlg-title { font-weight: 600; font-size: 13px; margin-bottom: 8px; }
  .dlg-sec {
    margin: 12px 0 4px; padding-top: 8px; font-weight: 600; font-size: 12px;
    border-top: 1px solid var(--vscode-panel-border);
  }
  .recipe-group { margin: 4px 0 6px; }
  .recipe-group-title { font-size: 10px; color: var(--vscode-descriptionForeground); margin: 4px 0 2px; }
  .recipe-row { align-items: flex-start; flex-wrap: wrap; }
  .recipe-row .recipe-name { flex: 0 0 auto; }
  .recipe-row .recipe-desc {
    flex: 1 1 100%; padding-left: 20px;
    font-size: 10px; line-height: 1.4; color: var(--vscode-descriptionForeground);
  }
  .recipe-row input:disabled + .recipe-name { opacity: .75; }
  .dlg-presets { display: flex; gap: 6px; margin-bottom: 8px; }
  .dlg-row {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 0; font-size: 12px; cursor: pointer;
  }
  .dlg-row input { accent-color: var(--vscode-button-background); }
  .dlg-hint { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 8px 0 4px; line-height: 1.5; }
  .dlg-input {
    width: 100%; margin: 6px 0 2px; padding: 3px 6px; font-size: 11px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px;
  }
  .recipe-src {
    margin-left: 6px; padding: 0 5px; border-radius: 8px; font-size: 9px;
    background: rgba(128,128,128,.2); color: var(--vscode-descriptionForeground);
  }
  .dlg-actions { display: flex; gap: 6px; margin-top: 10px; }
</style>
</head>
<body>
  <div class="head">
  <div class="toolbar">
    <button id="scan" class="icon-btn" title="开始扫描"><svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor"><path d="M4 2l8 5-8 5z"/></svg></button>
    <button id="resume" class="icon-btn" title="继续扫描" style="display:none"><svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor"><path d="M4 2l8 5-8 5z"/></svg></button>
    <button id="pause" class="icon-btn secondary" title="暂停扫描：当前扫描器结束后不再启动新的扫描器" style="display:none"><svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor"><path d="M3 2h3v10H3zM8 2h3v10H8z"/></svg></button>
    <button id="stop" class="icon-btn secondary" title="终止扫描" style="display:none"><svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor"><path d="M3 3h8v8H3z"/></svg></button>
    <button id="mcpbtn" class="mcp-status-btn checking" title="MCP 检测中"><span class="mcp-dot"></span>MCP</button>
    <span class="spacer"></span>
    <button id="deepfix" class="icon-btn secondary" title="深度修复"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg></button>
    <button id="upgrade" class="icon-btn secondary" title="升级依赖"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M5 4v2h14V4H5zm0 10h4v6h6v-6h4l-7-7-7 7z"/></svg></button>
    <button id="copy" class="icon-btn secondary" title="复制给 AI"><svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor"><path d="M4 1h6l2 2v8H4zM2 4h1.5v9h7v1.5H2z"/></svg></button>
    <button id="save" class="icon-btn secondary" title="导出报告"><svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor"><path d="M6 1h2v6h2.5L7 12 3.5 7H6zM2 12.5h10V14H2z"/></svg></button>
    <button id="settings" class="icon-btn secondary" title="扫描设置"><svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor"><path d="M1 3h12v1.5H1zM1 9h12v1.5H1zM4 1.5h2v4.5H4zM8 7.5h2v4.5H8z"/></svg></button>
  </div>
  <div id="mcpbar" class="mcpbar checking">
    <span class="mcp-dot"></span>
    <span class="mcp-text" id="mcptext">
      <span class="mcp-label" id="mcplabel">检测 MCP…</span>
      <span id="mcpdetail"></span>
    </span>
    <button id="mcpcheck" class="secondary" title="重新检测 MCP 配置与服务">检测</button>
    <button id="mcpsetup" class="secondary" title="生成/修复编辑器 MCP 配置">接入</button>
  </div>
  <div id="msgbar" class="msgbar"></div>
  <div id="catbar" class="catbar">
    <div class="cat-stage">
      <div class="cat-track"><div class="cat-fill"></div></div>
      <div class="cat-runner" id="catrunner"></div>
    </div>
    <span class="cat-tip" id="cattip">猫咪正在奔跑检查代码</span>
  </div>
  <div id="aistatus" class="aistatus"></div>
  <div id="summary" class="summary"><span class="hint">尚未扫描</span></div>
  <div class="tabs" id="tabs">
    <button class="tab active" data-tab="all">全部</button>
    <button class="tab" data-tab="checkstyle">代码质量</button>
    <button class="tab" data-tab="gitleaks">密钥泄露</button>
    <button class="tab" data-tab="trivy">依赖漏洞</button>
    <button class="tab" data-tab="spotbugs">静态缺陷</button>
    <button class="tab" data-tab="qcsec">配置安全</button>
    <button class="tab" data-tab="astgrep">语义规则</button>
    <button class="tab" data-tab="ignored">已忽略</button>
    <button class="tab" data-tab="suggest">建议</button>
  </div>
  <input type="search" id="q" placeholder="搜索文件、规则或描述">
  <div id="fixbar" class="fixbar" style="display:none">
    <span id="fixtip"></span>
    <button id="fixall">一键修复</button>
  </div>
  <div id="buildbar" class="buildbar" style="display:none">
    <span id="buildtip"></span>
    <button id="build">构建并扫描</button>
  </div>
  <div id="wizard" class="wizard" style="display:none"></div>
  </div>
  <div id="list"><div class="empty">点击「▶」开始扫描</div></div>
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
      <label class="dlg-row"><input type="checkbox" id="opt-qcsec" /> 配置安全（qcsec：Druid/Actuator/CORS/明文口令/默认账号/日志与会话）</label>
      <label class="dlg-row"><input type="checkbox" id="opt-astgrep" /> 语义规则（AST：敏感路径/注入/SSTI/反序列化/XXE 等 27 条）</label>
      <label class="dlg-row"><input type="checkbox" id="opt-scansave" /> 保存文件后自动扫描</label>
      <div class="dlg-hint">快速模式关闭 SpotBugs，约 15 秒；完整模式约 35 秒。保存后下次扫描生效。</div>
      <div class="dlg-sec">深度修复配方</div>
      <label class="dlg-row"><input type="checkbox" id="opt-autorecipes" /> 自动启用低风险配方（推荐）</label>
      <label class="dlg-row"><input type="checkbox" id="opt-allrecipes" /> 显示全部可用配方（discover，首次加载约 10 秒）</label>
      <div class="dlg-hint">配方库由插件内置并按当前项目过滤，无需填写 Maven 坐标；低风险配方只做等价改写。开启全部配方后，新增配方无需升级插件。</div>
      <div class="dlg-hint" id="recipe-profile"></div>
      <input id="recipe-filter" class="dlg-input" type="search" placeholder="筛选配方（中文名或 id）" />
      <div id="recipe-groups"></div>
      <div class="dlg-actions">
        <button id="set-cancel" class="secondary">取消</button>
        <button id="set-apply">保存</button>
      </div>
    </div>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const SRC_LABEL = {
    checkstyle: '代码质量',
    gitleaks: '密钥泄露',
    trivy: '依赖漏洞',
    spotbugs: '静态缺陷',
    qcsec: '配置安全',
    astgrep: '语义规则'
  };
  const CAT_LABEL = {
    SECURITY: '安全漏洞',
    CORRECTNESS: '逻辑正确性',
    MALICIOUS_CODE: '可变对象暴露',
    BAD_PRACTICE: '不良实践',
    PERFORMANCE: '性能问题',
    STYLE: '可疑代码',
    I18N: '国际化'
  };
  const SUG_LABEL = { framework: '框架', dependency: '依赖', secret: '密钥', manual: '人工' };
  const SEV_LABEL = { critical: '严重', high: '高危', medium: '中危', low: '低危', info: '提示' };
  const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
  let state = { run: null, scanning: false, paused: false, deepFix: null, task: null, scanStartedAt: null, scanProgress: { done: 0, total: 0, active: [] }, finishedAt: null, issues: [], ignored: [], suggestions: [], errors: [], skipped: [], upgradeEnabled: true, scanOptions: { checkstyle: true, gitleaks: true, trivy: true, spotbugs: true, qcsec: true, astgrep: true, scanOnSave: true, recipes: [], autoRecipes: true, showAllRecipes: false }, recipeLibrary: [], recipesDiscovering: false, projectProfile: {} };
  let activeTab = 'all';
  /** 各来源分组的折叠状态，跨渲染保留 */
  let collapsed = {};
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
        : (key === 'ignored' ? '已忽略' : (key === 'suggest' ? '修复建议' : (SRC_LABEL[key] || key)));
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
      var total = state.deepFix.total || 0;
      var step = total ? '（第 ' + Math.min((state.deepFix.done || 0) + 1, total) + '/' + total + ' 步）' : '';
      return '猫咪正在' + state.deepFix.stage + step + ' · 已用 ' + sec + ' 秒';
    }
    if (state.scanning) {
      var progress = scanProgressText();
      var label = state.paused ? '猫咪暂停中，等待当前扫描器结束' : '猫咪正在奔跑检查代码';
      return label + (progress ? '（' + progress + '）' : '');
    }
    return '猫咪正在准备扫描';
  }

  // 每只猫对应一个待执行项目：用内联 SVG 画出不同品种，避免 emoji 风格不统一
  var CAT_BREEDS = [
    { name: '橘猫', base: '#f0a04b', ear: '#dd8a37', eye: '#4a3726', pattern: 'tabby', stripe: '#c97a2b' },
    { name: '狸花猫', base: '#9a8f7d', ear: '#847966', eye: '#2f2a22', pattern: 'tabby', stripe: '#6f6555' },
    { name: '奶牛猫', base: '#f8f8f8', ear: '#3a3a40', eye: '#2c6e49', pattern: 'tuxedo' },
    { name: '黑猫', base: '#43434d', ear: '#3a3a43', eye: '#e8c547', pattern: 'plain' },
    { name: '白猫', base: '#fbfbfb', ear: '#f0dcdc', eye: '#5aa9e6', pattern: 'plain' },
    { name: '三花猫', base: '#fbfbfb', ear: '#dd8a37', eye: '#4a3b2a', pattern: 'calico' },
    { name: '暹罗猫', base: '#f3e7d3', ear: '#5c4a42', eye: '#4b8fd1', pattern: 'siamese' },
    { name: '蓝猫', base: '#8e9aa8', ear: '#7d8896', eye: '#c98b3a', pattern: 'plain' },
    { name: '银渐层', base: '#d9dde3', ear: '#c3c8d0', eye: '#6fb3a8', pattern: 'tabby', stripe: '#aeb4be' },
    { name: '玳瑁猫', base: '#4a3f3a', ear: '#3d332f', eye: '#d9a441', pattern: 'tortie' }
  ];
  function catSvg(index) {
    var breed = CAT_BREEDS[index % CAT_BREEDS.length];
    var clip = 'catclip' + index;
    var pattern = '';
    if (breed.pattern === 'tabby') {
      pattern = '<path d="M9 5.6v3.2M12 5.2v3.6M15 5.6v3.2" stroke="' + breed.stripe + '" stroke-width="1.1" stroke-linecap="round"/>'
        + '<path d="M4.2 13.2h2.3M4.6 15.8h2.1M19.8 13.2h-2.3M19.4 15.8h-2.1" stroke="' + breed.stripe + '" stroke-width=".9" stroke-linecap="round"/>';
    } else if (breed.pattern === 'tuxedo') {
      pattern = '<path d="M3.9 13.2a8.1 8.1 0 0 1 16.2 0z" fill="#34343c"/>';
    } else if (breed.pattern === 'calico') {
      pattern = '<circle cx="16.8" cy="8.2" r="3.3" fill="#e8933c"/><circle cx="7.2" cy="17" r="2.4" fill="#2f2f36"/>';
    } else if (breed.pattern === 'siamese') {
      pattern = '<ellipse cx="12" cy="14.8" rx="3.7" ry="2.7" fill="#6b574e"/>';
    } else if (breed.pattern === 'tortie') {
      pattern = '<circle cx="7.4" cy="8.6" r="2.2" fill="#b5642f"/><circle cx="16.4" cy="16.4" r="2.2" fill="#8a5230"/>';
    }
    return '<span class="cat" style="animation-delay:' + (index * 0.12).toFixed(2) + 's;">'
      + '<svg viewBox="0 0 24 24" width="22" height="22" role="img" aria-label="' + breed.name + '">'
      + '<title>' + breed.name + '</title>'
      + '<defs><clipPath id="' + clip + '"><rect x="4" y="5" width="16" height="16" rx="4.5"/></clipPath></defs>'
      + '<path d="M4.1 8.4 4.6 2.2 9.8 5.2Z" fill="' + breed.ear + '"/>'
      + '<path d="M19.9 8.4 19.4 2.2 14.2 5.2Z" fill="' + breed.ear + '"/>'
      + '<path d="M6 6.7 6.4 4.1 8.4 5.7Z" fill="#efb3c0"/>'
      + '<path d="M18 6.7 17.6 4.1 15.6 5.7Z" fill="#efb3c0"/>'
      + '<rect x="4" y="5" width="16" height="16" rx="4.5" fill="' + breed.base + '"/>'
      + '<g clip-path="url(#' + clip + ')">' + pattern + '</g>'
      + '<ellipse cx="9.05" cy="12.2" rx="1.5" ry="1.9" fill="' + breed.eye + '"/>'
      + '<ellipse cx="14.95" cy="12.2" rx="1.5" ry="1.9" fill="' + breed.eye + '"/>'
      + '<ellipse cx="9.05" cy="12.1" rx=".55" ry="1" fill="#16161a"/>'
      + '<ellipse cx="14.95" cy="12.1" rx=".55" ry="1" fill="#16161a"/>'
      + '<circle cx="8.82" cy="11.5" r=".42" fill="#fff" opacity=".9"/>'
      + '<circle cx="14.72" cy="11.5" r=".42" fill="#fff" opacity=".9"/>'
      + '<path d="M12 14.9 10.85 14.05h2.3Z" fill="#e2788c"/>'
      + '<path d="M12 15.1v1.05M12 16.15q-1.1.95-2.05.05M12 16.15q1.1.95 2.05.05" stroke="#6d4c4c" stroke-width=".55" fill="none" stroke-linecap="round"/>'
      + '</svg></span>';
  }
  // 用 requestAnimationFrame 驱动奔跑：跑到右端后瞬时回到左侧，
  // 避免关键帧插值把猫咪可见地"拉回"左边
  var catRunRaf = 0;
  var catRunLeft = -60;
  function startCatRun() {
    cancelAnimationFrame(catRunRaf);
    catRunLeft = -60;
    var runner = document.getElementById('catrunner');
    var stageEl = document.querySelector('.cat-stage');
    runner.style.left = catRunLeft + 'px';
    var last = 0;
    function tick(now) {
      if (!last) {
        last = now;
      }
      var delta = Math.min(64, now - last);
      last = now;
      if (!state.paused) {
        catRunLeft += delta * 0.09;
        if (catRunLeft > stageEl.clientWidth) {
          catRunLeft = -60;
        }
        runner.style.left = catRunLeft + 'px';
      }
      catRunRaf = requestAnimationFrame(tick);
    }
    catRunRaf = requestAnimationFrame(tick);
  }
  function stopCatRun() {
    if (catRunRaf) {
      cancelAnimationFrame(catRunRaf);
      catRunRaf = 0;
    }
  }

  // 任务结束时让剩余猫咪逐只淡出，而不是整条进度条瞬间消失
  var catHideTimer = null;
  var catDoneTimer = null;
  var catbarVisible = false;
  function dismissCats() {
    if (catHideTimer) {
      return;
    }
    var runner = document.getElementById('catrunner');
    var bar = document.getElementById('catbar');
    var cats = Array.from(runner.children);
    if (!cats.length) {
      bar.classList.remove('on');
      catbarVisible = false;
      return;
    }
    cats.forEach(function (cat, index) {
      cat.style.transitionDelay = (index * 0.1).toFixed(2) + 's';
      cat.classList.add('gone');
    });
    catHideTimer = setTimeout(function () {
      Array.from(runner.children).forEach(function (cat) { cat.style.transitionDelay = ''; });
      runner.innerHTML = '';
      bar.classList.remove('on');
      catbarVisible = false;
      catHideTimer = null;
      stopCatRun();
    }, 340 + cats.length * 100);
  }

  function renderCats(total, done) {
    var runner = document.getElementById('catrunner');
    if (!runner) {
      return;
    }
    // 扫描器数量即项目数；深度修复没有分项时保留一只猫
    var target = total > 0 ? Math.min(total, CAT_BREEDS.length) : 1;
    if (runner.children.length !== target) {
      var html = '';
      for (var index = 0; index < target; index += 1) {
        html += catSvg(index);
      }
      runner.innerHTML = html;
    }
    var remaining = total > 0
      ? Math.max(0, Math.round(target * (1 - Math.min(done, total) / total)))
      : target;
    Array.from(runner.children).forEach(function (cat, index) {
      cat.style.transitionDelay = '';
      cat.classList.toggle('gone', index >= remaining);
    });
  }

  var AI_PHASES = [
    ['baseline_build', '基线构建'],
    ['baseline_scan', '基线扫描'],
    ['fix', '确定性修复'],
    ['plan', '依赖计划'],
    ['apply', '依赖落盘'],
    ['static_fix', '静态修复'],
    ['rescan', '复扫'],
    ['finalize', '收尾']
  ];

  function uiPhaseForTool(tool, run) {
    if (!tool) return run.phase;
    if (tool === 'quality_build') return run.baselineTotal === undefined ? 'baseline_build' : (run.planId ? 'apply' : 'static_fix');
    if (tool === 'quality_scan') return run.baselineTotal === undefined ? 'baseline_scan' : 'rescan';
    if (tool === 'quality_fix' || tool === 'cli:fix') return 'fix';
    if (tool === 'quality_upgrade_plan') return 'plan';
    if (tool === 'quality_upgrade_apply' || tool === 'quality_upgrade_check' || tool === 'quality_upgrade_revert') return 'apply';
    if (tool === 'quality_finalize') return 'finalize';
    if (tool === 'quality_agent_brief') return 'baseline_build';
    return run.phase;
  }

  /** AI 运行态只读投影：执行中隐藏所有人工操作，只展示 AI 当前阶段 */
  function renderAiStatus() {
    var el = document.getElementById('aistatus');
    if (!el) return;
    var run = state.run;
    var actor = (run && run.actor) || {};
    var age = run && run.updatedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(run.updatedAt)) / 1000)) : 0;
    var working = !!(run && run.status === 'running' && age < 1800);
    var blocked = !!(run && run.status === 'blocked');
    var confirm = !!(run && run.status === 'needs_confirm');
    var done = !!(run && run.status === 'done' && actor.kind === 'mcp' && age < 600);
    if (!run || (!working && !blocked && !confirm && !done)) {
      el.className = 'aistatus';
      el.innerHTML = '';
      return;
    }
    // CLI 临时命令曾把 phase 标成 done；面板按最近工具恢复可读阶段，不让所有阶段一起变灰
    var phase = run.phase === 'done' && (working || blocked || confirm)
      ? uiPhaseForTool(run.lastTool, run)
      : run.phase;
    var phaseLabel = ({
      baseline_build: '基线构建', baseline_scan: '基线扫描', fix: '确定性修复', plan: '依赖计划',
      apply: '依赖落盘', static_fix: '静态修复', rescan: '复扫', finalize: '收尾',
      done: '已完成', blocked: '已阻塞', needs_confirm: '待确认', paused: '已暂停', idle: '空闲'
    })[phase] || phase || '执行中';
    var who = actor.kind === 'mcp' ? 'AI（' + (actor.client || 'MCP') + '）' : actor.kind === 'cli' ? 'CLI' : '外部';
    var title = blocked ? '⛔ AI 已阻塞' : confirm ? '⏸ 等待你确认' : done ? '✅ AI 已完成' : '🤖 ' + who + '正在执行';
    var current = AI_PHASES.findIndex(function (p) { return p[0] === phase; });
    var steps = AI_PHASES.map(function (p, i) {
      var cls = 'ai-step';
      if (done || (current >= 0 && i < current)) cls += ' done';
      if (!done && i === current) cls += ' current';
      return '<span class="' + cls + '">' + p[1] + '</span>';
    }).join('');
    var meta = phaseLabel + ' · ' + age + ' 秒前更新';
    if (run.phase === 'done' && working) meta += ' · 阶段未更新';
    if (run.lastTool) meta += ' · 最近工具 ' + esc(run.lastTool);
    var warnings = '';
    if (run.stalled && working) warnings += '<div class="ai-warn">⚠ 已较长时间没有工具活动，AI 可能卡住。</div>';
    if (run.lastToolError) warnings += '<div class="ai-warn">⚠ 最近一次工具失败：' + esc(shortError(run.lastToolError)) + '</div>';
    (run.blocked || []).slice(0, 3).forEach(function (b) {
      warnings += '<div class="ai-block">⛔ ' + esc(b.message) + (b.suggestion ? '（' + esc(b.suggestion) + '）' : '') + '</div>';
    });
    if (run.build && run.build.tests === 'skipped') warnings += '<div class="ai-warn">⚠ 最近构建跳过了测试：构建成功不等于测试通过。</div>';
    if (run.build && run.build.drift) warnings += '<div class="ai-block">⛔ 构建发现 pom 已偏离活动计划，结果不可作为验收证据。</div>';
    if (done) {
      var last = run.lastScan;
      var final = state.final;
      if (final) {
        warnings += '<div class="ai-meta">最终验收：' + final.baselineTotal + ' → ' + final.currentTotal +
          ' 项（' + (final.totalChange >= 0 ? '+' : '') + final.totalChange +
          '，新增 ' + final.added + ' / 消失 ' + final.removed + '）' +
          (final.planId ? ' · 计划 ' + final.planApplied + '/' + final.planTotal : '') + '</div>';
      } else if (last && last.total >= 0) {
        warnings += '<div class="ai-meta">复扫结果：' + last.total + ' 项' +
          (run.baselineTotal !== undefined ? ' · 基线 ' + run.baselineTotal + ' 项' : '') + '</div>';
      } else {
        warnings += '<div class="ai-block">⛔ AI 已结束，但没有可用的复扫结果；面板将自动补一次扫描。</div>';
      }
    }
    el.className = 'aistatus on' + (blocked ? ' blocked' : '');
    el.innerHTML =
      '<div class="ai-head"><span class="ai-dot"></span>' + esc(title) + '</div>' +
      '<div class="ai-meta">' + esc(meta) + '</div>' +
      ((working || blocked || confirm) ? '<div class="ai-steps">' + steps + '</div>' : '') +
      warnings;
  }

  function shortError(text) {
    var value = String(text || '');
    return value.length > 260 ? value.slice(0, 260) + '…' : value;
  }

  /** 顶部消息栏：只放用户需要知悉或需要操作的事情，按严重度着色并带动作 */
  function renderMessages() {
    var bar = document.getElementById('msgbar');
    if (!bar) return;
    var items = [];
    function action(label, type, title) {
      return '<button class="msg-action" data-msg="' + type + '" title="' + esc(title || label) + '">' + label + '</button>';
    }
    function add(level, text, actions) {
      items.push(
        '<div class="msgline ' + level + '">' +
        '<span class="msg-text">' + text + '</span>' +
        (actions ? '<span class="msg-actions">' + actions + '</span>' : '') +
        '</div>'
      );
    }

    var mcp = state.mcp || { state: 'checking', label: '检测 MCP…', detail: '' };
    if (mcp.state === 'checking') {
      add('info', '⏳ 正在检测 MCP 配置与服务…');
    } else if (mcp.state === 'ready') {
      add('ok', '🟢 ' + esc(mcp.label) + (mcp.tools ? ' · ' + mcp.tools + ' 个工具' : ''),
        action('重新检测', 'checkMcp', '重新做一次 MCP 协议自检'));
    } else if (mcp.state === 'configured') {
      add('warn',
        '🟡 ' + esc(mcp.label) + '：' + esc(mcp.detail),
        action('重新检测', 'checkMcp', 'Trae 已启用项目级 MCP 后，重新检测是否握手成功') +
        action('查看配置', 'openMcpConfig', '打开项目 MCP 配置文件'));
    } else if (mcp.state === 'broken') {
      add('error',
        '🔴 ' + esc(mcp.label) + '：' + esc(mcp.detail),
        action('修复配置', 'setupMcp', '重新生成可用的项目 MCP 配置') +
        (mcp.configFile ? action('查看配置', 'openMcpConfig', '打开项目 MCP 配置文件') : ''));
    } else {
      add('error',
        '⚪ ' + esc(mcp.label) + (mcp.detail ? '：' + esc(mcp.detail) : ''),
        action('一键接入', 'setupMcp', '生成项目 MCP 配置'));
    }

    if (state.run && state.run.lastToolError && state.run.status !== 'done') {
      add('warn', '⚠ AI 最近一次工具失败：' + esc(shortError(state.run.lastToolError)));
    }
    if (state.task) {
      var sec = Math.max(0, Math.floor((Date.now() - state.task.startedAt) / 1000));
      add('info', '⏳ ' + esc(state.task.label) + '：' + esc(state.task.stage) + ' · 已用 ' + sec + ' 秒');
    }
    if (state.final) {
      var f = state.final;
      add('info', '🧾 最终验收：' + f.baselineTotal + ' → ' + f.currentTotal + ' 项（' +
        (f.totalChange >= 0 ? '+' : '') + f.totalChange + '，新增 ' + f.added + ' / 消失 ' + f.removed + '）' +
        (f.planId ? ' · 计划 ' + (f.planApplied ?? 0) + '/' + (f.planTotal ?? 0) : '') +
        (f.tests === 'skipped' ? ' · ⚠ 构建跳过测试' : ''));
    }
    (state.errors || []).forEach(function (e) {
      add('warn', '⚠ ' + (SRC_LABEL[e.source] || e.source) + ' 扫描异常：' + esc(e.message));
    });
    (state.skipped || []).forEach(function (s) {
      var install = s.tool
        ? ' <a class="tool-link" data-install="' + esc(s.tool) + '">安装</a>'
        : '';
      add('info', '· 已跳过 ' + (SRC_LABEL[s.source] || s.source) + '：' + esc(s.reason) + install);
    });

    bar.innerHTML = items.join('');
    bar.className = 'msgbar' + (items.length ? ' on' : '');
  }

  function renderWizard() {
    var el = document.getElementById('wizard');
    if (!el) return;
    var n = state.next;
    if (!n) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    el.style.display = 'block';
    var groups = '';
    if (n.plan && n.plan.groups) {
      groups = '<div class="wz-groups">' + n.plan.groups.map(function (g) {
        return '<span class="wz-chip ' + esc(g.state) + '">' + esc(g.label) + ' ' + g.applied + '/' + g.total + '</span>';
      }).join('') + '</div>';
    }
    var notes = '';
    (n.blockers || []).slice(0, 2).forEach(function (b) {
      notes += '<div class="wz-note block">阻塞：' + esc(b.message) + '</div>';
    });
    (n.warnings || []).slice(0, 2).forEach(function (w) {
      notes += '<div class="wz-note warn">注意：' + esc(w.message) + '</div>';
    });
    var label = n.plan && n.plan.nextLabel ? n.plan.nextLabel : '当前组';
    var title = n.title;
    if ((n.action === 'apply' || n.action === 'confirm') && n.plan) {
      title = n.plan.state === 'partial' ? '升级建议执行中' : '升级建议已生成';
      if (state.final) {
        title = n.plan.state === 'partial' ? '本次 AI 修复已收尾 · 剩余组需人工确认' : '本次 AI 修复已收尾';
      }
    }
    var purpose = '';
    if (n.action === 'apply' || n.action === 'confirm') {
      var issueCount = (state.issues || []).length;
      purpose =
        '根据' + (issueCount ? ' ' + issueCount + ' 项' : '') +
        '扫描结果给出的升级建议，按风险分组。' +
        (n.action === 'confirm'
          ? '这一组含跨大版本，执行前需要你确认。'
          : '你可以直接执行，或复制给 AI 驱动整个流程。');
      if (state.final) {
        purpose = '本次 AI 修复已生成最终验收（' + state.final.baselineTotal + ' → ' + state.final.currentTotal +
          ' 项）。剩下的组需要你确认后才进入下一轮，不代表 AI 还在执行。';
      }
    } else if (n.action === 'plan') {
      purpose = '根据扫描结果生成升级计划，先看分组和版本，不会直接改 pom。';
    } else if (n.action === 'build') {
      purpose = '升级已写入，跑构建门禁确认没有破坏现有功能。';
    } else if (n.action === 'explain') {
      purpose = '上一组已写入但构建没有通过，先看原因；必要时回滚到计划前。';
    } else if (n.action === 'rescan') {
      purpose = '构建已通过，复扫确认目标漏洞是否真的消除。';
    } else if (n.action === 'scan') {
      purpose = '先扫描项目，插件会根据结果给出升级建议。';
    } else if (n.action === 'none') {
      purpose = '升级与验证已完成，剩余项按报告人工评估。';
    }
    function btn(key, text, primary) {
      return '<button class="' + (primary ? 'wz-primary' : 'secondary') + '" data-wz="' + key + '">' + esc(text) + '</button>';
    }
    var actions = '';
    switch (n.action) {
      case 'scan':
        actions = btn('scan', '开始扫描', true);
        break;
      case 'plan':
        actions = btn('createPlan', '生成升级计划', true);
        break;
      case 'apply':
        actions = btn('upgradeNext', '执行「' + label + '」', true);
        break;
      case 'confirm':
        actions = btn('upgradeNext', '确认并执行「' + label + '」', true);
        break;
      case 'build':
        actions = btn('buildGate', '跑构建门禁', true);
        break;
      case 'explain':
        actions = btn('explainBuild', '查看失败原因', true) + btn('revertPlan', '回滚到计划前');
        break;
      case 'rescan':
        actions = btn('scan', '复扫验收', true);
        break;
      case 'install':
        actions = btn('install-mvn', '安装 Maven', true);
        break;
      case 'revert':
        actions = btn('revertPlan', '回滚到计划前', true);
        break;
      default:
        actions = btn('openHandoff', '打开交接');
    }
    if (['apply', 'confirm', 'plan', 'build', 'explain', 'rescan'].indexOf(n.action) >= 0) {
      actions += btn('copyDrive', '复制给 AI 执行');
    }
    el.innerHTML = '<div class="wz-title">' + esc(title) + '</div>'
      + (n.progress
        ? '<div class="wz-meta">' + esc((n.plan && (n.action === 'apply' || n.action === 'confirm') ? '计划 ' + n.plan.planId + ' · ' : '') + n.progress) + '</div>'
        : '')
      + (purpose ? '<div class="wz-purpose">' + esc(purpose) + '</div>' : '')
      + groups + notes + '<div class="wz-actions">' + actions + '</div>';
    // 直接绑定每个按钮：webview 内委托偶尔拿不到 closest，这里不赌
    Array.prototype.forEach.call(el.querySelectorAll('[data-wz]'), function (button) {
      button.type = 'button';
      button.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        handleWizardAction(button.getAttribute('data-wz'));
      });
    });
  }

  function handleWizardAction(key) {
    if (!key) return;
    if (key === 'scan') {
      vscode.postMessage({ type: 'scan' });
    } else if (key === 'createPlan') {
      vscode.postMessage({ type: 'createUpgradePlan' });
    } else if (key === 'upgradeNext') {
      vscode.postMessage({ type: 'upgradeNext' });
    } else if (key === 'buildGate') {
      vscode.postMessage({ type: 'buildGate' });
    } else if (key === 'explainBuild') {
      vscode.postMessage({ type: 'explainBuild' });
    } else if (key === 'revertPlan') {
      vscode.postMessage({ type: 'revertPlan' });
    } else if (key === 'openHandoff') {
      vscode.postMessage({ type: 'openHandoff' });
    } else if (key === 'copyDrive') {
      vscode.postMessage({ type: 'copyDrivePrompt' });
    } else if (key === 'install-mvn') {
      vscode.postMessage({ type: 'installTool', tool: 'mvn' });
    }
  }

  function renderMcp() {
    var mcp = state.mcp || { state: 'checking', label: '检测 MCP…', detail: '正在检测。' };
    var bar = document.getElementById('mcpbar');
    if (!bar) {
      return;
    }
    bar.className = 'mcpbar ' + mcp.state;
    bar.title = mcp.detail || mcp.label;
    var label = document.getElementById('mcplabel');
    if (label) {
      label.textContent = mcp.label;
    }
    var detail = document.getElementById('mcpdetail');
    if (detail) {
      detail.textContent =
        mcp.state === 'ready'
          ? ''
          : mcp.state === 'configured'
            ? ' · 需在 IDE 启用'
            : mcp.state === 'broken'
              ? ' · 点修复'
              : mcp.state === 'missing'
                ? ' · 点接入'
                : '';
    }
    var setup = document.getElementById('mcpsetup');
    if (setup) {
      setup.style.display = mcp.state === 'ready' ? 'none' : '';
      setup.textContent = mcp.state === 'configured' ? '查看配置' : (mcp.state === 'broken' ? '修复' : '接入');
    }
    var btn = document.getElementById('mcpbtn');
    if (btn) {
      btn.className = 'mcp-status-btn ' + mcp.state;
      btn.title = 'MCP：' + mcp.label + (mcp.detail ? ' · ' + mcp.detail : '');
    }
  }

  function render() {
    renderMcp();
    renderAiStatus();
    updateTabs();
    renderWizard();
    var upgradeBtn = document.getElementById('upgrade');
    if (upgradeBtn) {
      upgradeBtn.style.display = state.upgradeEnabled === false ? 'none' : '';
    }
    var deep = state.deepFix;
    var runBusy = !!state.run && state.run.status === 'running' &&
      (!state.run.updatedAt || Date.now() - Date.parse(state.run.updatedAt) < 30 * 60 * 1000);
    // AI 执行只锁操作，不驱动猫咪进度条：进度条只跟随面板扫描/深度修复，避免 run-state 抖动导致面板闪烁
    var progressBusy = !!state.scanning || !!deep;
    var busy = progressBusy || runBusy;
    document.body.classList.toggle('ai-busy', runBusy);
    ['scan', 'deepfix', 'upgrade'].forEach(function (id) {
      var button = document.getElementById(id);
      if (button) {
        button.disabled = busy;
      }
    });
    var fill = document.querySelector('.cat-fill');
    var progress = state.scanProgress || { done: 0, total: 0 };
    // 进度条填充使用当前任务的真实进度：扫描按扫描器、修复/升级按阶段
    var ratio = null;
    if (state.scanning && progress.total) {
      ratio = progress.done / progress.total;
    } else if (deep && deep.total) {
      // 按当前步骤号展示：第 1/3 步 = 1/3
      ratio = Math.min(1, ((deep.done || 0) + 1) / deep.total);
    }
    // 任务结束时让进度条先补满 100%，停留片刻再收起
    var catbar = document.getElementById('catbar');
    if (progressBusy) {
      clearTimeout(catDoneTimer);
      catDoneTimer = null;
      if (!catbarVisible) {
        startCatRun();
      }
      clearTimeout(catHideTimer);
      catHideTimer = null;
      catbar.classList.add('on');
      catbarVisible = true;
      if (fill) {
        fill.style.width = ratio === null
          ? '34%'
          : Math.max(8, Math.round(ratio * 100)) + '%';
      }
    } else if (catbarVisible) {
      if (fill) {
        fill.style.width = '100%';
      }
      if (!catDoneTimer && !catHideTimer) {
        catDoneTimer = setTimeout(function () {
          catDoneTimer = null;
          dismissCats();
        }, 700);
      }
    }
    document.getElementById('cattip').textContent = catTipText();
    var scanning = !!state.scanning;
    var paused = !!state.paused;
    document.getElementById('scan').style.display = scanning || paused ? 'none' : '';
    document.getElementById('resume').style.display = paused ? '' : 'none';
    document.getElementById('pause').style.display = scanning && !paused ? '' : 'none';
    document.getElementById('stop').style.display = scanning ? '' : 'none';
    // 扫描按扫描器数量、深度修复/依赖升级按阶段数展示猫咪
    var catTotal = 0;
    var catDone = 0;
    if (state.scanning) {
      catTotal = progress.total;
      catDone = progress.done;
    } else if (deep && deep.total) {
      catTotal = deep.total;
      catDone = deep.done || 0;
    }
    if (progressBusy) {
      renderCats(catTotal, catDone);
    }
    var stage = document.querySelector('.cat-stage');
    if (stage) {
      stage.classList.toggle('paused', !!state.paused);
    }
    const sum = document.getElementById('summary');
    if (!state.finishedAt) {
      // 进度只在顶部猫咪进度条展示，这里保持安静，避免同一组数字重复三遍
      sum.style.display = progressBusy ? 'none' : '';
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
              + '<div class="sug-actions">'
              + (s.category === 'framework' || s.category === 'dependency'
                  ? '<button class="plan-upgrade">按建议升级</button>' : '')
              + '<button class="copy-sug" data-sug="' + (i + 1) + '">复制建议</button>'
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
        const savedScroll = list.scrollTop;
        list.innerHTML = ['checkstyle', 'gitleaks', 'qcsec', 'astgrep', 'spotbugs', 'trivy'].map(function (source) {
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
          return '<div class="group' + (collapsed[source] ? ' collapsed' : '')
            + '" data-group="' + source + '">'
            + '<div class="group-title"><span class="chev">▾</span>' + (SRC_LABEL[source] || source) + ' (' + group.length + ')</div>'
            + items + '</div>';
        }).join('');
        list.scrollTop = savedScroll;
      }
    }

    renderMessages();

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
  document.getElementById('mcpcheck').addEventListener('click', function () {
    vscode.postMessage({ type: 'checkMcp' });
  });
  document.getElementById('mcpbtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'checkMcp' });
  });
  document.getElementById('mcpsetup').addEventListener('click', function () {
    var mcp = state.mcp || { state: 'missing' };
    vscode.postMessage({ type: mcp.state === 'configured' ? 'openMcpConfig' : 'setupMcp' });
  });
  document.getElementById('mcpbar').addEventListener('dblclick', function () {
    vscode.postMessage({ type: 'openMcpConfig' });
  });
  document.getElementById('resume').addEventListener('click', function () {
    vscode.postMessage({ type: 'resumeScan' });
  });
  document.getElementById('pause').addEventListener('click', function () {
    vscode.postMessage({ type: 'pauseScan' });
  });
  document.getElementById('stop').addEventListener('click', function () {
    vscode.postMessage({ type: 'stopScan' });
  });
  document.getElementById('deepfix').addEventListener('click', function () {
    vscode.postMessage({ type: 'deepFix' });
  });
  document.getElementById('upgrade').addEventListener('click', function () {
    vscode.postMessage({ type: 'upgradeDeps' });
  });
  var wizardEl = document.getElementById('wizard');
  if (wizardEl) {
    wizardEl.addEventListener('click', function (e) {
      var target = e.target && e.target.closest ? e.target.closest('[data-wz]') : null;
      if (!target) return;
      handleWizardAction(target.getAttribute('data-wz'));
    });
  }

  var SETTING_KEYS = ['checkstyle', 'gitleaks', 'trivy', 'spotbugs', 'qcsec', 'astgrep'];
  var RECIPE_BOXES = [];
  var RISK_LABEL = { low: '低风险', medium: '中风险', high: '高风险' };
  var RISK_ORDER = ['low', 'medium', 'high'];
  function settingBox(key) {
    return document.getElementById('opt-' + key);
  }
  function compareVer(a, b) {
    var pa = String(a).split(/[.\-]/).map(function (x) { return parseInt(x, 10) || 0; });
    var pb = String(b).split(/[.\-]/).map(function (x) { return parseInt(x, 10) || 0; });
    for (var i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      var diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  }
  // 与 recipes.ts 的 recipeApplies 保持一致：按项目画像过滤配方
  function recipeApplies(def, profile) {
    var cond = def.appliesTo || {};
    var java = profile.javaVersion;
    if (cond.javaMin !== undefined && (!java || java < cond.javaMin)) return false;
    if (cond.javaMax !== undefined && (!java || java > cond.javaMax)) return false;
    var boot = profile.springBootVersion || '';
    if (cond.springBootMajor !== undefined) {
      if (!boot || parseInt(boot.split('.')[0], 10) !== cond.springBootMajor) return false;
    }
    if (cond.springBootBelow !== undefined) {
      if (!boot || compareVer(boot, cond.springBootBelow) >= 0) return false;
    }
    if (cond.junit4 && profile.junit !== 'junit4') return false;
    return true;
  }
  function renderRecipes() {
    var profile = state.projectProfile || {};
    var library = (state.recipeLibrary || []).filter(function (def) { return recipeApplies(def, profile); });
    var groups = {};
    library.forEach(function (def) { (groups[def.risk] = groups[def.risk] || []).push(def); });
    var html = '';
    RISK_ORDER.forEach(function (risk) {
      var items = groups[risk];
      if (!items || !items.length) return;
      html += '<div class="recipe-group"><div class="recipe-group-title">' + RISK_LABEL[risk] + '</div>';
      items.forEach(function (def) {
        var search = (def.label + ' ' + def.id).toLowerCase();
        html += '<label class="dlg-row recipe-row" data-search="' + esc(search) + '">'
          + '<input type="checkbox" class="recipe-box" data-recipe="' + esc(def.id) + '" data-risk="' + esc(def.risk) + '" />'
          + '<span class="recipe-name">' + esc(def.label) + '</span>'
          + (def.discovered ? '<span class="recipe-src">discover</span>' : '')
          + '<span class="recipe-desc" title="' + esc(def.id) + '">' + esc(def.description) + '</span></label>';
      });
      html += '</div>';
    });
    document.getElementById('recipe-groups').innerHTML = html
      || '<div class="dlg-hint">当前项目未检测到适用的进阶配方，低风险配方按项目自动启用。</div>';
    RECIPE_BOXES = Array.from(document.querySelectorAll('.recipe-box'));
    applyRecipeFilter();
    var profileText = [];
    if (profile.javaVersion) profileText.push('Java ' + profile.javaVersion);
    if (profile.springBootVersion) profileText.push('Spring Boot ' + profile.springBootVersion);
    if (profile.junit) profileText.push(profile.junit === 'junit4' ? 'JUnit 4' : 'JUnit 5');
    if (state.recipesDiscovering) {
      profileText.push('正在加载全部配方…');
    } else if ((state.recipeLibrary || []).some(function (def) { return def.discovered; })) {
      profileText.push('已加载全部可选配方');
    }
    document.getElementById('recipe-profile').textContent = profileText.length
      ? '已按当前项目过滤：' + profileText.join(' · ')
      : '未识别到项目画像，带条件的高级配方已隐藏';
  }
  // 只隐藏不匹配的行，保持已勾选状态不丢失
  function applyRecipeFilter() {
    var input = document.getElementById('recipe-filter');
    var keyword = input ? input.value.trim().toLowerCase() : '';
    Array.from(document.querySelectorAll('.recipe-group')).forEach(function (group) {
      var visible = 0;
      Array.from(group.querySelectorAll('.recipe-row')).forEach(function (row) {
        var hit = !keyword || (row.getAttribute('data-search') || '').indexOf(keyword) >= 0;
        row.style.display = hit ? '' : 'none';
        if (hit) {
          visible += 1;
        }
      });
      group.style.display = visible ? '' : 'none';
    });
  }
  function syncRecipeUI() {
    var auto = document.getElementById('opt-autorecipes').checked;
    RECIPE_BOXES.forEach(function (box) {
      if (box.getAttribute('data-risk') !== 'low') {
        return;
      }
      if (auto) {
        box.checked = true;
      }
      box.disabled = auto;
    });
  }
  function openSettings() {
    var options = state.scanOptions || {};
    SETTING_KEYS.forEach(function (key) {
      settingBox(key).checked = options[key] !== false;
    });
    document.getElementById('opt-scansave').checked = options.scanOnSave !== false;
    document.getElementById('opt-autorecipes').checked = options.autoRecipes !== false;
    document.getElementById('opt-allrecipes').checked = options.showAllRecipes === true;
    document.getElementById('recipe-filter').value = '';
    renderRecipes();
    var recipes = options.recipes || [];
    RECIPE_BOXES.forEach(function (box) {
      box.checked = recipes.indexOf(box.getAttribute('data-recipe')) >= 0;
    });
    syncRecipeUI();
    markPreset(currentPreset());
    document.getElementById('mask').classList.add('on');
  }
  function closeSettings() {
    document.getElementById('mask').classList.remove('on');
  }
  function currentPreset() {
    var on = SETTING_KEYS.filter(function (key) { return settingBox(key).checked; });
    if (on.length === SETTING_KEYS.length) {
      return 'full';
    }
    if (!settingBox('spotbugs').checked && on.length === SETTING_KEYS.length - 1) {
      return 'fast';
    }
    return '';
  }
  function markPreset(kind) {
    document.getElementById('preset-fast').classList.toggle('preset-on', kind === 'fast');
    document.getElementById('preset-full').classList.toggle('preset-on', kind === 'full');
  }
  function applyPreset(fast) {
    SETTING_KEYS.forEach(function (key) {
      settingBox(key).checked = fast ? key !== 'spotbugs' : true;
    });
    markPreset(fast ? 'fast' : 'full');
  }
  SETTING_KEYS.forEach(function (key) {
    settingBox(key).addEventListener('change', function () {
      markPreset(currentPreset());
    });
  });
  document.getElementById('settings').addEventListener('click', openSettings);
  document.getElementById('opt-autorecipes').addEventListener('change', syncRecipeUI);
  document.getElementById('recipe-filter').addEventListener('input', applyRecipeFilter);
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
    options.autoRecipes = document.getElementById('opt-autorecipes').checked;
    options.showAllRecipes = document.getElementById('opt-allrecipes').checked;
    options.recipes = RECIPE_BOXES.filter(function (box) {
      return !box.disabled && box.checked;
    }).map(function (box) {
      return box.getAttribute('data-recipe');
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
  document.getElementById('msgbar').addEventListener('click', function (e) {
    const target = e.target;
    const action = target && target.closest ? target.closest('[data-msg]') : null;
    if (action) {
      vscode.postMessage({ type: action.getAttribute('data-msg') });
      return;
    }
    const tool = target && target.getAttribute ? target.getAttribute('data-install') : null;
    if (tool) {
      vscode.postMessage({ type: 'installTool', tool: tool });
    }
  });
  document.getElementById('list').addEventListener('click', function (e) {
    const title = e.target.closest ? e.target.closest('.group-title') : null;
    if (title) {
      const groupEl = title.parentElement;
      const key = groupEl.getAttribute('data-group') || '';
      groupEl.classList.toggle('collapsed');
      collapsed[key] = groupEl.classList.contains('collapsed');
      return;
    }
    if (e.target.classList && e.target.classList.contains('plan-upgrade')) {
      vscode.postMessage({ type: 'upgradeDeps' });
      e.stopPropagation();
      return;
    }
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
    if (state.run) {
      renderAiStatus();
    }
    if (state.task || (state.run && ['running', 'blocked', 'needs_confirm'].indexOf(state.run.status) >= 0)) {
      renderMessages();
    }
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
