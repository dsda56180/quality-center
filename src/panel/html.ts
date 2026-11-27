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
  impactLabel?: string;
}

export interface SnapshotProject {
  id: string;
  label: string;
  kind: string;
  total: number;
  critical: number;
  high: number;
  scanAt?: string;
  hasResult: boolean;
  dirty: boolean;
  active: boolean;
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
    cveTotal?: number;
    skippedCount?: number;
    groups: { name: string; label: string; total: number; applied: number; state: string }[];
    candidates?: {
      packageName: string;
      from: string;
      to: string;
      group: string;
      groupLabel: string;
      cveCount: number;
      crossLine: boolean;
    }[];
  };
  blockers: { code: string; message: string; suggestion: string }[];
  warnings: { code: string; message: string; suggestion: string }[];
  handoffFile?: string;
}

export interface Snapshot {
  type: 'state';
  /** 工作区项目列表；单项目时长度 1，不显示切换器 */
  projects?: SnapshotProject[];
  activeProject?: { id: string; label: string; kind: string };
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
    /** 按来源的修复前/后，用于在结果卡里直接看“哪一类降了多少” */
    bySource?: Record<string, { before: number; after: number; change: number }>;
    newlyVisible?: string[];
    blocked?: string[];
    /** 报告里那份计划的剩余项：必须跟着 final.planId 走，不能被当前新计划覆盖 */
    planSkipped?: {
      packageName: string;
      installedVersion?: string;
      fixedVersion?: string;
      cveCount?: number;
      reason?: string;
      decision?: string;
    }[];
    planCrossLine?: { packageName: string; from?: string; to: string }[];
    /** 收尾后又生成了新计划 / 又扫了一次：数字仍可看，但只代表上一轮 */
    stale?: boolean;
    staleReason?: 'new-plan' | 'newer-scan' | 'newer-run';
    currentPlanId?: string;
  };
  /** 唯一状态机：现在到哪、下一步只做什么 */
  next?: SnapshotNext;
  deepFix?: { stage: string; startedAt: number; total?: number; done?: number } | null;
  /** 普通扫描后的深度预演结果；只记录可改文件数，不自动应用 */
  deepScan?: { status: 'running' | 'done' | 'empty' | 'failed' | 'unavailable'; files: number; at: number } | null;
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
    /** 扫描结束后自动运行 OpenRewrite 深度预演 */
    rewriteScan?: boolean;
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
    overflow-y: auto; overflow-x: hidden;
    scrollbar-width: thin;
  }
  .head { flex: 0 0 auto; }
  #list { overflow: visible; }
  #list.flash { outline: 2px solid var(--vscode-focusBorder, #3794ff); outline-offset: 3px; border-radius: 3px; }
  .projectbar {
    display: none; align-items: center; gap: 6px; margin: 0 0 7px;
    min-width: 0; font-size: 11px; color: var(--vscode-descriptionForeground);
  }
  .projectbar .proj-label { flex: 0 0 auto; font-weight: 600; color: var(--vscode-foreground); }
  #project-select {
    flex: 1 1 auto; min-width: 0; max-width: 58%; height: 24px;
    padding: 0 4px; border-radius: 3px; font-size: 11px;
    color: var(--vscode-foreground); background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
  }
  #project-select:disabled { opacity: .6; }
  #projectmeta {
    flex: 0 0 auto; max-width: 42%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 10px; color: var(--vscode-descriptionForeground);
  }
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
  /* 主操作统一用固定蓝色，避免不同主题把按钮背景渲染成灰/绿 */
  #scan,
  .wz-ai-first .wz-scope-run {
    background: #0e639c; color: #ffffff; border-color: #0e639c;
  }
  #scan:hover,
  .wz-ai-first .wz-scope-run:hover { background: #1177bb; border-color: #1177bb; }
  .icon-btn svg { display: block; }
  /* 有数据时扫描只是“重新扫描”，不再抢当前计划的主操作 */
  #scan.secondary {
    background: transparent;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border-color: var(--vscode-panel-border);
  }
  #scan.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground, rgba(90, 93, 94, .45));
    border-color: var(--vscode-focusBorder, #007acc);
  }
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
  body.ai-busy #wizard,
  body.ai-busy .item .actions,
  body.ai-busy .d-actions,
  body.ai-busy .sug-actions,
  body.ai-busy .tool-link,
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
  .msg-action.primary {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background); font-weight: 600;
  }
  .msg-action.primary:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
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
    max-width: 100%; box-sizing: border-box;
  }
  .wz-title, .wz-meta, .wz-purpose { overflow-wrap: anywhere; }
  .wz-title { font-weight: 600; line-height: 1.45; }
  .wz-meta { margin-top: 3px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .wz-purpose { margin-top: 4px; font-size: 11px; line-height: 1.5; color: var(--vscode-foreground); opacity: .9; }
  .wz-result {
    margin-top: 8px; padding: 7px 8px; border: 1px solid var(--vscode-panel-border);
    border-radius: 6px; background: var(--vscode-sideBar-background, rgba(128,128,128,.04));
    font-size: 10px; line-height: 1.5; overflow-wrap: anywhere;
  }
  .wz-result-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
  .wz-result-head strong { font-size: 11px; }
  .wz-result-head .wz-result-sum { flex: none; font-weight: 600; color: var(--vscode-foreground); }
  .wz-result-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; margin-top: 6px; }
  .wz-result-cell {
    min-width: 0; padding: 4px 5px; border: 1px solid var(--vscode-panel-border);
    border-radius: 4px; background: var(--vscode-editor-background, transparent);
  }
  .wz-result-cell .label { display: block; font-size: 9px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wz-result-cell .value { display: block; margin-top: 1px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .wz-result-cell .delta { font-weight: 400; font-size: 9px; color: var(--vscode-descriptionForeground); }
  .wz-result-row { margin-top: 6px; padding-top: 5px; border-top: 1px dashed var(--vscode-panel-border); }
  .wz-result-row-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; }
  .wz-result-row-head strong { font-size: 10px; }
  .wz-result-tag { padding: 0 4px; border-radius: 3px; background: rgba(210,153,34,.14); color: var(--vscode-editorWarning-foreground, #d29922); font-size: 9px; }
  .wz-result-tag.info { background: rgba(56,139,253,.14); color: var(--vscode-textLink-foreground, #3794ff); }
  .wz-result-why { margin-top: 2px; color: var(--vscode-descriptionForeground); }
  .wz-result-stale { margin-top: 3px; padding: 3px 5px; border-radius: 3px; background: rgba(210,153,34,.12); color: var(--vscode-editorWarning-foreground, #d29922); }
  .wz-result-history { margin-top: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: rgba(128,128,128,.04); }
  .wz-result-history > summary {
    display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 6px;
    padding: 6px 8px; cursor: pointer; list-style: none; font-size: 10px; color: var(--vscode-descriptionForeground);
  }
  .wz-result-history > summary::-webkit-details-marker { display: none; }
  .wz-result-history > summary::before { content: '▸'; margin-right: 5px; color: var(--vscode-descriptionForeground); }
  .wz-result-history[open] > summary::before { content: '▾'; }
  .wz-result-history > summary .wz-history-note { flex: none; color: var(--vscode-descriptionForeground); }
  .wz-result-history .wz-result { margin: 0; border: 0; border-top: 1px solid var(--vscode-panel-border); border-radius: 0 0 6px 6px; }
  /* 历史只用于回看：不保留“下一步”和旧计划按钮，避免与当前计划争主操作 */
  .wz-result-history .wz-result-actions,
  .wz-result-history .wz-result-next { display: none; }
  .wz-result-history-tools { display: flex; flex-wrap: wrap; gap: 5px; padding: 6px 8px 0; }
  .wz-result-list { margin-top: 3px; }
  .wz-result-item { display: flex; gap: 4px; min-width: 0; }
  .wz-result-item .pkg { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wz-result-item .ver { flex: none; color: var(--vscode-descriptionForeground); }
  .wz-result-more { margin-top: 4px; color: var(--vscode-descriptionForeground); }
  .wz-result-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
  .wz-result-btn {
    padding: 2px 7px; min-height: 22px; border: 1px solid var(--vscode-panel-border);
    border-radius: 3px; background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.12));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); font: inherit; font-size: 10px; cursor: pointer;
  }
  .wz-result-btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.2)); }
  .wz-result-btn.wz-result-primary {
    background: #0e639c; color: #ffffff; border-color: #0e639c; font-weight: 600;
  }
  .wz-result-btn.wz-result-primary:hover { background: #1177bb; border-color: #1177bb; }
  .wz-result-btn.wz-result-inline { margin-left: 4px; padding: 1px 5px; font-size: 9px; }
  .wz-overview {
    margin-top: 8px; padding: 7px 8px; border: 1px solid var(--vscode-panel-border);
    border-radius: 6px; background: var(--vscode-sideBar-background, rgba(128,128,128,.04));
  }
  .wz-overview-head {
    display: flex; align-items: baseline; justify-content: space-between; gap: 6px;
    font-size: 10px; color: var(--vscode-descriptionForeground);
  }
  .wz-overview-head strong { font-size: 11px; color: var(--vscode-foreground); }
  .wz-overview-head .head-right { display: flex; align-items: center; gap: 8px; }
  .wz-report-link {
    padding: 0; border: 0; background: transparent; font: inherit; font-size: 10px;
    color: var(--vscode-textLink-foreground, #3794ff); cursor: pointer;
  }
  .wz-report-link:hover { text-decoration: underline; }
  .wz-overview-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; margin-top: 6px; }
  .wz-overview-cell {
    display: flex; align-items: baseline; justify-content: space-between; gap: 6px;
    min-width: 0; padding: 5px 6px; border: 1px solid var(--vscode-panel-border);
    border-radius: 4px; line-height: 1.35;
  }
  .wz-overview-cell .label {
    min-width: 0; font-size: 9px; color: var(--vscode-descriptionForeground);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .wz-overview-cell .value {
    flex: none; margin-top: 0; font-size: 11px; font-weight: 600;
    color: var(--vscode-foreground); white-space: nowrap;
  }
  .wz-overview-note { margin-top: 5px; font-size: 9px; line-height: 1.5; color: var(--vscode-descriptionForeground); }
  .wz-choices { margin-top: 8px; }
  .wz-choices-note { margin-top: 2px; font-size: 10px; line-height: 1.5; color: var(--vscode-descriptionForeground); }
  .wz-choice-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: stretch; gap: 5px; margin-top: 5px; }
  .wz-choice {
    display: flex; flex-direction: column; min-width: 0; padding: 6px 7px;
    border: 1px solid var(--vscode-panel-border); border-radius: 6px;
    background: var(--vscode-sideBar-background, rgba(128,128,128,.04));
  }
  .wz-choice.recommend { border-color: var(--vscode-focusBorder, #007acc); }
  .wz-choice.risk { border-color: var(--vscode-editorWarning-foreground, #d29922); }
  .wz-choice-title { display: flex; flex-wrap: nowrap; align-items: baseline; gap: 3px 5px; font-size: 11px; font-weight: 600; }
  .wz-choice-title .wz-choice-count { margin-left: auto; flex: none; font-size: 9px; font-weight: 400; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .wz-choice-tag {
    flex: none; font-size: 8px; font-weight: 400; padding: 0 4px; border-radius: 7px;
    color: var(--vscode-textLink-foreground); background: rgba(88,166,255,.14);
  }
  .wz-choice-tag.risk {
    color: var(--vscode-editorWarning-foreground, #d29922);
    background: rgba(210,153,34,.14);
  }
  .wz-choice-note { flex: 0 0 auto; min-height: 2.8em; margin-top: 3px; font-size: 9px; line-height: 1.4; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .wz-choice .wz-primary {
    display: inline-flex; align-self: flex-start; width: auto; margin-top: 4px; padding: 3px 8px;
    font-size: 10px; font-weight: 500; line-height: 1.2; text-align: left; white-space: nowrap;
  }
  .wz-choice .secondary {
    display: inline-flex; align-self: flex-start; width: auto; margin-top: 4px; padding: 3px 8px;
    font-size: 10px; line-height: 1.2; text-align: left; cursor: pointer; white-space: nowrap;
    border: 1px solid var(--vscode-panel-border); border-radius: 4px;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }
  .wz-choice .secondary:hover { background: var(--vscode-list-hoverBackground); }
  .wz-choice .secondary:disabled { opacity: .45; cursor: not-allowed; }
  .wz-ai-first {
    border: 2px solid #3fb950;
    background: rgba(63,185,80,.20);
    box-shadow: 0 0 0 1px rgba(63,185,80,.60), 0 0 18px rgba(63,185,80,.28);
  }
  .wz-star {
    margin-left: 5px; font-size: 11px; line-height: 1; vertical-align: 1px;
    color: #f2cc60;
  }
  .wz-ai-first .wz-scope-run {
    background: #0e639c;
    color: #ffffff;
    border-color: #0e639c;
  }
  .wz-ai-first .wz-scope-run:hover { background: #1177bb; border-color: #1177bb; }
  .wz-route-head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    margin-top: 8px; padding: 5px 0 5px 7px;
    border-left: 3px solid var(--vscode-focusBorder, #007acc);
  }
  .wz-route-head strong { display: block; font-size: 11px; }
  .wz-route-head span { display: block; margin-top: 1px; font-size: 9px; color: var(--vscode-descriptionForeground); }
  .wz-route-back {
    flex: none; padding: 3px 7px; font-size: 9px; cursor: pointer;
    border: 1px solid var(--vscode-panel-border); border-radius: 3px;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }
  .wz-route-back:hover { background: var(--vscode-list-hoverBackground); }
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
  .wz-gate {
    margin-top: 7px; padding: 6px 8px; border: 1px solid var(--vscode-panel-border);
    border-radius: 4px; font-size: 10px; line-height: 1.5; overflow-wrap: anywhere;
  }
  .wz-gate.block {
    border-color: var(--vscode-editorError-foreground, #f85149);
    background: rgba(248, 81, 73, .07);
  }
  .wz-gate.warn {
    border-color: var(--vscode-editorWarning-foreground, #d29922);
    background: rgba(210, 153, 34, .06);
  }
  .wz-gate-head { font-weight: 600; }
  .wz-gate.block .wz-gate-head { color: var(--vscode-editorError-foreground, #f85149); }
  .wz-gate.warn .wz-gate-head { color: var(--vscode-editorWarning-foreground, #d29922); }
  .wz-gate-msg { margin-top: 2px; }
  .wz-gate-tip { margin-top: 3px; color: var(--vscode-descriptionForeground); }
  .wz-lock {
    margin-top: 7px; padding: 5px 7px; border: 1px dashed var(--vscode-panel-border);
    border-radius: 4px; font-size: 10px; line-height: 1.5; color: var(--vscode-descriptionForeground);
  }
  .wz-empty { margin-top: 7px; font-size: 11px; line-height: 1.6; color: var(--vscode-descriptionForeground); }
  .wz-empty-step { margin-top: 2px; }
  .wz-primary-row { margin-top: 9px; }
  .wz-primary {
    display: block; width: 100%; padding: 7px 10px; font-size: 12px; font-weight: 600;
    text-align: left; cursor: pointer; border: 1px solid transparent; border-radius: 4px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  .wz-primary:hover { background: var(--vscode-button-hoverBackground); }
  .wz-primary:disabled { opacity: .5; cursor: not-allowed; }
  .wz-primary-hint { margin-top: 4px; font-size: 10px; line-height: 1.5; color: var(--vscode-descriptionForeground); }
  .wz-secondary { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .wz-secondary button {
    flex: 0 1 auto; min-width: 0; padding: 5px 9px; font-size: 11px; line-height: 1.4;
    text-align: left; border-radius: 3px; border: 1px solid var(--vscode-panel-border); cursor: pointer;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }
  .wz-secondary button:hover { background: var(--vscode-list-hoverBackground); }
  .wz-secondary button:disabled { opacity: .45; cursor: not-allowed; }
  .wz-secondary button.danger {
    border-color: var(--vscode-editorWarning-foreground, #d29922);
    color: var(--vscode-editorWarning-foreground, #d29922);
  }
  .wz-secondary-hint { margin-top: 4px; font-size: 9px; line-height: 1.4; color: var(--vscode-descriptionForeground); }
  .wz-section-label { margin-top: 9px; font-size: 10px; color: var(--vscode-descriptionForeground); }
  .wz-ai { margin-top: 6px; padding: 6px 7px; border-radius: 6px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background, rgba(128,128,128,.05)); }
  .wz-ai-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; margin-bottom: 5px; }
  .wz-ai-head strong { font-size: 11px; }
  .wz-ai-head span { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .wz-deep {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    margin-top: 8px; padding: 6px 7px; border: 1px dashed var(--vscode-panel-border); border-radius: 6px;
    background: rgba(128,128,128,.04);
  }
  .wz-deep strong { display: block; font-size: 11px; }
  .wz-deep small { display: block; margin-top: 2px; font-size: 10px; line-height: 1.4; color: var(--vscode-descriptionForeground); }
  .wz-deep button {
    flex: none; padding: 3px 8px; font-size: 10px; line-height: 1.2; white-space: nowrap; cursor: pointer;
    border: 1px solid var(--vscode-panel-border); border-radius: 4px;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }
  .wz-deep button:disabled { opacity: .45; cursor: not-allowed; }
  .wz-advanced { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--vscode-panel-border); }
  .wz-advanced > summary { cursor: pointer; list-style: none; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .wz-advanced > summary::-webkit-details-marker { display: none; }
  .wz-advanced > summary::before { content: '▸ '; }
  .wz-advanced[open] > summary::before { content: '▾ '; }
  .wz-advanced-body { margin-top: 5px; }
  .wz-advanced-row {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
    padding: 5px 6px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-top: 4px;
  }
  .wz-advanced-row strong { display: block; font-size: 11px; }
  .wz-advanced-row small { display: block; margin-top: 2px; font-size: 10px; line-height: 1.4; color: var(--vscode-descriptionForeground); }
  .wz-advanced-row button {
    flex: none; padding: 4px 8px; font-size: 10px; cursor: pointer;
    border: 1px solid var(--vscode-panel-border); border-radius: 3px;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }
  .wz-plan { margin-top: 7px; border-top: 1px dashed var(--vscode-panel-border); padding-top: 6px; }
  .wz-plan-head {
    display: flex; align-items: baseline; justify-content: space-between; gap: 6px;
    font-size: 10px; color: var(--vscode-descriptionForeground);
  }
  .wz-plan-toggle {
    padding: 0; border: 0; background: transparent; cursor: pointer;
    color: var(--vscode-textLink-foreground); font-size: 10px;
  }
  .wz-plan-toggle:hover { text-decoration: underline; }
  .wz-plan-list { margin-top: 5px; }
  .wz-plan-group { margin-bottom: 5px; }
  .wz-plan-group-title {
    font-size: 10px; font-weight: 600; color: var(--vscode-foreground);
    margin-bottom: 1px;
  }
  .wz-plan-row {
    display: flex; flex-wrap: wrap; gap: 2px 6px; align-items: baseline; line-height: 1.55;
    font-size: 10px; color: var(--vscode-descriptionForeground);
  }
  .wz-plan-row .pkg { flex: 1 1 140px; min-width: 0; word-break: break-all; }
  .wz-plan-row .ver { flex: none; color: var(--vscode-foreground); }
  .wz-plan-row .cve { flex: none; color: var(--vscode-editorWarning-foreground, #d29922); }
  .wz-plan-row.done { opacity: .65; }
  .wz-plan-note { margin-top: 4px; font-size: 10px; color: var(--vscode-descriptionForeground); }
  .wz-fixplan { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--vscode-panel-border); }
  .wz-fixplan-head {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-start; gap: 4px 6px;
    font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 4px;
  }
  .wz-fixplan-head strong { flex: 0 0 auto; color: var(--vscode-foreground); font-size: 11px; }
  .wz-fixplan-head .fix-count { margin-left: auto; flex: none; }
  .wz-fixbody { margin-top: 2px; }
  .wz-fixsection { margin-top: 6px; padding-top: 5px; border-top: 1px dashed var(--vscode-panel-border); min-width: 0; }
  .wz-fixsection:first-child { margin-top: 2px; padding-top: 0; border-top: 0; }
  .wz-fixsection-head {
    display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 6px;
    margin-bottom: 3px; font-size: 10px; color: var(--vscode-descriptionForeground);
  }
  .wz-fixsection-head .fix-tag {
    flex: none; font-size: 9px; padding: 0 4px; border-radius: 7px;
    color: var(--vscode-textLink-foreground); background: rgba(88,166,255,.12);
  }
  .wz-fixrow { display: flex; flex-wrap: wrap; gap: 2px 5px; align-items: baseline; line-height: 1.5; margin-bottom: 3px; }
  .wz-fixrow .fix-tag {
    flex: none; font-size: 9px; padding: 0 4px; border-radius: 7px;
    color: var(--vscode-textLink-foreground); background: rgba(88,166,255,.12);
  }
  .wz-fixrow .fix-title { flex: 1 1 auto; min-width: 0; font-size: 10px; color: var(--vscode-foreground); }
  .wz-fixrow .fix-impact { flex: none; font-size: 9px; color: var(--vscode-descriptionForeground); }
  .wz-fixnote { margin-top: 4px; font-size: 10px; line-height: 1.5; color: var(--vscode-descriptionForeground); }
  .wz-scope-row { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; max-width: 100%; }
  .wz-sev {
    display: flex; align-items: center; gap: 4px; flex: 0 0 auto;
    font-size: 10px; color: var(--vscode-descriptionForeground);
  }
  .wz-sev select {
    max-width: 108px; padding: 2px 4px; font-size: 10px; line-height: 1.3;
    background: var(--vscode-dropdown-background, var(--vscode-sideBar-background, transparent));
    color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
    border-radius: 4px;
  }
  .wz-scope-picker {
    position: relative; flex: 1 1 110px; width: auto; max-width: none; min-width: 0;
  }
  .wz-scope-picker summary {
    display: flex; align-items: center; gap: 4px;
    cursor: pointer; list-style: none; padding: 3px 7px;
    border: 1px solid var(--vscode-button-secondaryBackground, rgba(128,128,128,.25));
    border-radius: 4px; font-size: 10px;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }
  .wz-scope-picker summary::-webkit-details-marker { display: none; }
  .wz-scope-picker summary .pick-label { flex: none; color: var(--vscode-descriptionForeground); margin-right: 4px; }
  .wz-scope-picker #scopePickSummary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wz-scope-caret {
    display: inline-flex; align-items: center; justify-content: center;
    flex: none; width: 12px; height: 12px; margin-left: auto;
    color: var(--vscode-focusBorder, #007acc); font-size: 10px; line-height: 1;
  }
  .wz-scope-caret::before { content: '▾'; }
  .wz-scope-picker[open] .wz-scope-caret::before { content: '▴'; }
  .wz-scope-menu {
    position: absolute; left: 0; right: auto; top: calc(100% + 4px); z-index: 30;
    width: max-content; min-width: 262px; max-width: calc(100vw - 24px);
    margin-top: 0; padding: 5px 6px; border-radius: 5px;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editor-background, #1f1f1f);
    box-shadow: 0 6px 16px rgba(0, 0, 0, .35);
    max-height: 260px; overflow-y: auto;
  }
  .wz-scope-option {
    display: grid; grid-template-columns: 14px minmax(0, 1fr) auto; align-items: center;
    column-gap: 4px; row-gap: 1px; line-height: 1.5;
    font-size: 10px; cursor: pointer; white-space: normal;
  }
  .wz-scope-option input { margin: 0; width: 12px; height: 12px; align-self: start; margin-top: 3px; }
  .wz-scope-detail {
    grid-column: 2 / 4; font-size: 9px; line-height: 1.35;
    color: var(--vscode-descriptionForeground); white-space: normal;
  }
  .wz-scope-truth {
    margin-top: 5px; font-size: 9px; line-height: 1.45;
    color: var(--vscode-descriptionForeground);
  }
  .wz-scope-truth strong { color: var(--vscode-foreground); font-weight: 600; }
  .wz-scope-run {
    flex: none; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 10px;
    white-space: nowrap;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }
  .wz-scope-run:disabled { opacity: .45; cursor: not-allowed; }
  .wz-ai-primary .wz-scope-run {
    padding: 5px 10px; font-size: 11px; font-weight: 600;
    background: #0e639c; color: #ffffff; border-color: #0e639c;
  }
  .wz-ai-primary .wz-scope-run:hover { background: #1177bb; border-color: #1177bb; }
  .wz-scope-note { margin-top: 5px; font-size: 9px; line-height: 1.4; color: var(--vscode-descriptionForeground); }
  .wz-plan > summary, .wz-fixplan > summary {
    cursor: pointer; list-style: none; user-select: none;
  }
  .wz-plan > summary::-webkit-details-marker, .wz-fixplan > summary::-webkit-details-marker { display: none; }
  .wz-fixplan-caret {
    display: inline-flex; align-items: center; justify-content: center;
    flex: none; width: 18px; height: 18px; border-radius: 3px;
    border: 1px solid var(--vscode-focusBorder, #007acc);
    color: var(--vscode-focusBorder, #007acc); font-size: 13px; line-height: 1;
  }
  .wz-fixplan-caret::before { content: '▸'; }
  .wz-fixplan[open] .wz-fixplan-caret::before { content: '▾'; }
  .wz-fixplan-fold { flex: none; font-size: 9px; color: var(--vscode-descriptionForeground); }
  .wz-fixplan-fold::before { content: '展开'; }
  .wz-fixplan[open] .wz-fixplan-fold::before { content: '收起'; }
  .wz-plan > summary::before { content: '▸ '; color: var(--vscode-descriptionForeground); }
  .wz-plan[open] > summary::before { content: '▾ '; }
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
  <div id="projectbar" class="projectbar">
    <span class="proj-label">项目</span>
    <select id="project-select" title="切换要扫描和修复的项目"></select>
    <span id="projectmeta"></span>
  </div>
  <div class="toolbar">
    <button id="scan" class="icon-btn" title="开始扫描"><svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor"><path d="M4 2l8 5-8 5z"/></svg></button>
    <button id="resume" class="icon-btn" title="继续扫描" style="display:none"><svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor"><path d="M4 2l8 5-8 5z"/></svg></button>
    <button id="pause" class="icon-btn secondary" title="暂停扫描：当前扫描器结束后不再启动新的扫描器" style="display:none"><svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor"><path d="M3 2h3v10H3zM8 2h3v10H8z"/></svg></button>
    <button id="stop" class="icon-btn secondary" title="终止扫描" style="display:none"><svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor"><path d="M3 3h8v8H3z"/></svg></button>
    <span class="spacer"></span>
    <button id="mcpbtn" class="mcp-status-btn checking" title="MCP 检测中"><span class="mcp-dot"></span>MCP</button>
    <button id="copy" class="icon-btn secondary" title="复制报告"><svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor"><path d="M4 1h6l2 2v8H4zM2 4h1.5v9h7v1.5H2z"/></svg></button>
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
  <div id="wizard" class="wizard" style="display:none"></div>
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
      <label class="dlg-row"><input type="checkbox" id="opt-rewritescan" /> 手动扫描后运行 OpenRewrite 深度预演（只生成 diff，较慢）</label>
      <div class="dlg-hint">快速模式关闭 SpotBugs，约 15 秒；完整模式约 35 秒。深度预演首次约 1–5 分钟，工作区未变化时复用缓存；保存触发的扫描不叠加，保存后下次扫描生效。</div>
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
  const SUG_LABEL = { framework: '框架', dependency: '依赖', duplicate: '收敛', secret: '密钥', manual: '人工' };
  const SEV_LABEL = { critical: '严重', high: '高危', medium: '中危', low: '低危', info: '提示' };
  const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
  let state = { run: null, projects: [], activeProject: null, scanning: false, paused: false, deepFix: null, deepScan: null, task: null, scanStartedAt: null, scanProgress: { done: 0, total: 0, active: [] }, finishedAt: null, issues: [], ignored: [], suggestions: [], errors: [], skipped: [], upgradeEnabled: true, scanOptions: { checkstyle: true, gitleaks: true, trivy: true, spotbugs: true, qcsec: true, astgrep: true, scanOnSave: true, rewriteScan: false, recipes: [], autoRecipes: true, showAllRecipes: false }, recipeLibrary: [], recipesDiscovering: false, projectProfile: {} };
  let activeTab = 'all';
  /** 修复范围多选；跨渲染保留，默认全选（等同于“全面修复”） */
  let scopePick = ['upgrade', 'consolidation', 'code', 'secrets', 'static'];
  /** 每个范围的“可自动 / 需确认 / 只报告 / 待授权”真实口径，避免全选被误读为全修 */
  let scopeStats = {};
  /** AI 修复的严重度下限；info 表示全部 */
  let severityPick = 'info';
  let routePick = '';
  let routeScanKey = '';
  /** 各来源分组的折叠状态，跨渲染保留 */
  let collapsed = {};
  let severityFilter = [];
  let query = '';

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function projectTime(at) {
    if (!at) return '';
    var d = new Date(at);
    if (isNaN(d.getTime())) return '';
    function two(n) { return n < 10 ? '0' + n : String(n); }
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }

  /** 多项目工作区：只切换“当前项目”，不合并问题，也不自动扫描其他项目 */
  function renderProjects() {
    var bar = document.getElementById('projectbar');
    var select = document.getElementById('project-select');
    var meta = document.getElementById('projectmeta');
    if (!bar || !select || !meta) return;
    var projects = state.projects || [];
    if (projects.length <= 1) {
      bar.style.display = 'none';
      return;
    }
    var active = state.activeProject || {};
    var current = null;
    select.innerHTML = projects.map(function (p) {
      if (p.id === active.id) current = p;
      var text = p.hasResult ? (p.total + ' 项') : '未扫描';
      if (p.critical || p.high) text += ' · ' + (p.critical + p.high) + ' 高危';
      if (p.dirty) text += ' · 有改动';
      return '<option value="' + esc(p.id) + '"' + (p.id === active.id ? ' selected' : '') + '>' +
        esc(p.label) + ' · ' + text + '</option>';
    }).join('');
    var busy = state.scanning || state.deepFix || state.task ||
      (state.run && state.run.status === 'running');
    select.disabled = !!busy;
    var time = current ? projectTime(current.scanAt) : '';
    meta.textContent = current
      ? (current.hasResult ? (time ? '上次扫描 ' + time : '已有结果') : '当前项目未扫描')
      : '';
    meta.title = current ? '单项目模式：只扫描和操作当前项目' : '';
    bar.style.display = 'flex';
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
      if (final && !final.stale) {
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

  /** 顶部消息栏：平时隐藏，只在需要用户知悉或确认/操作时出现 */
  function renderMessages(busy) {
    var bar = document.getElementById('msgbar');
    if (!bar) return;
    var items = [];
    function action(label, type, title, primary) {
      return '<button class="msg-action' + (primary ? ' primary' : '') + '" data-msg="' + type + '" title="' +
        esc(title || label) + '">' + label + '</button>';
    }
    function focus(label, id) {
      return '<button class="msg-action" data-focus="' + id + '" title="' + esc(label) + '">' + label + '</button>';
    }
    function add(level, text, actions) {
      items.push(
        '<div class="msgline ' + level + '">' +
        '<span class="msg-text">' + text + '</span>' +
        (actions ? '<span class="msg-actions">' + actions + '</span>' : '') +
        '</div>'
      );
    }

    // MCP 正常时不打扰；只有未接入、待启用、配置异常才占用消息栏
    var mcp = state.mcp || {};
    if (mcp.state === 'configured') {
      add('warn',
        '🟡 ' + esc(mcp.label) + '：' + esc(mcp.detail),
        action('重新检测', 'checkMcp', 'Trae 已启用项目级 MCP 后，重新检测是否握手成功') +
        action('查看配置', 'openMcpConfig', '打开项目 MCP 配置文件'));
    } else if (mcp.state === 'broken') {
      add('error',
        '🔴 ' + esc(mcp.label) + '：' + esc(mcp.detail),
        action('修复配置', 'setupMcp', '重新生成可用的项目 MCP 配置') +
        (mcp.configFile ? action('查看配置', 'openMcpConfig', '打开项目 MCP 配置文件') : ''));
    } else if (mcp.state === 'missing') {
      add('error',
        '⚪ ' + esc(mcp.label) + (mcp.detail ? '：' + esc(mcp.detail) : ''),
        action('一键接入', 'setupMcp', '生成项目 MCP 配置'));
    }

    // AI 执行情况：执行中/阻塞/待确认时给一条可回溯到状态卡的摘要
    var run = state.run;
    if (run && (run.status === 'running' || run.status === 'blocked' || run.status === 'needs_confirm')) {
      var age = run.updatedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(run.updatedAt)) / 1000)) : 0;
      var working = run.status === 'running' && age < 1800;
      var blockErr = run.lastToolError ? ' · ' + esc(shortError(run.lastToolError)) : '';
      if (working) {
        var phase = run.phase === 'done' ? uiPhaseForTool(run.lastTool, run) : run.phase;
        var phaseText = ({
          baseline_build: '基线构建', baseline_scan: '基线扫描', fix: '确定性修复', plan: '依赖计划',
          apply: '依赖落盘', static_fix: '静态修复', rescan: '复扫', finalize: '收尾'
        })[phase] || phase || '执行中';
        add('info',
          '🤖 AI（' + esc((run.actor && run.actor.client) || 'MCP') + '）正在执行 · ' + phaseText +
          (run.lastTool ? ' · ' + esc(run.lastTool) : ''),
          focus('查看详情', 'aistatus'));
      } else if (run.status === 'blocked') {
        add('error', '⛔ AI 已阻塞 · ' + esc(run.lastTool || '等待处理') + blockErr, focus('查看详情', 'aistatus'));
      } else if (run.status === 'needs_confirm') {
        add('warn', '⏸ AI 等待你确认 · ' + esc(run.lastTool || '继续执行'), focus('查看详情', 'aistatus'));
      }
    }

    // 修复与优化：人工可执行的动作统一进修复工作台；消息栏只保留运行态与构建提醒
    if (!busy && state.finishedAt && state.buildHint) {
      add('warn', '🧱 ' + esc(state.buildHint), action('构建并扫描', 'buildAndScan'));
    }

    if (state.final) {
      var f = state.final;
      var finalPending = state.next && state.next.plan ? Number(state.next.plan.skippedCount || 0) : 0;
      if (f.stale && f.planSkipped) {
        finalPending = f.planSkipped.length;
      }
      // 上一轮验收默认不在消息栏重复；历史明细已折叠在结果区，避免和本轮扫描混淆
      if (!f.stale) {
        add('info', (state.scanning ? '🧾 最终验收（正在重新扫描）：' : '🧾 最终验收：') + f.baselineTotal + ' → ' + f.currentTotal + ' 项（' +
          (f.totalChange >= 0 ? '+' : '') + f.totalChange + '，新增 ' + f.added + ' / 消失 ' + f.removed + '）' +
          (f.planId ? ' · 计划 ' + (f.planApplied ?? 0) + '/' + (f.planTotal ?? 0) : '') +
          (finalPending ? ' · ' + finalPending + ' 项未自动处理' : '') +
          (f.tests === 'skipped' ? ' · ⚠ 构建跳过测试' : '') +
          (state.scanning ? ' · 扫描完成后刷新' : ''),
          focus('查看结果', 'wizard'));
      }
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
    var issueTotal0 = (state.issues || []).length;
    var hasData = issueTotal0 > 0 || (state.suggestions || []).length > 0 || Boolean(n.plan);
    var blankState = !hasData && n.action === 'scan'
      ? 'scan'
      : (!hasData && n.action === 'rescan' && n.scan && Number(n.scan.total || 0) === 0 ? 'clean' : '');
    if (!hasData && !blankState) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    el.style.display = 'block';
    var label = n.plan && n.plan.nextLabel ? n.plan.nextLabel : '当前组';
    var title = '修复工作台';
    var meta = n.progress || '';
    var issueTotal = (state.issues || []).length;
    var fixableCount = (state.issues || []).filter(function (i) { return i.fixable; }).length;
    var depCount = (state.issues || []).filter(function (i) { return i.source === 'trivy'; }).length;
    var secretCount = (state.issues || []).filter(function (i) { return i.source === 'gitleaks'; }).length;
    var allSuggestions = state.suggestions || [];
    var dupSuggestions = allSuggestions.filter(function (s) { return s.category === 'duplicate'; });
    var manualCount = allSuggestions.filter(function (s) { return s.category === 'manual'; }).length;
    var countSource = function (source) {
      return (state.issues || []).filter(function (i) { return i.source === source; }).length;
    };
    var spotbugsCount = countSource('spotbugs');
    var qcsecCount = countSource('qcsec');
    var staticCount = spotbugsCount + qcsecCount;
    var checkstyleCount = countSource('checkstyle');
    var astgrepCount = countSource('astgrep');
    var skippedItems = (n.plan && n.plan.skipped) || [];
    var policySkipped = skippedItems.filter(function (item) {
      return item.decision === 'policy-denied' || /dependencyManagement|策略未授权/.test(item.reason || '');
    });
    var decisionCount = policySkipped.length;
    var appliedCount = n.plan ? Number(n.plan.appliedCount || 0) : 0;
    var totalCount = n.plan ? Number(n.plan.total || 0) : 0;
    var busy = !!state.scanning || !!state.deepFix;
    // 新扫描回到“总览 → 选路线”；旧计划做了一半则直接留在依赖升级路线，避免丢掉上下文
    var scanKey = (n.scan && n.scan.generatedAt) || (state.finishedAt ? String(state.finishedAt) : '');
    if (scanKey && scanKey !== routeScanKey) {
      routeScanKey = scanKey;
      routePick = '';
    }
    var upgradeFlow = routePick === 'upgrade' || appliedCount > 0;
    if (upgradeFlow) {
      routePick = 'upgrade';
    }
    // 已有计划就只展示当前计划，不再让用户先选一遍“处理路线”；
    // 路线选择只用于“还没有计划”的首屏
    var showChoices = hasData && n.action === 'plan' && !n.plan &&
      (depCount > 0 || fixableCount > 0);
    var hubMode = showChoices && !upgradeFlow;
    if (blankState === 'clean') {
      title = '修复工作台 · 当前无问题';
      meta = '最近一次扫描 0 项问题';
    }
    if (n.action === 'scan' && state.scanning) {
      title = '修复工作台 · 正在扫描';
      meta = '扫描只读执行中';
    }
    if (n.action === 'plan') {
      title = hubMode ? '修复工作台 · 先选处理路线' : '修复工作台';
      meta = hubMode
        ? ''
        : issueTotal + ' 项问题 · 可安全自动修复 ' + fixableCount +
          (decisionCount ? ' · ' + decisionCount + ' 项待决定' : '');
    }
    if ((n.action === 'apply' || n.action === 'confirm') && n.plan) {
      title = hubMode
        ? '修复工作台 · 先选处理路线'
        : (n.plan.state === 'partial' ? '修复工作台 · 计划执行中' : '修复工作台 · 计划已生成');
      if (state.final && !state.final.stale) {
        title = n.plan.state === 'partial' ? '本次修复已收尾 · 剩余组需人工确认' : '本次修复已收尾';
      } else if (state.final && state.final.stale) {
        title = n.plan && n.plan.state === 'partial' ? '当前计划 · 执行中' : '当前计划 · 待执行';
      }
      meta = hubMode
        ? ''
        : '升级计划 ' + n.plan.appliedCount + '/' + n.plan.total +
          (issueTotal ? ' · 当前问题 ' + issueTotal : '') +
          (decisionCount ? ' · ' + decisionCount + ' 项待决定' : '');
    }
    if (hubMode) title = '';
    // 当前计划已有唯一操作入口：扫描总览已经给出 0/60 与 663，不再重复标题行
    if (!hubMode && (n.action === 'apply' || n.action === 'confirm') && n.plan) {
      title = '';
      meta = '';
    }
    var purpose = '';
    if (blankState === 'scan') {
      purpose = state.scanning
        ? '扫描完成后会在这里给出唯一的下一步。'
        : '扫描只读，不改代码；之后的计划与写入都会先预览、再确认。';
    } else if (blankState === 'clean') {
      purpose = '最近一次扫描没有发现问题；改过 pom 或代码后再复扫确认。';
    } else if (state.final && !state.final.stale && (n.action === 'apply' || n.action === 'confirm')) {
      // 最终验收的明细由下方结果卡展示，这里不再重复一遍数字
      purpose = '';
    } else if (state.final && state.final.stale && (n.action === 'apply' || n.action === 'confirm')) {
      // 上一轮已折叠为历史，首屏不再解释两轮关系，避免重复
      purpose = '';
    } else if (n.action === 'plan') {
      purpose = upgradeFlow
        ? '只显示依赖升级相关内容；先看提醒和待决定项，再生成计划。'
        : (hubMode ? '' : '先看总览，再选择从哪条路线开始；依赖升级只生成计划，不改 pom。');
    } else if ((n.action === 'apply' || n.action === 'confirm') && appliedCount === 0) {
      purpose = upgradeFlow
        ? '只显示依赖升级相关计划；先处理提醒和待决定项，再写入 pom。'
        : (hubMode ? '' : '计划已生成但还没写入；先选一条路线，写操作都会先预览。');
    } else if (n.action === 'build') {
      purpose = '升级已写入，编译并运行测试，确认没有破坏现有功能。';
    } else if (n.action === 'explain') {
      purpose = '上一组已写入，但编译或测试没有通过；先看原因，必要时回滚到计划前。';
    } else if (n.action === 'rescan') {
      purpose = '构建已通过，复扫确认目标漏洞是否真的消除。';
    } else if (n.action === 'scan') {
      purpose = '先扫描项目，插件会根据结果给出升级建议。';
    } else if (n.action === 'none') {
      purpose = decisionCount
        ? '直接依赖已处理完；剩下的间接依赖需要你授权后才会写入。'
        : '升级与验证已完成，剩余项按报告人工评估。';
    }
    // 全面修复方案：依赖升级只是其中一节，其余范围同卡展示；明细默认折叠
    var fixPlan = '';
    if (hasData) {
      var planRows = '';
      if (n.plan && n.plan.candidates && n.plan.candidates.length) {
        (n.plan.groups || []).forEach(function (g) {
          var items = (n.plan.candidates || []).filter(function (c) { return c.group === g.name; });
          if (!items.length) return;
          planRows += '<div class="wz-plan-group"><div class="wz-plan-group-title">' +
            esc(g.label) + ' · ' + g.applied + '/' + g.total + ' · ' + items.length + ' 项' +
            (g.state === 'done' ? ' · 已完成' : '') + '</div>';
          items.forEach(function (c) {
            planRows += '<div class="wz-plan-row' + (g.state === 'done' ? ' done' : '') + '">' +
              '<span class="pkg">' + esc(c.packageName) + '</span>' +
              '<span class="ver">' + esc(c.from || '?') + ' → ' + esc(c.to) + '</span>' +
              (c.cveCount ? '<span class="cve">' + c.cveCount + ' 漏洞</span>' : '') +
              '</div>';
          });
        });
      }
      var depBody = planRows;
      if (!depBody) {
        depBody = n.plan
          ? '<div class="wz-fixnote">计划文件里暂无候选明细。</div>'
          : '<div class="wz-fixnote">发现 ' + depCount + ' 条依赖漏洞，尚未生成可回滚计划。</div>';
      }
      if (n.plan && n.plan.skippedCount && !decisionCount) {
        depBody += '<div class="wz-plan-note">另有 ' + n.plan.skippedCount +
          ' 项未纳入：没有同线修复版本或需人工判断，已记录在计划文件。</div>';
      }
      var crossLineCount = n.plan
        ? (n.plan.candidates || []).filter(function (c) { return c.group === 'cross-line'; }).length
        : 0;
      if (n.plan && crossLineCount && n.plan.nextGroup !== 'cross-line') {
        depBody += '<div class="wz-plan-note">另有 ' + crossLineCount +
          ' 项跨大版本待确认：执行到该组前会停下，先确认 JDK / 框架兼容性。</div>';
      }
      // 依赖升级路线只展开依赖计划；代码、密钥、静态留给自动修复 / AI 路线，避免越权混排
      fixPlan = '<details class="wz-fixplan"><summary class="wz-fixplan-head">' +
        '<span class="wz-fixplan-caret" aria-hidden="true"></span><strong>升级计划明细</strong>' +
        '<span class="wz-fixplan-fold"></span>' +
        '<span class="fix-count">' + (n.plan ? n.plan.total + ' 依赖' : depCount + ' 漏洞') +
        (n.plan && n.plan.cveTotal ? ' · ' + n.plan.cveTotal + ' 漏洞' : '') +
        (decisionCount ? ' · ' + decisionCount + ' 待决定' : '') +
        '</span></summary><div class="wz-fixbody">' +
        '<div class="wz-fixsection"><div class="wz-fixsection-head"><span class="fix-tag">依赖升级</span>' +
        '<span class="fix-impact">' + (n.plan
          ? n.plan.total + ' 个依赖 · ' + (n.plan.cveTotal || 0) + ' 漏洞 · ' + n.plan.appliedCount + '/' + n.plan.total
          : depCount + ' 条漏洞 · 未生成计划') + '</span></div>' + depBody + '</div>' +
        '</div></details>';
    }
    var crossLineGroup = n.plan && n.plan.groups
      ? n.plan.groups.filter(function (group) { return group.name === 'cross-line'; })[0]
      : null;
    var crossLineItems = n.plan && n.plan.candidates
      ? n.plan.candidates.filter(function (item) { return item.group === 'cross-line'; })
      : [];
    var finalBlock = '';
    var historyBlock = '';
    if (state.final) {
      var f = state.final;
      // 结果卡只描述 final-report 自己的计划；新计划已生成时不能拿当前计划的 skipped 来凑
      var finalPolicy = (f.planSkipped && f.planSkipped.length
        ? f.planSkipped
        : skippedItems
      ).filter(function (item) {
        return item.decision === 'policy-denied' || /dependencyManagement|策略未授权/.test(item.reason || '');
      });
      var finalCross = f.planCrossLine && f.planCrossLine.length
        ? f.planCrossLine
        : crossLineItems;
      var bySource = f.bySource || {};
      var sourceOrder = [
        { key: 'trivy', label: '依赖漏洞' },
        { key: 'checkstyle', label: '代码质量' },
        { key: 'spotbugs', label: '静态缺陷' },
        { key: 'qcsec', label: '配置安全' },
        { key: 'astgrep', label: '语义规则' },
        { key: 'gitleaks', label: '密钥泄露' }
      ];
      var resultCells = sourceOrder.map(function (source) {
        var item = bySource[source.key];
        var before = item ? Number(item.before || 0) : 0;
        var after = item ? Number(item.after || 0) : 0;
        var change = item ? Number(item.change || 0) : 0;
        if (before === 0 && after === 0) return '';
        return '<div class="wz-result-cell"><span class="label">' + esc(source.label) + '</span>' +
          '<span class="value">' + after + '<span class="delta">' +
          (change < 0 ? ' ↓' + Math.abs(change) : change > 0 ? ' ↑' + change : ' 不变') +
          '</span></span></div>';
      }).filter(Boolean).join('');
      var planLine = f.planId
        ? '计划 ' + (f.planApplied ?? 0) + '/' + (f.planTotal ?? 0)
        : '';
      var buildLine = f.buildOk === true
        ? '构建通过' + (f.tests === 'skipped' ? '（⚠ 跳过测试）' : f.tests === 'executed' ? '（测试已执行）' : '')
        : f.buildOk === false ? '构建未通过' : '';
      var reportOnly = staticCount + secretCount + astgrepCount + checkstyleCount;
      // 密钥永远不交给 AI 自动改；其余只报告项可以给“尝试生成 diff”的入口
      var attemptCount = staticCount + astgrepCount + checkstyleCount;
      var policyRows = policySkipped.slice(0, 4).map(function (item) {
        return '<div class="wz-result-item"><span class="pkg">' + esc(item.packageName) + '</span>' +
          '<span class="ver">' + esc(item.installedVersion || '?') + ' → ' + esc(item.fixedVersion || '?') + '</span></div>';
      }).join('');
      var crossRows = finalCross.slice(0, 4).map(function (item) {
        return '<div class="wz-result-item"><span class="pkg">' + esc(item.packageName) + '</span>' +
          '<span class="ver">' + esc(item.from || '?') + ' → ' + esc(item.to) + '</span></div>';
      }).join('');
      var reportRows = [];
      if (spotbugsCount) reportRows.push('SpotBugs ' + spotbugsCount + '：多数是编码/防御性规范，不是业务语义；可让 AI 逐条给 diff，确认后再改');
      if (qcsecCount) reportRows.push('配置安全 ' + qcsecCount + '：暴露面与凭证策略要按部署环境决定');
      if (astgrepCount) reportRows.push('AST ' + astgrepCount + '：权限模型、输入校验、安全设计要业务判断');
      if (secretCount) reportRows.push('密钥 ' + secretCount + '：AI 不读原值，先轮换再改配置引用');
      if (checkstyleCount) reportRows.push('代码质量 ' + checkstyleCount + '：未命中确定性修复清单，需人工复核');
      var nextText = '';
      if (finalPolicy.length && finalCross.length) {
        nextText = '先按项授权间接依赖，再确认跨大版本；两步都不跳过。';
      } else if (finalPolicy.length) {
        nextText = '先处理待授权间接依赖；授权后重新生成计划，不手改 pom。';
      } else if (finalCross.length) {
        nextText = '只剩跨大版本：确认兼容后显式允许写入，或把它留到下一轮。';
      } else if (reportOnly) {
        nextText = '剩余是需人工判断的静态/安全项：可复制给 AI 按范围修，或手动逐项处理。';
      } else {
        nextText = '已无自动写入项；复扫验收后即可收尾。';
      }
      if (f.stale) {
        nextText = '这是上一轮结果；当前已有新计划，请按下方工作台继续。上一轮剩余项仍可复制给 AI 或手动处理。';
      }
      var resultActions = '';
      // 结果卡只保留一个主操作：AI 修复剩余项；授权/跨版本说明降为对应行内的小入口。
      if (!f.stale && (finalPolicy.length || finalCross.length || attemptCount)) {
        resultActions += '<button class="wz-result-btn wz-result-primary" data-wz="copyRemaining">AI 修复剩余项</button>';
      }
      resultActions += '<button class="wz-result-btn" data-wz="openFinalReport">查看最终报告</button>' +
        '<button class="wz-result-btn" data-wz="focusIssues">手动逐项处理</button>';
      var resultRows = '';
      if (finalPolicy.length) {
        resultRows += '<div class="wz-result-row"><div class="wz-result-row-head">' +
          '<strong>待授权 · ' + finalPolicy.length + ' 项间接依赖</strong><span class="wz-result-tag">不会自动改</span></div>' +
          '<div class="wz-result-why">由其他依赖带入，当前策略未授权写 dependencyManagement；不授权就只能保留这些 CVE。授权只写版本锁定，不改业务代码。' +
          '<button class="wz-result-btn wz-result-inline" data-wz="openPolicy">逐项授权</button></div>' +
          '<div class="wz-result-list">' + policyRows + '</div>' +
          (finalPolicy.length > 4 ? '<div class="wz-result-more">另有 ' + (finalPolicy.length - 4) + ' 项在授权预览里逐项勾选。</div>' : '') +
          '</div>';
      }
      if (finalCross.length) {
        resultRows += '<div class="wz-result-row"><div class="wz-result-row-head">' +
          '<strong>跨大版本 · ' + finalCross.length + ' 项</strong><span class="wz-result-tag">需你确认</span></div>' +
          '<div class="wz-result-why">升级会改变 API、驱动协议或依赖基线；插件默认不写，避免一升就炸。先确认 JDK / 框架兼容性，再显式允许。' +
          '<button class="wz-result-btn wz-result-inline" data-wz="openHandoff">查看说明</button></div>' +
          '<div class="wz-result-list">' + crossRows + '</div>' +
          (finalCross.length > 4 ? '<div class="wz-result-more">另有 ' + (finalCross.length - 4) + ' 项，见升级计划明细。</div>' : '') +
          '</div>';
      }
      if (reportOnly) {
        resultRows += '<div class="wz-result-row"><div class="wz-result-row-head">' +
          '<strong>剩余 · ' + reportOnly + ' 项（' + spotbugsCount + ' 可 AI 尝试，' +
          Math.max(0, reportOnly - spotbugsCount) + ' 需人工）</strong><span class="wz-result-tag info">按边界保留</span></div>' +
          '<div class="wz-result-why">这些不是“漏修”，是 AI 按可逆小改边界主动留下的；SpotBugs 多数是编码/防御性规范，不是业务语义，可让 AI 逐条给 diff。配置安全、AST 与密钥仍需人工判断。手动：按来源筛选问题，打开文件行修改；密钥先轮换再改引用。' +
          '<button class="wz-result-btn wz-result-inline" data-wz="copyReportOnly">尝试修复只报告项</button></div>' +
          '<div class="wz-result-list">' + reportRows.map(function (line) {
            return '<div class="wz-result-why">· ' + esc(line) + '</div>';
          }).join('') + '</div></div>';
      }
      var staleNote = f.stale
        ? (f.staleReason === 'new-plan'
            ? '这是计划 ' + esc(f.planId || '—') + ' 的收尾结果；当前已生成新计划 ' + esc(f.currentPlanId || '—') + '，下面数字只代表上一轮。'
            : '这是上一轮收尾结果；之后又扫过一次，当前账本已更新，下面数字只代表上一轮。')
        : '';
      var scanNote = state.scanning
        ? '<div class="wz-result-stale">正在重新扫描：下面仍是上一轮结果，扫描完成后面板会自动刷新；现在不要把 ' +
          f.currentTotal + ' 当作最新结论。</div>'
        : '';
      finalBlock = '<div class="wz-result">' +
        '<div class="wz-result-head"><strong>' +
        (f.stale ? (state.scanning ? '上一轮修复结果（重扫中）' : '上一轮修复结果') : '本次修复结果') + '</strong>' +
        '<span class="wz-result-sum">' + f.baselineTotal + ' → ' + f.currentTotal + ' · ' +
        (f.totalChange >= 0 ? '+' : '') + f.totalChange + '</span></div>' +
        scanNote +
        (staleNote ? '<div class="wz-result-stale">' + staleNote + '</div>' : '') +
        '<div class="wz-result-why">消失 ' + f.removed + ' / 新增 ' + f.added +
        (planLine ? ' · ' + planLine : '') + (buildLine ? ' · ' + buildLine : '') + '</div>' +
        (resultCells ? '<div class="wz-result-grid">' + resultCells + '</div>' : '') +
        (f.newlyVisible && f.newlyVisible.length ? '<div class="wz-result-why">首次可见（不是回归）：' + esc(f.newlyVisible.join(', ')) + '</div>' : '') +
        resultRows +
        '<div class="wz-result-row wz-result-next"><div class="wz-result-row-head"><strong>下一步怎么做</strong></div>' +
        '<div class="wz-result-why">' + esc(nextText) + '</div>' +
        '<div class="wz-result-why">AI 继续修：点「复制剩余项给 AI」，提示里已带上可写范围、构建门禁和不可越过的阻塞。</div>' +
        '<div class="wz-result-why">手动修复：点「手动逐项处理」按来源筛选，代码/配置问题直接打开文件和行；密钥先轮换再改引用。</div>' +
        '</div>' +
        '<div class="wz-result-actions">' + resultActions + '</div>' +
        '</div>';
      // 上一轮结果默认折叠并沉到底部：当前计划占首屏，历史只在需要时展开
      if (f.stale) {
        historyBlock = '<details class="wz-result-history">' +
          '<summary><span>上一轮修复结果 · ' + f.baselineTotal + ' → ' + f.currentTotal +
          (f.planId ? ' · 计划 ' + (f.planApplied ?? 0) + '/' + (f.planTotal ?? 0) : '') +
          '</span><span class="wz-history-note">已生效，非当前' +
          (state.scanning ? ' · 重扫中' : '') + '</span></summary>' +
          '<div class="wz-result-history-tools">' +
          btn('openFinalReport', '查看修复报告', false, 'wz-result-btn') +
          '</div>' +
          finalBlock + '</details>';
        finalBlock = '';
      }
    }
    var overview = '';
    if (hasData) {
      var overviewCells = [
        { label: '依赖升级', value: (n.plan ? totalCount : depCount), unit: '项', title: '待升级的依赖数，不是下方依赖漏洞的 CVE 条数' },
        { label: '可自动修复', value: fixableCount, unit: '项', title: '跨来源的确定性修复条数，与代码质量有重叠，不是独立分类' },
        { label: '代码质量+语义', value: checkstyleCount + astgrepCount, unit: '项', title: 'Checkstyle ' + checkstyleCount + ' + AST 语义规则 ' + astgrepCount },
        { label: '静态+配置', value: staticCount, unit: '项', title: 'SpotBugs ' + spotbugsCount + ' + 配置安全 ' + qcsecCount },
        { label: '硬编码密钥', value: secretCount, unit: '处', title: 'Gitleaks 命中数；一处密钥可能跨多行' },
        { label: hubMode ? '人工判断' : '待决定', value: hubMode ? manualCount : decisionCount, unit: hubMode ? '条' : '项', title: hubMode ? '来自修复建议的人工判断项' : '需要你授权的间接依赖项' }
      ].filter(function (cell) { return cell.value > 0; }).map(function (cell) {
        return '<div class="wz-overview-cell"' + (cell.title ? ' title="' + esc(cell.title) + '"' : '') +
          '><span class="label">' + esc(cell.label) +
          '</span><span class="value">' + esc(String(cell.value)) + ' ' + esc(cell.unit) + '</span></div>';
      }).join('');
      var overviewNotes = [];
      if (n.plan && totalCount && n.plan.cveTotal) {
        overviewNotes.push(totalCount + ' 个依赖覆盖 ' + n.plan.cveTotal + ' 条 CVE');
      }
      if (fixableCount) {
        overviewNotes.push(fixableCount + ' 项可安全自动修复');
      }
      if (decisionCount && !hubMode) {
        overviewNotes.push(decisionCount + ' 项间接依赖待你授权');
      }
      overview = '<div class="wz-overview"><div class="wz-overview-head"><strong>扫描结果总览</strong>' +
        '<span class="head-right"><span>' + issueTotal + ' 项问题</span>' +
        '<button class="wz-report-link" data-msg="openReport" title="在编辑器页签打开本次扫描报告">查看报告</button></span></div>' +
        (overviewCells ? '<div class="wz-overview-grid">' + overviewCells + '</div>' : '') +
        (overviewNotes.length ? '<div class="wz-overview-note">' + esc(overviewNotes.join(' · ')) + '</div>' : '') +
        '</div>';
    }
    var emptyBody = '';
    if (blankState === 'scan') {
      emptyBody = '<div class="wz-empty">' +
        (state.scanning
          ? '已开始扫描；完成后自动刷新，不需要重复点击。'
          : '<div class="wz-empty-step">1. 扫描：只读检查依赖、代码、密钥与静态缺陷</div>' +
            '<div class="wz-empty-step">2. 计划：先看升什么、升到哪、pom.diff</div>' +
            '<div class="wz-empty-step">3. 执行：按组写 pom 并编译，失败可回滚</div>') +
        '</div>';
    } else if (blankState === 'clean') {
      emptyBody = '<div class="wz-empty">没有待修复项，不需要生成计划；改过依赖或代码后再复扫，避免拿旧结果决策。</div>';
    }
    function buildGate(includeDependency) {
      var out = '';
      var policyBlocked = (n.blockers || []).some(function (b) { return b.code === 'policy-blocked'; });
      var globalBlocks = { 'build-failed': 1, 'pom-drift': 1, 'mvn-missing': 1 };
      (n.blockers || []).slice(0, 2).forEach(function (b) {
        if (!includeDependency && !globalBlocks[b.code]) return;
        var blockTitle = ({
          'build-failed': '构建未通过',
          'pom-drift': 'pom 已偏离计划',
          'policy-blocked': '需要授权才能继续',
          'mvn-missing': '缺少 Maven',
          'empty-plan': '计划为空',
          'cross-line-confirm': '跨大版本需确认'
        })[b.code] || '当前不能继续';
        var blockTip = b.suggestion;
        if (b.code === 'policy-blocked' && n.plan &&
          Number(n.plan.appliedCount || 0) >= Number(n.plan.total || 0)) {
          blockTip = '直接依赖已处理完；在待决定项里按项授权，或接受剩余风险。';
        }
        out += '<div class="wz-gate block"><div class="wz-gate-head">阻塞 · ' + esc(blockTitle) + '</div>' +
          '<div class="wz-gate-msg">' + esc(b.message) + '</div>' +
          (blockTip ? '<div class="wz-gate-tip">建议：' + esc(blockTip) + '</div>' : '') +
          '</div>';
      });
      (n.warnings || []).slice(0, 2).forEach(function (w) {
        if (!includeDependency && w.code === 'property-override') return;
        var warnTitle = ({
          'property-override': '属性会覆盖框架版本',
          'revert-scope': '回滚范围',
          'baseline-build-failed': '基线构建未通过'
        })[w.code] || '注意';
        out += '<div class="wz-gate warn"><div class="wz-gate-head">注意 · ' + esc(warnTitle) + '</div>' +
          '<div class="wz-gate-msg">' + esc(w.message) + '</div>' +
          (w.suggestion ? '<div class="wz-gate-tip">建议：' + esc(w.suggestion) + '</div>' : '') +
          '</div>';
      });
      if (includeDependency && decisionCount && !policyBlocked) {
        out += '<div class="wz-gate warn"><div class="wz-gate-head">需要你决定 · ' + decisionCount + ' 项间接依赖</div>' +
          '<div class="wz-gate-msg">这些包由其他依赖间接带入；当前策略只允许直接依赖升级。</div>' +
          '<div class="wz-gate-tip">打开预览后可逐项授权，只写版本锁定，不手改 pom。</div></div>';
      }
      return out;
    }
    var gate = buildGate(upgradeFlow || !hubMode);
    var lockNote = busy
      ? '<div class="wz-lock">' + (state.scanning
        ? '扫描正在执行，修改类操作暂不可用；完成后自动恢复。'
        : '修复正在执行，修改类操作暂不可用；完成后自动恢复。') + '</div>'
      : '';
    var writeKeys = {
      scan: 1, createPlan: 1, upgradeNext: 1, buildGate: 1, revertPlan: 1,
      fixAll: 1, deepFix: 1, upgradeDeps: 1, openPolicy: 1, 'install-mvn': 1
    };
    function btn(key, text, primary, extraClass, disabled) {
      var cls = primary ? 'wz-primary' : 'secondary';
      if (extraClass) {
        cls += ' ' + extraClass;
      }
      return '<button class="' + cls + '"' + (disabled || (busy && writeKeys[key]) ? ' disabled' : '') +
        ' data-wz="' + key + '">' + esc(text) + '</button>';
    }
    var scopeBar = '';
    if (hasData) {
      // 范围选择决定“允许 AI 碰哪些类别”；这里再把类别里的真实可执行量拆开，避免全选被当成全修
      var staticAutoCount = (state.issues || []).filter(function (item) {
        return (item.source === 'spotbugs' || item.source === 'qcsec') && item.fixable;
      }).length;
      var upgradeAutoCount = n.plan
        ? Math.max(0, totalCount - crossLineItems.length)
        : (depCount ? 1 : 0);
      scopeStats = {
        upgrade: {
          count: n.plan ? totalCount : (depCount ? 1 : 0),
          auto: upgradeAutoCount,
          confirm: crossLineItems.length,
          report: 0,
          auth: policySkipped.length
        },
        consolidation: { count: dupSuggestions.length, auto: 0, confirm: dupSuggestions.length, report: 0, auth: 0 },
        code: { count: checkstyleCount + astgrepCount, auto: checkstyleCount, confirm: 0, report: astgrepCount, auth: 0 },
        secrets: { count: secretCount, auto: 0, confirm: 0, report: secretCount, auth: 0 },
        static: {
          count: staticCount,
          auto: staticAutoCount,
          confirm: qcsecCount,
          ai: spotbugsCount,
          report: 0,
          auth: 0
        }
      };
      var scopeOptions = [
        {
          key: 'upgrade', label: '依赖升级',
          detail: '可自动 ' + scopeStats.upgrade.auto + ' · 跨版本 ' + scopeStats.upgrade.confirm +
            (scopeStats.upgrade.auth ? ' · 待授权 ' + scopeStats.upgrade.auth : '')
        },
        { key: 'consolidation', label: '依赖收敛', detail: '需确认 ' + scopeStats.consolidation.confirm },
        { key: 'code', label: '代码质量', detail: '可自动 ' + scopeStats.code.auto + ' · 只报告 ' + scopeStats.code.report },
        { key: 'secrets', label: '密钥', detail: '只报告 ' + scopeStats.secrets.report + '（先轮换）' },
        { key: 'static', label: '静态缺陷', detail:
          (scopeStats.static.auto ? '可自动 ' + scopeStats.static.auto + ' · ' : '') +
          'AI 可试 ' + scopeStats.static.ai + ' · 待确认 ' + scopeStats.static.confirm }
      ];
      var validPick = scopeOptions.filter(function (o) { return scopeStats[o.key].count > 0 && scopePick.indexOf(o.key) >= 0; });
      var availableCount = scopeOptions.filter(function (o) { return scopeStats[o.key].count > 0; }).length;
      var initialTotals = scopeTotals(validPick.map(function (o) { return o.key; }));
      var pickText = validPick.length === availableCount
        ? '全部 ' + availableCount + ' 类'
        : validPick.length ? '已选 ' + validPick.length + ' 类' : '未选择';
      var checks = scopeOptions.map(function (o) {
        var count = scopeStats[o.key].count;
        return '<label class="wz-scope-option"><input type="checkbox" data-scope-pick="' + o.key + '"' +
          (scopePick.indexOf(o.key) >= 0 && count > 0 ? ' checked' : '') +
          (count ? '' : ' disabled') + '>' +
          esc(o.label) + '<span class="fix-impact">' + count + '</span>' +
          '<span class="wz-scope-detail">' + esc(o.detail) + '</span></label>';
      }).join('');
      var severityOptions = [
        { key: 'info', label: '全部' },
        { key: 'low', label: '≥ 低危' },
        { key: 'medium', label: '≥ 中危' },
        { key: 'high', label: '≥ 高危' }
      ];
      var severitySelect = '<label class="wz-sev" title="AI 只处理该严重度及以上，低于该等级只报告">' +
        '<span>严重度</span><select id="sevPick">' +
        severityOptions.map(function (o) {
          return '<option value="' + o.key + '"' + (severityPick === o.key ? ' selected' : '') + '>' + esc(o.label) + '</option>';
        }).join('') +
        '</select></label>';
      scopeBar = '<div class="wz-ai"><div class="wz-scope-row">' +
        '<button id="scopeCopyBtn" class="wz-scope-run" data-wz="copyScopes"' +
        (validPick.length && (initialTotals.auto || initialTotals.ai) ? '' : ' disabled') +
        ' title="' + esc(initialTotals.auto || initialTotals.ai
          ? '按当前范围给 AI：' + (initialTotals.auto ? '预计自动写入 ' + initialTotals.auto + ' 项；' : '') +
            (initialTotals.ai ? '静态缺陷可逐条尝试，AI 先给 diff，确认后才写入；' : '') +
            initialTotals.confirm + ' 项需确认，' + initialTotals.report + ' 项只报告' +
            (initialTotals.auth ? '，另有 ' + initialTotals.auth + ' 项待授权' : '')
          : '当前范围没有可自动写入项；密钥只能报告位置，需先人工轮换') + '">AI 处理已选范围</button>' +
        '<details class="wz-scope-picker"><summary><span class="pick-label">范围</span>' +
        '<span id="scopePickSummary">' + pickText + '</span>' +
        '<span class="wz-scope-caret" aria-hidden="true"></span></summary>' +
        '<div class="wz-scope-menu">' + checks + '</div></details>' +
        severitySelect +
        '</div>' +
        '<div class="wz-scope-truth" id="scopeTruth">' +
        scopeTruthText(validPick.map(function (o) { return o.key; })) + '</div>' +
        '<div class="wz-scope-note">需确认项不会直接写入：AI 先给方案或 diff，等你确认后继续执行；密钥只报告。</div></div>';
    }
    var primary = '';
    var primaryHint = '';
    var secondary = [];
    function addRevert() {
      if (appliedCount > 0) {
        secondary.push(btn('revertPlan', '回滚到计划前', false, 'danger'));
      }
    }
    var nextCount = n.plan && n.plan.nextGroup
      ? (n.plan.candidates || []).filter(function (item) { return item.group === n.plan.nextGroup; }).length
      : 0;
    switch (n.action) {
      case 'scan':
        primary = btn('scan', state.scanning ? '正在扫描…' : '开始扫描', true);
        primaryHint = '只读扫描，不改代码；完成后给出唯一的下一步。';
        break;
      case 'plan':
        if (depCount) {
          primary = btn('createPlan', '生成升级计划', true);
          primaryHint = '只生成计划文件，不改 pom；生成后按组确认执行。';
        } else if (fixableCount) {
          primary = btn('fixAll', '安全自动修复 ' + fixableCount + ' 项', true);
          primaryHint = '只处理无用导入、冗余导入、修饰符顺序、布尔表达式等确定性问题。';
        } else {
          primary = btn('scan', '重新扫描', true);
        }
        break;
      case 'apply':
      case 'confirm':
        if (state.final && !state.final.stale) {
          if (decisionCount) {
            primary = btn('openPolicy', '先处理待授权 ' + decisionCount + ' 项', true);
            primaryHint = '这些间接依赖不会自动写；按项授权后才重新生成计划。跨大版本留到下一步确认。';
          } else if (n.plan && n.plan.nextGroup === 'cross-line') {
            primary = btn('openHandoff', '确认跨大版本方案', true);
            primaryHint = '跨大版本默认不写；交接文件里有范围、版本与需要确认的兼容性问题。';
          } else if (reportOnly) {
            primary = btn('copyRemaining', '让 AI 继续修剩余项', true);
            primaryHint = '复制已限定的续跑提示：只做可逆小改，构建门禁和阻塞边界都在里面。';
          } else {
            primary = btn('upgradeNext', '继续升级：' + label + (nextCount ? ' ' + nextCount + ' 项' : ''), true);
            primaryHint = '写 pom 后自动编译；失败只停在当前组，可回滚。';
          }
        } else {
          primary = btn('upgradeNext', '继续升级：' + label + (nextCount ? ' ' + nextCount + ' 项' : ''), true);
          primaryHint = '写 pom 后自动编译；失败只停在当前组，可回滚。';
        }
        addRevert();
        break;
      case 'build':
        primary = btn('buildGate', '编译并测试', true);
        primaryHint = '上一组已写入；验证通过后才进入下一组。';
        addRevert();
        break;
      case 'explain':
        primary = btn('explainBuild', '查看失败原因', true);
        primaryHint = '先定位这一组的问题，避免把失败带到下一组。';
        addRevert();
        break;
      case 'rescan':
        primary = btn('scan', '复扫验收', true);
        primaryHint = '确认目标漏洞是否真的消失，再决定下一轮。';
        addRevert();
        secondary.push(btn('openHandoff', '查看交接文件'));
        break;
      case 'install':
        primary = btn('install-mvn', '安装 Maven', true);
        primaryHint = '安装后才能生成计划和执行编译门禁。';
        break;
      case 'revert':
        primary = btn('revertPlan', '回滚到计划前', true);
        primaryHint = '撤销本次计划写入的 pom 改动，代码保持当前工作区状态。';
        break;
      case 'none':
        if (decisionCount) {
          primary = btn('copyRemaining', 'AI 处理待确认 ' + decisionCount + ' 项', true);
          primaryHint = '先让 AI 查引入路径并给升级/排除/迁移方案，用户确认后才写入；不再先跳授权页。';
        } else if (state.final && reportOnly) {
          primary = btn('copyRemaining', '让 AI 继续修剩余项', true);
          primaryHint = '复制剩余项与边界；AI 只做可逆小改，超出范围的继续列人工。';
        } else {
          primary = btn('scan', '重新扫描验收', true);
          primaryHint = '升级与验证已完成；复扫确认剩余项，再人工评估。';
        }
        addRevert();
        secondary.push(btn('openHandoff', '查看交接文件'));
        break;
      default:
        primary = btn('openHandoff', '打开交接', true);
        break;
    }
    var choiceHub = '';
    if (hubMode) {
      var hasDepChoice = depCount > 0 || (n.plan && totalCount > 0);
      var depNote = n.plan
        ? (n.plan.cveTotal ? n.plan.cveTotal + ' 条 CVE · ' : '') + '先看计划与待决定项，再按组写入'
        : depCount + ' 条依赖漏洞 · 只生成计划，不改 pom';
      var depCard = hasDepChoice
        ? '<div class="wz-choice"><div class="wz-choice-title"><span>升级依赖</span>' +
          '<span class="wz-choice-count">' + (n.plan ? totalCount : depCount) + ' 项</span></div>' +
          '<div class="wz-choice-note">' + esc(depNote) + '</div>' +
          btn('chooseUpgrade', '查看升级方案', false, 'wz-choice-btn') + '</div>'
        : '';
      var fixCard = fixableCount
        ? '<div class="wz-choice"><div class="wz-choice-title"><span>自动修复</span>' +
          '<span class="wz-choice-count">' + fixableCount + ' 项</span></div>' +
          '<div class="wz-choice-note">只改确定性问题，逐行 diff 预览；不改 pom。</div>' +
          btn('fixAll', '安全修复 ' + fixableCount, false, 'wz-choice-btn') + '</div>'
        : '';
      var allCard = depCount
        ? '<div class="wz-choice risk"><div class="wz-choice-title"><span>全部依赖</span>' +
          '<span class="wz-choice-tag risk">高风险</span>' +
          '<span class="wz-choice-count">' + (n.plan ? totalCount : depCount) + ' 项</span></div>' +
          '<div class="wz-choice-note">全部一次升级；不分组编译，失败难定位，跨大版本会跳过。</div>' +
          btn('upgradeDeps', '全部升级 ' + (n.plan ? totalCount : depCount) + ' 项', false, 'wz-choice-btn') +
          '</div>'
        : '';
      var aiFirstBlock = scopeBar
        .replace('<div class="wz-ai">', '<div class="wz-ai wz-ai-first">');
      choiceHub = '<div class="wz-choices">' + aiFirstBlock +
        '<div class="wz-choice-grid">' + depCard + fixCard + allCard + '</div>' +
        '</div>';
    }
    var routeHead = '';
    if (upgradeFlow) {
      routeHead = '<div class="wz-route-head"><div><strong>依赖升级</strong>' +
        '<span>只显示依赖计划、提醒和待决定项</span></div>' +
        (appliedCount === 0 ? btn('showRoutes', '更换处理方式', false, 'wz-route-back') : '') +
        '</div>';
    }
    if (crossLineCount && n.plan && n.plan.nextGroup !== 'cross-line' && primaryHint) {
      primaryHint += ' 另有 ' + crossLineCount + ' 项跨大版本待确认，执行到该组前会停。';
    }
    // 当前计划把 AI 范围处理作为主入口；手动写入降为“其他操作”，不再抢蓝色主按钮
    var manualHint = '';
    if ((n.action === 'apply' || n.action === 'confirm') && n.plan) {
      manualHint = primaryHint;
      var manualKey = decisionCount ? 'openPolicy'
        : (n.plan.nextGroup === 'cross-line' ? 'openHandoff' : 'upgradeNext');
      var manualText = decisionCount ? '手动处理待授权 ' + decisionCount + ' 项'
        : (n.plan.nextGroup === 'cross-line' ? '手动确认跨大版本方案'
          : '手动继续升级' + (label ? '：' + label : '') + (nextCount ? ' ' + nextCount + ' 项' : ''));
      secondary.unshift(btn(manualKey, manualText, false));
      primary = '';
      primaryHint = '';
    }
    var primaryRow = primary
      ? '<div class="wz-primary-row">' + primary +
        (primaryHint ? '<div class="wz-primary-hint">' + esc(primaryHint) + '</div>' : '') + '</div>'
      : '';
    var hasWriteSecondary = appliedCount > 0;
    var secondaryNote = [manualHint, hasWriteSecondary ? '修改类操作会先打开预览，确认后才写入；失败可回滚。' : '']
      .filter(function (line) { return !!line; }).join(' ');
    var secondaryRow = secondary.length
      ? '<div class="wz-section-label">' + (upgradeFlow ? '当前计划的其他操作' : '其他操作') +
        '</div><div class="wz-secondary">' + secondary.join('') + '</div>' +
        (secondaryNote ? '<div class="wz-secondary-hint">' + esc(secondaryNote) + '</div>' : '')
      : '';
    var aiScopeBlock = !hubMode && hasData && scopeBar
      ? '<div class="wz-section-label">AI 处理 · 先选范围</div>' +
        scopeBar.replace('<div class="wz-ai">', '<div class="wz-ai wz-ai-primary">')
      : '';
    var deep = state.deepScan;
    var deepHint = '';
    var deepAction = btn('deepScan', '建议深度扫描', false);
    if (deep && deep.status === 'running') {
      deepHint = '正在运行 OpenRewrite dry-run，只生成 diff，不改源码…';
      deepAction = btn('deepScan', '预演中', false, '', true);
    } else if (deep && deep.status === 'done') {
      deepHint = 'OpenRewrite 预演发现 ' + deep.files + ' 个文件可改；打开预览后可逐文件勾选。';
      deepAction = btn('deepFix', '打开深度预览', false);
    } else if (deep && deep.status === 'empty') {
      deepHint = 'OpenRewrite 预演没有发现可改文件，当前代码已符合已启用配方。';
      deepAction = btn('deepScan', '重新预演', false);
    } else if (deep && deep.status === 'failed') {
      deepHint = '深度预演失败，详见输出日志；普通扫描结果不受影响。';
      deepAction = btn('deepScan', '重试预演', false);
    } else if (deep && deep.status === 'unavailable') {
      deepHint = '当前项目没有可用配方，或深度重构已在设置中关闭。';
      deepAction = '';
    }
    var deepBlock = hubMode
      ? '<div class="wz-deep"><div><strong>深度重构（OpenRewrite）</strong><small>' +
        (deepHint || '普通扫描不含结构重构；建议单独预演一次，只生成 diff，确认后才写入。') +
        '</small></div>' + deepAction + '</div>'
      : '';
    el.innerHTML = (title ? '<div class="wz-title">' + esc(title) + '</div>' : '')
      + (meta ? '<div class="wz-meta">' + esc(meta) + '</div>' : '')
      + overview
      + (purpose ? '<div class="wz-purpose">' + esc(purpose) + '</div>' : '')
      + finalBlock
      + routeHead + gate + emptyBody + lockNote
      + (hubMode ? choiceHub : primaryRow + aiScopeBlock + secondaryRow)
      + (upgradeFlow ? fixPlan : '')
      + deepBlock
      + historyBlock;
    var severitySelectEl = el.querySelector('#sevPick');
    if (severitySelectEl) {
      severitySelectEl.addEventListener('change', function () {
        severityPick = severitySelectEl.value;
      });
    }
    var reportLinkEl = el.querySelector('[data-msg="openReport"]');
    if (reportLinkEl) {
      reportLinkEl.addEventListener('click', function () {
        vscode.postMessage({ type: 'openReport' });
      });
    }
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

  /** 按当前范围汇总真实可执行量：自动写入 / 需确认 / 只报告 / 待授权 */
  function scopeTotals(picked) {
    var out = { count: 0, auto: 0, confirm: 0, ai: 0, report: 0, auth: 0 };
    (picked || []).forEach(function (key) {
      var item = scopeStats[key];
      if (!item) return;
      out.count += Number(item.count || 0);
      out.auto += Number(item.auto || 0);
      out.confirm += Number(item.confirm || 0);
      out.ai += Number(item.ai || 0);
      out.report += Number(item.report || 0);
      out.auth += Number(item.auth || 0);
    });
    return out;
  }

  function scopeTruthText(picked) {
    var t = scopeTotals(picked);
    if (!picked || !picked.length) return '未选择类别';
    return '已选 <strong>' + t.count + '</strong> 项：自动 <strong>' + t.auto + '</strong>' +
      ' · 需确认 <strong>' + t.confirm + '</strong>' +
      (t.ai ? ' · AI 可试 <strong>' + t.ai + '</strong>' : '') +
      ' · 只报告 <strong>' + t.report + '</strong>' +
      (t.auth ? ' · 另有 <strong>' + t.auth + '</strong> 项待授权' : '');
  }

  function updateScopePickerUI() {
    var el = document.getElementById('wizard');
    if (!el) return;
    var boxes = Array.prototype.slice.call(el.querySelectorAll('[data-scope-pick]'));
    var available = boxes.filter(function (box) { return !box.disabled; });
    var picked = available.filter(function (box) { return box.checked; }).map(function (box) {
      return box.getAttribute('data-scope-pick');
    });
    scopePick = picked;
    var totals = scopeTotals(picked);
    var summary = document.getElementById('scopePickSummary');
    if (summary) {
      summary.textContent = picked.length === available.length
        ? '全部 ' + available.length + ' 类'
        : picked.length ? '已选 ' + picked.length + ' 类' : '未选择';
    }
    var truth = document.getElementById('scopeTruth');
    if (truth) truth.innerHTML = scopeTruthText(picked);
    var copyBtn = document.getElementById('scopeCopyBtn');
    if (copyBtn) {
      copyBtn.disabled = picked.length === 0 || (totals.auto === 0 && totals.ai === 0);
      copyBtn.title = (totals.auto || totals.ai)
        ? '按当前范围给 AI：' + (totals.auto ? '预计自动写入 ' + totals.auto + ' 项；' : '') +
          (totals.ai ? '静态缺陷可逐条尝试，AI 先给 diff，确认后才写入；' : '') +
          totals.confirm + ' 项需确认，' + totals.report + ' 项只报告' +
          (totals.auth ? '，另有 ' + totals.auth + ' 项待授权' : '')
        : '当前范围没有可自动写入项；密钥只能报告位置，需先人工轮换';
    }
  }

  function handleWizardAction(key) {
    if (!key) return;
    if (key === 'chooseUpgrade') {
      vscode.postMessage({ type: 'upgradeDeps' });
    } else if (key === 'showRoutes') {
      var plan = state.next && state.next.plan;
      if (!plan || Number(plan.appliedCount || 0) === 0) {
        routePick = '';
        renderWizard();
      }
    } else if (key === 'scan') {
      vscode.postMessage({ type: 'scan' });
    } else if (key === 'copyScopes') {
      updateScopePickerUI();
      vscode.postMessage({ type: 'copyScopes', scopes: scopePick.slice(), minSeverity: severityPick });
    } else if (key === 'copyReportOnly') {
      vscode.postMessage({ type: 'copyReportOnly' });
    } else if (key.indexOf('copyScope:') === 0) {
      vscode.postMessage({ type: 'copyScope', scope: key.slice('copyScope:'.length) });
    } else if (key === 'fixAll') {
      vscode.postMessage({ type: 'fixAll' });
    } else if (key === 'deepFix') {
      vscode.postMessage({ type: 'deepFix' });
    } else if (key === 'deepScan') {
      vscode.postMessage({ type: 'deepScan' });
    } else if (key === 'upgradeDeps') {
      vscode.postMessage({ type: 'upgradeDeps' });
    } else if (key === 'createPlan') {
      routePick = 'upgrade';
      vscode.postMessage({ type: 'createUpgradePlan' });
    } else if (key === 'upgradeNext') {
      routePick = 'upgrade';
      vscode.postMessage({ type: 'upgradeNext' });
    } else if (key === 'openPolicy') {
      routePick = 'upgrade';
      vscode.postMessage({ type: 'openPolicyPreview' });
    } else if (key === 'buildGate') {
      vscode.postMessage({ type: 'buildGate' });
    } else if (key === 'explainBuild') {
      vscode.postMessage({ type: 'explainBuild' });
    } else if (key === 'revertPlan') {
      vscode.postMessage({ type: 'revertPlan' });
    } else if (key === 'openHandoff') {
      vscode.postMessage({ type: 'openHandoff' });
    } else if (key === 'copyRemaining') {
      vscode.postMessage({ type: 'copyRemaining' });
    } else if (key === 'openFinalReport') {
      vscode.postMessage({ type: 'openFinalReport' });
    } else if (key === 'focusIssues') {
      var list = document.getElementById('list');
      if (list) {
        list.scrollIntoView({ behavior: 'smooth', block: 'start' });
        list.classList.add('flash');
        setTimeout(function () { list.classList.remove('flash'); }, 900);
      }
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
    renderProjects();
    renderMcp();
    renderAiStatus();
    updateTabs();
    renderWizard();
    var deep = state.deepFix;
    var runBusy = !!state.run && state.run.status === 'running' &&
      (!state.run.updatedAt || Date.now() - Date.parse(state.run.updatedAt) < 30 * 60 * 1000);
    // AI 执行只锁操作，不驱动猫咪进度条：进度条只跟随面板扫描/深度修复，避免 run-state 抖动导致面板闪烁
    var progressBusy = !!state.scanning || !!deep;
    var busy = progressBusy || runBusy;
    document.body.classList.toggle('ai-busy', runBusy);
    ['scan'].forEach(function (id) {
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
    var scanBtn = document.getElementById('scan');
    var hasResult = (state.issues && state.issues.length) || (state.next && (state.next.plan || state.next.action !== 'scan'));
    if (scanBtn) {
      scanBtn.classList.toggle('secondary', Boolean(hasResult));
      scanBtn.title = hasResult
        ? '重新扫描：刷新问题结果，不推进当前计划'
        : '开始扫描';
      scanBtn.setAttribute('aria-label', hasResult ? '重新扫描' : '开始扫描');
    }
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
      const clearChip = severityFilter.length > 0
        ? '<span class="chip c-info" data-clear="1" title="清除等级筛选">✕ 清除等级</span>'
        : '';
      sum.innerHTML = (issues.length ? chips : '<span class="chip c-info">未发现问题</span>')
        + '<span class="chip">' + totalText + ' · ' + time + '</span>'
        + clearChip;
    }

    const list = document.getElementById('list');
    if (state.scanning && !state.finishedAt) {
      list.innerHTML = '<div class="empty">扫描完成后将在这里列出问题</div>';
    } else if (!state.finishedAt) {
      list.innerHTML = deep
        ? '<div class="empty">深度修复进行中，完成后会自动重新扫描。</div>'
        : '<div class="empty">点击上方「开始扫描」开始</div>';
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
              + '<span class="sug-impact"> ' + (s.impactLabel
                  ? '涉及 ' + s.impact + ' ' + s.impactLabel
                  : '可覆盖 ' + s.impact + ' 项问题') + '</span></div></div>';
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

    renderMessages(busy);
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
  });
  document.getElementById('scan').addEventListener('click', function () {
    vscode.postMessage({ type: 'scan' });
  });
  var projectSelect = document.getElementById('project-select');
  if (projectSelect) {
    projectSelect.addEventListener('change', function () {
      vscode.postMessage({ type: 'selectProject', projectId: projectSelect.value });
    });
  }
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
  var wizardEl = document.getElementById('wizard');
  if (wizardEl) {
    wizardEl.addEventListener('click', function (e) {
      var target = e.target && e.target.closest ? e.target.closest('[data-wz]') : null;
      if (!target) return;
      handleWizardAction(target.getAttribute('data-wz'));
    });
    wizardEl.addEventListener('change', function (e) {
      if (e.target && e.target.getAttribute && e.target.getAttribute('data-scope-pick')) {
        updateScopePickerUI();
      }
    });
  }
  document.addEventListener('click', function (e) {
    var picker = document.querySelector('.wz-scope-picker');
    if (picker && picker.open && !picker.contains(e.target)) {
      picker.open = false;
    }
  });

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
    document.getElementById('opt-rewritescan').checked = options.rewriteScan === true;
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
    var options = { scanOnSave: document.getElementById('opt-scansave').checked, rewriteScan: document.getElementById('opt-rewritescan').checked };
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
  document.getElementById('msgbar').addEventListener('click', function (e) {
    const target = e.target;
    const focus = target && target.closest ? target.closest('[data-focus]') : null;
    if (focus) {
      var dest = document.getElementById(focus.getAttribute('data-focus'));
      if (dest) dest.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    const wz = target && target.closest ? target.closest('[data-wz]') : null;
    if (wz) {
      handleWizardAction(wz.getAttribute('data-wz'));
      return;
    }
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
      var busy = !!state.scanning || !!state.deepFix || !!(state.run && state.run.status === 'running');
      renderMessages(busy);
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
