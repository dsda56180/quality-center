import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { buildNextAction } from '../nextAction';
import { explainBuildFailure } from '../explain';
import { buildProject } from '../agentOps';
import { exportForAgent, formatIssueForCopy } from '../agentExport';
import { resolveBinary, run, runStreaming, StreamHandle, tailMessage } from '../exec';
import { applyAutoFixes, isFixable } from '../fixer';
import { Issue, ScanResult, SOURCE_LABEL } from '../model';
import { EXTERNAL_TOOLS, ExternalTool, installLocation, installPlan, InstallPlan, ToolId } from '../tools';
import { detectProjectProfile, ProjectProfile, recipeAdvice } from '../projectProfile';
import { toMarkdown } from '../report';
import { ScanRunner } from '../scanner';
import { mavenMirrorArgs } from '../maven';
import { buildDeepFixPreviewHtml, buildUpgradePreviewHtml, readPatchText, UpgradePreviewEntry } from './deepFixPanel';
import { applyUpgrade, planUpgrades, UpgradeCandidate, UpgradeContext } from '../upgrader';
import { loadPolicy } from '../upgradePolicy';
import { buildAgentPrompt } from '../agentPrompt';
import { McpStatus, probeMcp } from '../mcpStatus';
import { readRunState, runSnapshot, setRunActor } from '../runState';
import {
  applyUpgradePlan,
  checkUpgradePlan,
  createUpgradePlan,
  hashText,
  PLAN_GROUP_LABEL,
  planCandidateToUpgrade,
  readUpgradePlan,
  revertUpgradePlan
} from '../upgradePlanFile';
import { indexBomManagement, localRepository, parseBomRefs, parseDependencyTree } from '../dependencies';
import {
  artifactsForRecipes,
  autoRecipeIds,
  classifyDiscoveredRecipes,
  DEFAULT_RECIPE_ARTIFACTS,
  mergeRecipeLibrary,
  parseDiscoverOutput,
  RECIPE_LIBRARY,
  RECIPE_PLUGIN_VERSION,
  RecipeDefinition,
  recipeLabel,
  requiredPluginVersion
} from '../recipes';
import { getHtml, Snapshot, SnapshotIssue } from './html';

interface RuleRecipe {
  recipe: string;
  artifact?: string;
  label: string;
}

/** Checkstyle 规则 → OpenRewrite 配方，用于问题级深度修复 */
const RULE_RECIPE: Record<string, RuleRecipe> = {
  UnusedImports: {
    recipe: 'org.openrewrite.java.RemoveUnusedImports',
    label: '清理无用导入'
  },
  RedundantImport: {
    recipe: 'org.openrewrite.java.RemoveUnusedImports',
    label: '清理无用导入'
  },
  SimplifyBooleanExpression: {
    recipe: 'org.openrewrite.staticanalysis.SimplifyBooleanExpression',
    artifact: 'org.openrewrite.recipe:rewrite-static-analysis:2.10.0',
    label: '简化布尔表达式'
  },
  UnnecessaryParentheses: {
    recipe: 'org.openrewrite.staticanalysis.UnnecessaryParentheses',
    artifact: 'org.openrewrite.recipe:rewrite-static-analysis:2.10.0',
    label: '去除多余括号'
  }
};

interface ScanSettingsInput {
  checkstyle?: boolean;
  gitleaks?: boolean;
  trivy?: boolean;
  spotbugs?: boolean;
  qcsec?: boolean;
  astgrep?: boolean;
  scanOnSave?: boolean;
  recipes?: string[];
  autoRecipes?: boolean;
  showAllRecipes?: boolean;
}

/** 把一行输出压到指定长度，避免进度条文字撑满通知 */
function clamp(value: string, limit = 64): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** 安装脚本里的进度标识：优先用脚本自己打的 [qc] 标记，其次按关键字识别 */
function installStage(line: string): string | undefined {
  // 编码不匹配的输出（乱码）不当作进度展示
  if (line.includes('\uFFFD')) {
    return undefined;
  }
  const marker = /^\[qc\]\s*(.+)$/.exec(line);
  if (marker) {
    return clamp(marker[1], 64);
  }
  // curl / winget 的进度条会输出百分比，直接当进度用
  const percent = /(\d{1,3}(?:[.,]\d)?)\s*%/.exec(line);
  if (percent) {
    return `${/Install|安装/.test(line) ? '安装中' : '下载中'} ${percent[1]}%`;
  }
  if (/Downloading|正在下载|下载中|下载 /.test(line)) {
    return `下载中：${clamp(line, 48)}`;
  }
  if (/Installing|正在安装|安装中/.test(line)) {
    return `安装中：${clamp(line, 48)}`;
  }
  if (/Successfully installed|已成功安装|成功安装了/.test(line)) {
    return '安装完成，正在校验';
  }
  if (/Verifying|校验|sha256/i.test(line)) {
    return `校验：${clamp(line, 48)}`;
  }
  // 进度条、百分比、纯符号行没有意义，丢掉
  if (/[█▓▒░]/.test(line) || /^\s*\d+ ?%/.test(line) || /^[-\\|/]+\s*$/.test(line)) {
    return undefined;
  }
  return undefined;
}

/** mvn 输出里的进度：模块、阶段、下载、构建结果 */
function buildStage(line: string): string | undefined {
  const plain = line.replace(/^\[[A-Z]+\]\s*/, '');
  if (/^\[ERROR\]/.test(line)) {
    return `报错：${clamp(plain, 56)}`;
  }
  if (/^Downloading/i.test(line) || /^Downloaded/i.test(line)) {
    return clamp(plain, 56);
  }
  if (/^\[WARNING\]/.test(line)) {
    return undefined;
  }
  const info = /^\[INFO\]\s+(.+)$/.exec(line);
  if (!info) {
    return undefined;
  }
  const body = info[1].trim();
  const building = /^Building (.+)$/.exec(body);
  if (building) {
    return `构建模块 ${clamp(building[1], 48)}`;
  }
  const result = /^BUILD (SUCCESS|FAILURE)/.exec(body);
  if (result) {
    return result[1] === 'SUCCESS' ? '构建成功，整理产物' : '构建失败';
  }
  const phase = /^--- (\S+?)(?::| )/.exec(body);
  if (phase) {
    return `执行 ${clamp(phase[1], 40)}`;
  }
  if (/^Nothing to compile|Nothing to compile/i.test(body)) {
    return '无需编译，直接打包';
  }
  if (/^Total time|^Finished at/i.test(body)) {
    return undefined;
  }
  return clamp(body, 56);
}

/** 同一 GA 只保留一个坐标，避免内置配方包与用户配置重复加载 */
function dedupeArtifacts(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const ga = item.split(':').slice(0, 2).join(':');
    if (!ga || seen.has(ga)) {
      continue;
    }
    seen.add(ga);
    result.push(item);
  }
  return result;
}

/** 读取项目源码编码，缺失时按 UTF-8 处理 */
function sourceEncoding(root: string): string {
  try {
    const pom = fs.readFileSync(path.join(root, 'pom.xml'), 'utf8');
    const property = /<project\.build\.sourceEncoding>\s*([^<]+?)\s*<\/project\.build\.sourceEncoding>/i.exec(pom);
    if (property) {
      return property[1].trim();
    }
    const compiler = /<encoding>\s*([^<]+?)\s*<\/encoding>/i.exec(pom);
    if (compiler) {
      return compiler[1].trim();
    }
  } catch {
    // pom 不可读时按 UTF-8 处理
  }
  return 'UTF-8';
}

/**
 * OpenRewrite 读写源码用的是 JVM 默认字符集（file.encoding），
 * Windows 上默认编码不一定是 UTF-8，会把中文注释读成乱码再写进补丁。
 * 这里把 Maven 进程的默认字符集对齐到项目源码编码。
 */
function encodingEnv(encoding: string): NodeJS.ProcessEnv {
  const option = `-Dfile.encoding=${encoding}`;
  const current = process.env.MAVEN_OPTS ?? '';
  const merged = /-Dfile\.encoding=\S+/.test(current)
    ? current.replace(/-Dfile\.encoding=\S+/g, option)
    : `${current} ${option}`.trim();
  return { MAVEN_OPTS: merged };
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export class QualityViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = 'qualityCenter.main';

  private view?: vscode.WebviewView;
  private agentFile?: string;
  private deepFixState: { stage: string; startedAt: number; total: number; done: number } | null = null;
  private previewPanel?: vscode.WebviewPanel;
  /** 上一次 dry-run 的结果，工作区未变化时直接复用，避免重复预演 */
  private fixCache?: { key: string; patchFile?: string; files: string[] };
  private scanStartedAt: number | null = null;
  private scanProgress: { done: number; total: number; active: string[] } = {
    done: 0,
    total: 0,
    active: []
  };
  private output?: vscode.OutputChannel;
  /** 外部 MCP/CLI 改动 .quality-center 时，面板靠监听文件回到同一份事实 */
  private watchers: vscode.Disposable[] = [];
  private watchRoot = '';
  private watchTimer?: NodeJS.Timeout;
  private lastRunRevision = '';
  /** MCP 接入状态：面板只显示缓存，真正的检测由按钮/初始化触发 */
  private mcpStatus: McpStatus = {
    state: 'checking',
    label: '检测 MCP…',
    detail: '正在检查项目 MCP 配置与本地服务。'
  };
  /** 本次面板会话只提醒一次，避免每次 push 都弹 */
  private mcpPrompted = false;

  constructor(private readonly runner: ScanRunner) {
    setRunActor({ kind: 'panel' });
  }

  dispose(): void {
    this.disposeWatchers();
    this.output?.dispose();
  }

  private disposeWatchers(): void {
    this.watchers.splice(0).forEach((watcher) => watcher.dispose());
    this.watchRoot = '';
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = undefined;
    }
  }

  /**
   * 监听事实文件而不是监听 MCP 进程：MCP 与扩展是不同进程，文件是唯一稳定的事件总线。
   * 写盘频繁时 250ms 合并成一次重建，避免面板被半截 JSON 或多次刷新打断。
   */
  private ensureWatchers(root: string): void {
    if (!root || (this.watchRoot === root && this.watchers.length > 0)) {
      return;
    }
    this.disposeWatchers();
    this.watchRoot = root;
    const patterns = [
      '.quality-center/run-state.json',
      '.quality-center/events.jsonl',
      '.quality-center/mcp-calls.jsonl',
      '.quality-center/issues.json',
      '.quality-center/scan-digest.json',
      '.quality-center/scan-baseline.json',
      '.quality-center/build-result.json',
      '.quality-center/handoff.md',
      '.quality-center/upgrade/**/plan.json',
      '.quality-center/upgrade/**/steps.json',
      '.quality-center/upgrade/**/applied.json',
      '.quality-center/upgrade/**/reverted.json',
      'pom.xml'
    ];
    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(root, pattern)
      );
      const schedule = () => this.scheduleExternalRefresh();
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      this.watchers.push(watcher);
    }
  }

  private scheduleExternalRefresh(): void {
    if (this.runner.isRunning || this.deepFixState) {
      return;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      const root = this.runner.root();
      if (!root) {
        return;
      }
      this.runner.reloadLedger();
      this.push();
    }, 250);
  }

  /** AI 正在推进时，面板的写操作必须让位，避免两个写入口互相覆盖 */
  private runLocked(): boolean {
    const root = this.runner.root();
    if (!root) {
      return false;
    }
    const state = readRunState(root);
    return !!state && state.status === 'running' && Date.now() - Date.parse(state.updatedAt) < 30 * 60_000;
  }

  private log(message: string): void {
    if (!this.output) {
      this.output = vscode.window.createOutputChannel('质量中心');
    }
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  }

  /** 开始一个多阶段任务：每个阶段对应进度条上的一只猫 */
  private beginDeepFix(stage: string, total: number): void {
    this.deepFixState = { stage, startedAt: Date.now(), total, done: 0 };
    this.log(stage);
    this.push();
  }

  private setDeepFixStage(stage: string): void {
    if (this.deepFixState) {
      this.deepFixState.stage = stage;
      this.deepFixState.done = Math.min(this.deepFixState.total, this.deepFixState.done + 1);
    }
    this.log(stage);
    this.push();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getHtml(createNonce());
    view.webview.onDidReceiveMessage((message: { type?: string; file?: string; line?: number; url?: string }) => {
      void this.handleMessage(message);
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
    const root = this.runner.root();
    if (root) {
      this.ensureWatchers(root);
    }
    this.push();
    void this.refreshMcpStatus();
    this.maybeDiscover();
  }

  private async handleMessage(message: {
    type?: string;
    file?: string;
    line?: number;
    url?: string;
    id?: number;
    pkg?: string;
    tool?: string;
    options?: ScanSettingsInput;
  }): Promise<void> {
    const readOnly = new Set([
      'copy', 'copyIssue', 'openAgent', 'copySuggestion', 'explainBuild', 'openHandoff',
      'copyDrivePrompt', 'checkMcp', 'openMcpConfig', 'open', 'openLink', 'saveSettings',
      'pauseScan', 'stopScan'
    ]);
    if (message.type && !readOnly.has(message.type) && this.runLocked()) {
      void vscode.window.showWarningMessage(
        'Trae AI 正在通过 MCP 执行质量任务，面板写操作已锁定；等 AI 当前阶段结束或接管后再操作。'
      );
      return;
    }
    switch (message.type) {
      case 'installTool':
        if (message.tool) {
          await this.installTool(message.tool as ToolId);
        }
        break;
      case 'scan':
        await this.scanAndPush(true);
        break;
      case 'pauseScan':
        this.runner.pause();
        this.push();
        break;
      case 'resumeScan':
        this.runner.resume();
        if (this.runner.isRunning) {
          this.push();
        } else {
          await this.scanAndPush(true);
        }
        break;
      case 'stopScan':
        this.log('扫描已被用户终止');
        this.runner.cancel();
        this.push();
        break;
      case 'copy':
        await this.copyMarkdown();
        break;
      case 'copyIssue':
        await this.copyIssue(message.id ?? 0);
        break;
      case 'openAgent':
        await this.openAgentFile();
        break;
      case 'fixAll':
        await this.fixAll();
        break;
      case 'fixIssue':
        await this.fixIssue(message.id ?? 0);
        break;
      case 'copySuggestion':
        await this.copySuggestion(message.id ?? 0);
        break;
      case 'buildAndScan':
        await this.buildAndScan();
        break;
      case 'deepFix':
        await this.deepFix();
        break;
      case 'deepFixRule':
        await this.deepFixRule(message.id ?? 0);
        break;
      case 'upgradeDeps':
        await this.upgradeDependencies(message.pkg);
        break;
      case 'upgradeNext':
        await this.upgradeNextGroup();
        break;
      case 'createUpgradePlan':
        await this.createPlanOnly();
        break;
      case 'buildGate':
        await this.buildGate();
        break;
      case 'explainBuild':
        await this.showBuildExplanation();
        break;
      case 'revertPlan':
        await this.revertLatestPlan();
        break;
      case 'openHandoff':
        await this.openHandoffFile();
        break;
      case 'copyDrivePrompt':
        await this.copyDrivePrompt();
        break;
      case 'checkMcp':
        await this.refreshMcpStatus();
        break;
      case 'setupMcp':
        await this.setupMcp();
        break;
      case 'openMcpConfig':
        await this.openMcpConfig();
        break;
      case 'saveSettings':
        await this.saveScanSettings(message.options);
        break;
      case 'ignore':
        if (message.id && this.runner.ignoreIssue(message.id)) {
          this.writeAgentFiles();
          this.push();
        }
        break;
      case 'unignore':
        if (message.id && this.runner.unignoreIssue(message.id)) {
          this.writeAgentFiles();
          this.push();
        }
        break;
      case 'save':
        await this.exportReport();
        break;
      case 'open':
        if (message.file) {
          await openIssue(message.file, message.line ?? 0);
        }
        break;
      case 'openLink':
        if (message.url) {
          await vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;
      default:
        break;
    }
  }

  /** force=true 表示用户主动开始，忽略「自动扫描暂停」状态 */
  async scanAndPush(force = false): Promise<void> {
    if (this.runner.isRunning || this.deepFixState) {
      return;
    }
    if (!force && this.runner.isPaused) {
      return;
    }
    if (force) {
      this.runner.resume();
    }
    this.scanStartedAt = Date.now();
    this.scanProgress = { done: 0, total: 0, active: [] };
    this.push({ scanning: true });
    try {
      const result = await this.runner.scan((progress) => {
        this.scanProgress = progress;
        this.push();
      });
      this.writeAgentFiles();
      if (result) {
        this.log(
          `扫描完成：${result.issues.length} 项问题，用时 ${((result.finishedAt - result.startedAt) / 1000).toFixed(1)} 秒`
        );
        this.notifyMissingTools(result);
      }
    } finally {
      this.scanStartedAt = null;
      this.scanProgress = { done: 0, total: 0, active: [] };
      this.push();
    }
  }

  /** 本次会话已经提示过的工具，避免自动扫描（启动/保存）反复弹窗 */
  private missingToolPrompts = new Set<ToolId>();

  /**
   * 缺失的外部工具不再静默跳过：弹一次提示，附带「去安装」。
   * 插件本身不下载任何可执行文件，这里只是把官方安装方式接到手边。
   */
  private notifyMissingTools(result: ScanResult): void {
    const config = vscode.workspace.getConfiguration('qualityCenter');
    if (!config.get<boolean>('notifyMissingTools', true)) {
      return;
    }
    for (const id of result.missingTools ?? []) {
      if (this.missingToolPrompts.has(id) || !EXTERNAL_TOOLS[id]) {
        continue;
      }
      this.missingToolPrompts.add(id);
      void this.promptMissingTool(id);
    }
  }

  private async promptMissingTool(id: ToolId): Promise<void> {
    const tool = EXTERNAL_TOOLS[id];
    const plan = installPlan(tool);
    const installable = !!(plan.command || plan.script);
    const message = installable
      ? `未找到 ${tool.bin}，${tool.purpose}已跳过。是否现在安装 ${tool.label}？（${plan.describe}）`
      : `未找到 ${tool.bin}，${tool.purpose}已跳过。该工具需要手动安装。`;
    const actions = installable ? ['去安装', '查看文档', '不再提示'] : ['查看文档', '不再提示'];
    const answer = await vscode.window.showWarningMessage(message, ...actions);
    if (answer === '去安装') {
      await this.installTool(id);
      return;
    }
    if (answer === '查看文档') {
      await vscode.env.openExternal(vscode.Uri.parse(tool.docs));
      return;
    }
    if (answer === '不再提示') {
      await vscode.workspace
        .getConfiguration('qualityCenter')
        .update('notifyMissingTools', false, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        '已关闭缺失工具提示，可在设置 qualityCenter.notifyMissingTools 重新开启。'
      );
    }
  }

  /**
   * 把多行脚本落到临时文件，交给系统自带 shell 执行，避免逐层转义。
   * 返回可实时读取输出的句柄，调用方负责轮询/取消。
   */
  private startInstallPlan(plan: InstallPlan, root: string, onLine: (line: string) => void): StreamHandle {
    const timeout = 15 * 60_000;
    if (!plan.script) {
      return runStreaming(plan.command ?? '', [], root, timeout, { onLine });
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-center-install-'));
    const file = path.join(dir, plan.scriptShell === 'powershell' ? 'install.ps1' : 'install.sh');
    // Windows PowerShell 5.1 默认按 ANSI 读取 .ps1，带 BOM 才会按 UTF-8 解析，否则中文进度标记会变成乱码
    const body = plan.scriptShell === 'powershell' ? `\uFEFF${plan.script}` : plan.script;
    fs.writeFileSync(file, body, 'utf8');
    const shell =
      plan.scriptShell === 'powershell'
        ? `"${path.join(
            process.env.SystemRoot || 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe'
          )}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${file}"`
        : `bash "${file}"`;
    const handle = runStreaming(shell, [], root, timeout, { onLine });
    void handle.result.finally(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 临时目录清理失败不影响结果
      }
    });
    return handle;
  }

  /** 包装一个长任务的进度状态：同步到通知栏与面板提示行 */
  private taskState: { label: string; stage: string; startedAt: number } | null = null;

  private taskReporter(label: string, startedAt: number, initialStage: string) {
    let stage = initialStage;
    let lastPush = 0;
    const touch = (): void => {
      this.taskState = { label, stage, startedAt };
      const now = Date.now();
      if (now - lastPush >= 400) {
        lastPush = now;
        this.push();
      }
    };
    touch();
    return {
      setStage: (next: string | undefined): void => {
        if (next) {
          stage = next;
        }
        touch();
      },
      stage: (): string => stage,
      finish: (): void => {
        this.taskState = null;
        this.push();
      }
    };
  }

  /**
   * 一键安装：按系统自动选择安装方式。
   * Windows: winget → Chocolatey → Scoop → 官方产物便携安装
   * macOS:   Homebrew → 官方产物便携安装
   * Linux:   Homebrew → 官方产物便携安装（无需 sudo）
   */
  async installTool(id: ToolId): Promise<void> {
    const tool = EXTERNAL_TOOLS[id];
    if (!tool) {
      return;
    }
    const plan = installPlan(tool);

    // 需要 sudo 的发行版安装不代跑，直接复制命令，避免卡在密码输入
    if (plan.requiresRoot) {
      await vscode.env.clipboard.writeText(plan.command ?? plan.hint);
      void vscode.window.showInformationMessage(
        `安装 ${tool.label} 需要管理员权限，命令已复制到剪贴板：\n${plan.command ?? plan.hint}`,
        '打开安装文档'
      ).then((pick) => {
        if (pick === '打开安装文档') {
          return vscode.env.openExternal(vscode.Uri.parse(tool.docs));
        }
        return undefined;
      });
      return;
    }

    if (!plan.command && !plan.script) {
      void vscode.window.showInformationMessage(
        `${tool.label} 需要手动安装：${tool.hint}`,
        '打开安装文档'
      ).then((pick) => {
        if (pick === '打开安装文档') {
          return vscode.env.openExternal(vscode.Uri.parse(tool.docs));
        }
        return undefined;
      });
      return;
    }

    if (this.runner.isRunning) {
      void vscode.window.showInformationMessage('扫描进行中，请稍后再安装外部工具。');
      return;
    }

    const target = installLocation(tool, plan);
    const answer = await vscode.window.showWarningMessage(
      `安装 ${tool.label}：${plan.describe}`,
      {
        modal: true,
        detail: [
          plan.kind === 'winget' || plan.kind === 'choco' || plan.kind === 'scoop' || plan.kind === 'brew'
            ? '将调用系统包管理器，可能弹出一次 UAC / 权限确认。'
            : '将下载官方产物到插件自己的工具目录，不修改系统 PATH，卸载插件后可直接删除。',
          plan.alternative ? `也可改用系统包管理器：${plan.alternative}` : '',
          '安装完成后会自动重新扫描。'
        ]
          .filter(Boolean)
          .join('\n')
      },
      '开始安装'
    );
    if (answer !== '开始安装') {
      return;
    }

    const root = this.runner.root() ?? process.cwd();
    this.log(`安装 ${tool.label}（${plan.kind}）：${plan.command ?? plan.describe}`);
    const startedAt = Date.now();
    const reporter = this.taskReporter(`安装 ${tool.label}`, startedAt, plan.describe);
    let cancelled = false;
    let outcome = { code: 1, stdout: '', stderr: '' };
    try {
      outcome = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `质量中心：安装 ${tool.label}`,
          cancellable: true
        },
        async (progress, token) => {
          const elapsed = (): string => `${Math.round((Date.now() - startedAt) / 1000)} 秒`;
          const report = (): void => progress.report({ message: `${reporter.stage()}（${elapsed()}）` });
          report();
          this.log(`  ${plan.describe}`);
          const handle = this.startInstallPlan(plan, root, (line) => {
            this.log(`  ${line}`);
            reporter.setStage(installStage(line));
            report();
          });
          const ticker = setInterval(report, 2000);
          const subscription = token.onCancellationRequested(() => {
            cancelled = true;
            this.log(`安装 ${tool.label} 已取消`);
            handle.kill(`取消安装 ${tool.label}`);
          });
          try {
            return await handle.result;
          } finally {
            clearInterval(ticker);
            subscription.dispose();
          }
        }
      );
    } finally {
      reporter.finish();
    }

    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const output = tailMessage(`${outcome.stdout}\n${outcome.stderr}`, 10);
    if (cancelled || outcome.code === 130) {
      void vscode.window.showInformationMessage(`已取消安装 ${tool.label}（用时 ${seconds} 秒）。`);
      return;
    }
    // winget 对「已是最新 / 已安装」会返回非零码，输出里写得很清楚
    const already = /already installed|已安装|No applicable installer|No newer package/i.test(output);
    const configured =
      tool.bin === 'mvn'
        ? ''
        : vscode.workspace.getConfiguration('qualityCenter').get<string>(`${tool.bin}.path`, '');
    const resolved = resolveBinary(tool.bin, configured);
    const installed = resolved !== undefined || outcome.code === 0 || already;
    if (!installed) {
      this.log(`安装 ${tool.label} 失败（${seconds} 秒）：\n${output}`);
      const pick = await vscode.window.showErrorMessage(
        `安装 ${tool.label} 失败（退出码 ${outcome.code}，用时 ${seconds} 秒）：\n${output || plan.describe}`,
        '查看日志',
        '安装文档'
      );
      if (pick === '查看日志') {
        this.output?.show(true);
      } else if (pick === '安装文档') {
        await vscode.env.openExternal(vscode.Uri.parse(tool.docs));
      }
      return;
    }

    this.missingToolPrompts.delete(id);
    this.runner.resetCache();
    this.log(`安装 ${tool.label} 完成（${seconds} 秒）：${resolved ?? target ?? ''}\n${output}`);
    void vscode.window.showInformationMessage(
      `已安装 ${tool.label}${resolved ? `（${resolved}）` : ''}，用时 ${seconds} 秒，正在重新扫描…`
    );
    await this.scanAndPush(true);
  }

  /** 每轮扫描后写一份 AI 可读的结构化结果 */
  private writeAgentFiles(): void {
    const root = this.runner.root();
    const result = this.runner.result;
    if (!root || !result) {
      return;
    }
    if (!vscode.workspace.getConfiguration('qualityCenter').get<boolean>('exportForAgent', true)) {
      this.agentFile = undefined;
      return;
    }
    try {
      const exported = exportForAgent(root, result);
      this.agentFile = path.relative(root, exported.jsonPath).split(path.sep).join('/');
    } catch {
      this.agentFile = undefined;
    }
  }

  private async copyIssue(id: number): Promise<void> {
    const root = this.runner.root();
    const issue = this.runner.result?.issues[id - 1];
    if (!root || !issue) {
      return;
    }
    await vscode.env.clipboard.writeText(formatIssueForCopy(issue, root, id));
    void vscode.window.showInformationMessage(`已复制第 ${id} 条问题，可直接粘贴给 AI。`);
  }

  /** 构建项目后再扫描，用于补齐依赖漏洞与静态缺陷所需的构建产物 */
  async buildAndScan(): Promise<void> {
    const root = this.runner.root();
    if (!root) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      '将执行 mvn -B -DskipTests package 构建项目（可能需要几分钟），完成后自动重新扫描。是否继续？',
      { modal: true },
      '构建并扫描'
    );
    if (answer !== '构建并扫描') {
      return;
    }

    // mvn 不在 PATH 时直接给安装入口，而不是让用户看到一句「构建失败」
    const mvn = resolveBinary('mvn');
    if (!mvn) {
      const pick = await vscode.window.showErrorMessage(
        '没有找到 mvn，无法构建项目。请先安装 Maven（需要 JDK 8+），或用「构建并扫描」下方的一键安装。',
        '去安装 Maven',
        '安装文档'
      );
      if (pick === '去安装 Maven') {
        await this.installTool('mvn');
      } else if (pick === '安装文档') {
        await vscode.env.openExternal(vscode.Uri.parse(EXTERNAL_TOOLS.mvn.docs));
      }
      return;
    }

    const startedAt = Date.now();
    const reporter = this.taskReporter('构建 jar 包', startedAt, '准备构建');
    let cancelled = false;
    let outcome = { code: 1, stdout: '', stderr: '' };
    try {
      outcome = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '质量中心：构建 jar 包',
          cancellable: true
        },
        async (progress, token) => {
          const elapsed = (): string => `${Math.round((Date.now() - startedAt) / 1000)} 秒`;
          const report = (): void => progress.report({ message: `${reporter.stage()}（${elapsed()}）` });
          report();
          this.log(`构建：${mvn} -B ${mavenMirrorArgs().join(' ')} -DskipTests package`);
          const handle = runStreaming(
            mvn,
            ['-B', ...mavenMirrorArgs(), '-DskipTests', 'package'],
            root,
            30 * 60_000,
            {
              onLine: (line) => {
                this.log(`  ${line}`);
                reporter.setStage(buildStage(line));
                report();
              }
            }
          );
          const ticker = setInterval(report, 2000);
          const subscription = token.onCancellationRequested(() => {
            cancelled = true;
            this.log('构建已取消');
            handle.kill('取消构建');
          });
          try {
            return await handle.result;
          } finally {
            clearInterval(ticker);
            subscription.dispose();
          }
        }
      );
    } finally {
      reporter.finish();
    }

    const seconds = Math.round((Date.now() - startedAt) / 1000);
    if (cancelled || outcome.code === 130) {
      void vscode.window.showInformationMessage(`已取消构建（用时 ${seconds} 秒），未执行扫描。`);
      return;
    }
    if (outcome.code !== 0) {
      const tail =
        tailMessage(`${outcome.stdout}\n${outcome.stderr}`, 6) ||
        (outcome.code === 124 ? '构建超过 30 分钟，已终止' : '构建未输出可用错误信息');
      this.log(`构建失败（${seconds} 秒）：\n${tail}`);
      const pick = await vscode.window.showErrorMessage(
        `构建失败（退出码 ${outcome.code}，用时 ${seconds} 秒）：\n${tail}`,
        '查看日志'
      );
      if (pick === '查看日志') {
        this.output?.show(true);
      }
      return;
    }

    const jars = this.buildArtifacts(root);
    this.log(`构建完成（${seconds} 秒）：${jars.join(', ') || 'target 下未找到 jar'}`);
    void vscode.window.showInformationMessage(
      jars.length > 0
        ? `构建完成（用时 ${seconds} 秒）：${jars.join('、')}，正在重新扫描…`
        : `构建完成（用时 ${seconds} 秒），target 下未找到 jar，仍将重新扫描…`
    );
    await this.scanAndPush();
  }

  /** 列出 target 下可用的产物 jar（排除 sources / javadoc / original- 备份） */
  private buildArtifacts(root: string): string[] {
    const target = path.join(root, 'target');
    try {
      return fs
        .readdirSync(target)
        .filter(
          (name) =>
            name.endsWith('.jar') &&
            !/-sources\.jar$/.test(name) &&
            !/-javadoc\.jar$/.test(name) &&
            !name.startsWith('original-')
        )
        .slice(0, 3);
    } catch {
      return [];
    }
  }

  /**
   * 深度修复：调用 OpenRewrite 跑白名单配方。
   * 不改项目 pom，用全限定插件坐标临时加载；因此只支持插件内置类路径自带的配方。
   */
  async deepFix(override?: {
    recipes: string[];
    artifacts?: string[];
    label?: string;
    pluginVersion?: string;
  }): Promise<void> {
    const root = this.runner.root();
    if (!root) {
      return;
    }
    const config = vscode.workspace.getConfiguration('qualityCenter');
    if (!config.get<boolean>('openRewrite.enabled', true)) {
      void vscode.window.showInformationMessage('深度修复已在设置中关闭。');
      return;
    }
    if (this.deepFixState) {
      void vscode.window.showInformationMessage('深度修复正在进行中，请等待当前任务完成。');
      return;
    }
    if (this.previewPanel) {
      this.previewPanel.reveal();
      void vscode.window.showInformationMessage('修复预览已打开，请先应用或取消当前预览。');
      return;
    }
    if (this.runner.isRunning) {
      void vscode.window.showInformationMessage('扫描进行中，请稍后再执行深度修复。');
      return;
    }

    const status = await run('git', ['status', '--porcelain'], root, 30_000);
    if (status.code !== 0) {
      void vscode.window.showErrorMessage('深度修复需要在 Git 仓库中运行，便于失败时回滚。');
      return;
    }
    const dirtyCount = status.stdout.split(/\r?\n/).filter(Boolean).length;

    const profile = this.projectProfile(root);
    const configured = override?.recipes ?? config.get<string[]>('openRewrite.recipes', []);
    // 自动启用「当前项目适用」的低风险配方；显式指定配方（单规则修复、Spring 迁移）时按指定执行
    const recipes = override
      ? configured
      : Array.from(
          new Set([
            ...configured,
            ...(config.get<boolean>('openRewrite.autoRecipes', true) ? autoRecipeIds(profile) : [])
          ])
        );
    if (recipes.length === 0) {
      void vscode.window.showWarningMessage(
        '当前项目没有可用的 OpenRewrite 配方，请在面板「设置」中勾选深度修复配方。'
      );
      return;
    }
    // 配方对插件版本有要求时以配方为准，避免类路径冲突
    const version =
      override?.pluginVersion ??
      requiredPluginVersion(recipes) ??
      config.get<string>('openRewrite.pluginVersion', '5.44.0');
    const recipeArtifacts = dedupeArtifacts([
      ...artifactsForRecipes(recipes),
      ...(override?.artifacts ?? config.get<string[]>('openRewrite.recipeArtifacts', []))
        .map((item) => item.trim())
        .filter(Boolean)
    ]);

    const profileParts = [
      profile.javaVersion ? `Java ${profile.javaVersion}` : '',
      profile.springBootVersion ? `Spring Boot ${profile.springBootVersion}` : ''
    ].filter(Boolean);
    const advice = recipeAdvice(profile);
    const recipeLines = recipes
      .map((recipe) => `· ${recipeLabel(recipe)}`)
      .join('\n');

    let previewPatch: string | undefined;
    let previewFiles: string[] = [];
    /** 用户勾选要应用改动的文件；undefined 表示全部应用 */
    let selectedFiles: Set<string> | undefined;
    let previewFailed = false;
    if (config.get<boolean>('openRewrite.dryRunPreview', true)) {
      const cacheKey = await this.fixPreviewKey(root, status.stdout, recipes, recipeArtifacts, version);
      const cached = this.fixCache;
      if (cached && cached.key === cacheKey && (!cached.patchFile || fs.existsSync(cached.patchFile))) {
        previewPatch = cached.patchFile;
        previewFiles = cached.files;
        this.log(`复用上次预演结果（${previewFiles.length} 个文件），跳过 dry-run`);
      } else {
        this.beginDeepFix('运行 OpenRewrite 配方（预演）', 3);
        this.log('开始 dry-run 预演');
        try {
          const preview = await this.previewDeepFix(root, recipes, recipeArtifacts, version);
          this.setDeepFixStage('生成修复补丁');
          this.setDeepFixStage('整理预览');
          if (!preview) {
            previewFailed = true;
          } else if (preview.files.length === 0) {
            void vscode.window.showInformationMessage('预演未发现需要改动的代码，已跳过深度修复。');
            return;
          } else {
            previewPatch = preview.patchFile;
            previewFiles = preview.files;
            this.fixCache = { key: cacheKey, patchFile: preview.patchFile, files: preview.files };
          }
        } finally {
          this.deepFixState = null;
          this.push();
        }
      }
    }

    // 预演成功后打开独立的预览编辑器页：可查看逐行 diff、勾选文件，关掉或点取消才放弃
    if (previewFiles.length > 0) {
      this.setDeepFixStage('准备预览');
      if (previewPatch && readPatchText(previewPatch).includes('\uFFFD')) {
        void vscode.window.showErrorMessage(
          '预演补丁包含无法解码的字符，可能是源文件编码与项目配置不一致，已取消本次修复。'
            + '请检查 pom 中的 project.build.sourceEncoding 是否与实际文件编码一致。'
        );
        return;
      }
      const selectable =
        previewFiles.length > 1 &&
        config.get<boolean>('openRewrite.fileSelection', true);
      const decision = await this.showFixPreview(previewPatch, previewFiles, {
        label: override?.label,
        project: profileParts.length ? profileParts.join(' · ') : 'Java 项目',
        recipes: recipes.map((recipe) => recipeLabel(recipe)),
        advice,
        dirtyCount,
        selectable
      });
      if (!decision) {
        this.log('用户取消了深度修复预览');
        return;
      }
      if (decision.files.length < previewFiles.length) {
        selectedFiles = new Set(decision.files);
      }
    } else {
      const headline = override?.label ? `深度修复：${override.label}` : '执行深度修复';
      const detail = [
        previewFailed ? '预演失败（详见输出日志），将直接执行修复。' : '',
        `将执行 ${recipes.length} 个配方：\n${recipeLines}`,
        advice.length ? `推荐（未启用）：\n${advice.map((item) => `· ${item}`).join('\n')}` : '',
        dirtyCount > 0
          ? `检测到 ${dirtyCount} 处未提交改动，会在临时目录做完整备份；修复失败或编译不通过时可恢复到修复前。`
          : '',
        '直接在现有代码上做编译级改写，不产生 stash 冲突；完成后自动校验编译。'
      ]
        .filter(Boolean)
        .join('\n\n');
      const answer = await vscode.window.showWarningMessage(
        headline,
        { modal: true, detail },
        '执行深度修复'
      );
      if (answer !== '执行深度修复') {
        return;
      }
    }

    // 一旦执行修复，工作区就变了，缓存失效
    this.fixCache = undefined;

    // 不 stash：先备份改动，再直接在现有代码上跑配方，从根本上避免 stash 恢复冲突
    interface Backup {
      dir: string;
      patchFile: string;
      untracked: string[];
    }
    let backup: Backup | undefined;
    const untrackedBefore = new Set<string>();

    const createBackup = async (): Promise<boolean> => {
      if (dirtyCount === 0) {
        return true;
      }
      this.setDeepFixStage('备份未提交改动');
      try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-center-backup-'));
        const diff = await run('git', ['diff', 'HEAD', '--binary'], root, 120_000);
        if (diff.code !== 0) {
          throw new Error((diff.stderr || diff.stdout).trim() || 'git diff 失败');
        }
        const patchFile = path.join(dir, 'changes.patch');
        fs.writeFileSync(patchFile, diff.stdout, 'utf8');

        const others = await run('git', ['ls-files', '--others', '--exclude-standard'], root, 60_000);
        const untracked = others.stdout.split(/\r?\n/).filter(Boolean);
        for (const relative of untracked) {
          untrackedBefore.add(relative);
          const source = path.join(root, relative);
          const target = path.join(dir, 'untracked', relative);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(source, target);
        }
        backup = { dir, patchFile, untracked };
        this.log(`已备份未提交改动到 ${dir}`);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`备份失败：${message}`);
        void vscode.window.showErrorMessage(`备份未提交改动失败，已取消深度修复：${message}`, '查看日志');
        this.output?.show(true);
        return false;
      }
    };

    const discardBackup = (): void => {
      if (!backup) {
        return;
      }
      fs.rmSync(backup.dir, { recursive: true, force: true });
      backup = undefined;
    };

    const restoreBackup = async (): Promise<boolean> => {
      if (!backup) {
        return true;
      }
      this.setDeepFixStage('恢复未提交改动');
      await run('git', ['checkout', 'HEAD', '--', '.'], root, 120_000);
      let ok = true;
      try {
        if (fs.existsSync(backup.patchFile) && fs.statSync(backup.patchFile).size > 0) {
          const applied = await run(
            'git',
            ['apply', '--binary', '--whitespace=nowarn', backup.patchFile],
            root,
            120_000
          );
          if (applied.code !== 0) {
            ok = false;
            this.log(`恢复未提交改动失败：${(applied.stderr || applied.stdout).trim()}`);
          }
        }
        for (const relative of backup.untracked) {
          const source = path.join(backup.dir, 'untracked', relative);
          const target = path.join(root, relative);
          if (fs.existsSync(source)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(source, target);
          }
        }
      } catch (error) {
        ok = false;
        this.log(`恢复未提交改动失败：${error instanceof Error ? error.message : String(error)}`);
      }
      if (ok) {
        discardBackup();
      } else {
        const dir = backup.dir;
        void vscode.window.showErrorMessage(
          `恢复未提交改动时出现异常，备份完整保留在：${dir}\n` +
            '可手动用 git apply 恢复 changes.patch，并复制 untracked 目录中的文件。',
          '查看日志'
        );
      }
      return ok;
    };

    this.beginDeepFix('备份改动', 4);
    this.log(`项目画像：${profileParts.join(' · ') || '未识别'}`);
    if (advice.length > 0) {
      this.log(`配方推荐（未启用）：\n${advice.join('\n')}`);
    }
    this.log(`开始深度修复：${recipes.join(', ')}`);
    try {
      if (!(await createBackup())) {
        return;
      }

      // 记录修复前的代码快照，用于精确统计本次配方改动了哪些文件
      let baseRef = 'HEAD';
      if (dirtyCount > 0) {
        const snapshot = await run('git', ['stash', 'create'], root, 60_000);
        if (snapshot.code === 0 && snapshot.stdout.trim()) {
          baseRef = snapshot.stdout.trim();
          this.log(`已创建修复前快照 ${baseRef}`);
        }
      }

      this.setDeepFixStage('运行 OpenRewrite 配方');
      const encoding = sourceEncoding(root);
      const outcome = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '质量中心：OpenRewrite 深度修复中…',
          cancellable: false
        },
        () => {
          const args = [
            '-B',
            '-q',
            ...mavenMirrorArgs(),
            `-Dproject.build.sourceEncoding=${encoding}`,
            `-Drewrite.activeRecipes=${recipes.join(',')}`
          ];
          if (recipeArtifacts.length > 0) {
            args.push(`-Drewrite.recipeArtifactCoordinates=${recipeArtifacts.join(',')}`);
          }
          args.push(`org.openrewrite.maven:rewrite-maven-plugin:${version}:run`);
          return run('mvn', args, root, 20 * 60_000, encodingEnv(encoding));
        }
      );
      if (outcome.code !== 0) {
        const tail = (outcome.stderr || outcome.stdout)
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-6)
          .join('\n');
        this.log(`OpenRewrite 失败：\n${tail}`);
        await restoreBackup();
        const pick = await vscode.window.showErrorMessage(
          `深度修复失败，已撤销本次改动：\n${tail}`,
          '查看日志'
        );
        if (pick === '查看日志') {
          this.output?.show(true);
        }
        return;
      }

      this.setDeepFixStage('收集改动文件');
      const changed = await run('git', ['diff', '--name-only', baseRef], root, 30_000);
      const changedFiles = new Set(changed.stdout.split(/\r?\n/).filter(Boolean));
      const othersAfter = await run('git', ['ls-files', '--others', '--exclude-standard'], root, 60_000);
      othersAfter.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((file) => {
          if (!untrackedBefore.has(file)) {
            changedFiles.add(file);
          }
        });
      // git diff 看不到未跟踪文件的变化，用备份副本比对补上
      if (backup) {
        for (const file of untrackedBefore) {
          const original = path.join(backup.dir, 'untracked', file);
          const current = path.join(root, file);
          try {
            if (!fs.existsSync(original)) {
              continue;
            }
            if (!fs.existsSync(current) || !fs.readFileSync(current).equals(fs.readFileSync(original))) {
              changedFiles.add(file);
            }
          } catch {
            // 读取失败时不纳入统计，避免影响主流程
          }
        }
      }

      // 把未勾选的文件恢复到修复前快照，只保留用户选择的改动
      if (selectedFiles) {
        const trackedList = await run('git', ['ls-files'], root, 60_000);
        const tracked = new Set(trackedList.stdout.split(/\r?\n/).filter(Boolean));
        const toRestore: string[] = [];
        const toDelete: string[] = [];
        for (const file of changedFiles) {
          if (selectedFiles.has(file)) {
            continue;
          }
          if (tracked.has(file) || untrackedBefore.has(file)) {
            toRestore.push(file);
          } else {
            toDelete.push(file);
          }
        }
        if (toRestore.length > 0 || toDelete.length > 0) {
          this.setDeepFixStage('恢复未选择的文件');
          const trackedRestore = toRestore.filter((file) => tracked.has(file));
          if (trackedRestore.length > 0) {
            const checkout = await run('git', ['checkout', baseRef, '--', ...trackedRestore], root, 120_000);
            if (checkout.code !== 0) {
              this.log(`恢复未选择的文件失败：${(checkout.stderr || checkout.stdout).trim()}`);
            }
          }
          for (const file of toRestore.filter((item) => !tracked.has(item))) {
            const source = backup ? path.join(backup.dir, 'untracked', file) : '';
            if (source && fs.existsSync(source)) {
              fs.copyFileSync(source, path.join(root, file));
            }
          }
          for (const file of toDelete) {
            try {
              fs.unlinkSync(path.join(root, file));
            } catch {
              // 文件可能已被配方删除，忽略
            }
          }
          changedFiles.clear();
          const diffAfter = await run('git', ['diff', '--name-only', baseRef], root, 30_000);
          diffAfter.stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .forEach((file) => changedFiles.add(file));
          const othersAfterSelect = await run(
            'git',
            ['ls-files', '--others', '--exclude-standard'],
            root,
            60_000
          );
          othersAfterSelect.stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .forEach((file) => {
              if (!untrackedBefore.has(file) && fs.existsSync(path.join(root, file))) {
                changedFiles.add(file);
              }
            });
          this.log(`已恢复 ${toRestore.length} 个未选择文件，删除 ${toDelete.length} 个新增文件`);
        }
      }

      const changedCount = changedFiles.size;
      if (changedCount === 0) {
        discardBackup();
        void vscode.window.showInformationMessage('深度修复完成，没有需要改动的代码。');
        return;
      }
      this.log(`OpenRewrite 共改动 ${changedCount} 个文件`);

      if (config.get<boolean>('openRewrite.compileGate', true)) {
        this.setDeepFixStage('校验编译');
        const build = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: '质量中心：校验编译…',
            cancellable: false
          },
          () => run('mvn', ['-B', '-q', ...mavenMirrorArgs(), '-DskipTests', 'compile'], root, 20 * 60_000)
        );
        if (build.code !== 0) {
          const tail = (build.stderr || build.stdout)
            .split(/\r?\n/)
            .filter(Boolean)
            .slice(-6)
            .join('\n');
          this.log(`编译校验失败：\n${tail}`);
          this.setDeepFixStage('编译失败，等待回滚确认');
          const revert = await vscode.window.showErrorMessage(
            `深度修复后编译失败，需要回滚已改动的 ${changedCount} 个文件。\n${tail}`,
            { modal: true },
            '立即回滚',
            '查看日志'
          );
          if (revert === '立即回滚') {
            this.setDeepFixStage('回滚本次改动');
            await restoreBackup();
            void vscode.window.showInformationMessage('已回滚到修复前的状态，并恢复未提交的改动。');
          } else {
            if (revert === '查看日志') {
              this.output?.show(true);
            }
            discardBackup();
          }
          return;
        }
      }

      discardBackup();
      this.deepFixState = null;
      this.push();
      await this.scanAndPush();
      void vscode.window.showInformationMessage(`深度修复完成，共改动 ${changedCount} 个文件。`);
    } finally {
      this.deepFixState = null;
      this.push();
    }
  }

  /**
   * CVE 一键升级：结合依赖树与 BOM 索引判断版本来源，
   * 升级后执行 mvn compile 门禁，失败自动还原 pom。
   */
  async upgradeDependencies(packageName?: string): Promise<void> {
    const root = this.runner.root();
    const result = this.runner.result;
    if (!vscode.workspace.getConfiguration('qualityCenter').get<boolean>('dependencyUpgrade.enabled', true)) {
      void vscode.window.showInformationMessage('依赖升级已在设置中关闭（qualityCenter.dependencyUpgrade.enabled）。');
      return;
    }
    if (!root || !result) {
      void vscode.window.showInformationMessage('还没有扫描结果，请先执行扫描。');
      return;
    }
    if (this.deepFixState) {
      void vscode.window.showInformationMessage('当前有修复任务在执行，请稍后再试。');
      return;
    }
    if (this.previewPanel) {
      this.previewPanel.reveal();
      void vscode.window.showInformationMessage('已有预览窗口打开，请先应用或取消。');
      return;
    }

    const pomFile = path.join(root, 'pom.xml');
    const openPom = vscode.workspace.textDocuments.find(
      (document) => document.uri.fsPath.toLowerCase() === pomFile.toLowerCase()
    );
    if (openPom?.isDirty) {
      void vscode.window.showWarningMessage('pom.xml 有未保存的修改，请先保存后再执行依赖升级。');
      return;
    }

    // 面板与 CLI/MCP 走同一条路：先出 Plan V3（plan.json + pom.diff），再按 planId + pomHash 落盘。
    let plan: ReturnType<typeof createUpgradePlan>;
    try {
      plan = createUpgradePlan(root, result.issues);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `生成升级计划失败：${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    const planFile = plan.plan;
    if (planFile.candidates.length === 0) {
      const detail = planFile.skipped.length
        ? planFile.skipped
            .slice(0, 5)
            .map((item) => `· ${item.packageName}：${item.reason}`)
            .join('\n')
        : '· 没有带修复版本的直接依赖漏洞';
      void vscode.window.showInformationMessage(`没有可直接升级的依赖：\n${detail}`);
      return;
    }
    this.log(`升级计划 ${planFile.planId}：${planFile.groups.map((group) => `${group.name} ${group.candidates.length}`).join(' / ')}`);

    let pool: typeof planFile.candidates;
    /** 跨大版本（如 8.x → 13.x）不进一键升级：这类升级通常伴随 API/驱动协议变化，需人工评估 */
    const crossLine = planFile.candidates.filter((item) => item.crossLine);
    if (packageName) {
      const matched = planFile.candidates.find((item) => item.packageName === packageName);
      if (!matched) {
        const reason = planFile.skipped.find((item) => item.packageName === packageName)?.reason;
        void vscode.window.showInformationMessage(
          `${packageName} 不在可自动升级范围${reason ? `：${reason}` : ''}。`
        );
        return;
      }
      if (matched.crossLine) {
        void vscode.window.showInformationMessage(
          `${packageName} 的修复版本 ${matched.to} 跨大版本（当前 ${matched.from}），不做一键升级，请人工评估。`
        );
        return;
      }
      pool = [matched];
    } else {
      pool = planFile.candidates.filter((item) => !item.crossLine);
      if (crossLine.length) {
        this.log(
          `跨大版本需人工处理：${crossLine
            .map((item) => `${item.packageName} ${item.from}→${item.to}`)
            .join('，')}`
        );
      }
    }

    const original = fs.readFileSync(pomFile, 'utf8');
    // 展示用逐条 diff 来自同一个 applyUpgrade，与实际落盘结果一致；累积顺序与 plan 一致
    let model = original;
    const entries: UpgradePreviewEntry[] = [];
    for (const item of pool) {
      const applied = applyUpgrade(model, planCandidateToUpgrade(planFile, item));
      if (!applied) {
        continue;
      }
      model = applied.text;
      entries.push({
        packageName: item.packageName,
        from: item.from,
        to: item.to,
        cveCount: item.cveCount,
        mode: item.mode,
        source: item.source,
        affects: item.affects,
        note: item.note,
        alternatives: [item.to],
        changes: applied.changes
      });
    }
    if (entries.length === 0) {
      void vscode.window.showInformationMessage('没有可在 pom.xml 中定位到的升级项。');
      return;
    }

    const profile = detectProjectProfile(root);
    const projectParts = [
      profile.javaVersion ? `Java ${profile.javaVersion}` : '',
      profile.springBootVersion ? `Spring Boot ${profile.springBootVersion} → ${planFile.project.frameworkTarget ?? '未声明'}` : ''
    ].filter(Boolean);
    const decision = await this.showUpgradePreview(
      entries,
      planFile.skipped.map((item) => ({ packageName: item.packageName, reason: item.reason })),
      projectParts.join(' · ')
    );
    if (!decision) {
      this.log('用户取消了依赖升级预览');
      return;
    }
    const chosen = pool.filter((item) => decision.packages.includes(item.packageName));
    if (chosen.length === 0) {
      return;
    }
    this.fixCache = undefined;

    this.beginDeepFix('写入 pom', 2);
    this.log(
      `开始升级依赖（计划 ${planFile.planId}，${chosen.length} 项）：${chosen
        .map((item) => `${item.packageName} ${item.from}→${item.to}`)
        .join(', ')}`
    );
    let compiled = false;
    let appliedCount = 0;
    try {
      const applied = applyUpgradePlan(root, {
        planId: planFile.planId,
        write: true,
        expectedHash: planFile.pomHash,
        packages: chosen.map((item) => item.packageName)
      });
      if (!applied.ok) {
        void vscode.window.showErrorMessage(`写入 pom 失败：${applied.reason ?? '未知原因'}`);
        return;
      }
      appliedCount = applied.applied?.length ?? chosen.length;
      this.setDeepFixStage('校验编译');
      const build = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '质量中心：升级依赖后校验编译…',
          cancellable: false
        },
        () => run('mvn', ['-B', '-q', ...mavenMirrorArgs(), '-DskipTests', 'compile'], root, 20 * 60_000)
      );
      if (build.code !== 0) {
        const revert = revertUpgradePlan(root, planFile.planId);
        const tail = (build.stderr || build.stdout)
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-6)
          .join('\n');
        const rollback = revert.ok
          ? '已回滚到计划前快照'
          : `回滚失败：${revert.reason ?? '未知原因'}（请先确认 pom.xml 状态）`;
        this.log(`依赖升级后编译失败，${rollback}：\n${tail}`);
        const pick = await vscode.window.showErrorMessage(
          `依赖升级后编译失败，${rollback}：\n${tail}`,
          '复制给 AI',
          '查看日志'
        );
        if (pick === '复制给 AI') {
          await vscode.env.clipboard.writeText(
            buildAgentPrompt(root, {
              failure: `依赖升级后编译失败，${rollback}。计划 ${planFile.planId}。Maven 输出：\n${tail}`
            })
          );
          void vscode.window.showInformationMessage(
            '已复制给 AI：包含失败日志、当前计划、分组顺序与「一次一组、失败即回滚」的硬性规则。'
          );
        } else if (pick === '查看日志') {
          this.output?.show(true);
        }
        return;
      }
      compiled = true;
      this.log('依赖升级通过编译校验');
    } finally {
      this.deepFixState = null;
      this.push();
    }

    if (compiled) {
      await this.scanAndPush();
      const state = checkUpgradePlan(root, planFile.planId);
      const leftover =
        state.state === 'applied'
          ? ''
          : `计划还有 ${(state.total ?? 0) - (state.appliedCount ?? 0)} 个候选未落盘` +
            `${state.nextGroup ? `（下一组 ${state.nextGroup}）` : ''}，可用「复制给 AI 继续」分批推进。`;
      void vscode.window.showInformationMessage(
        `已升级 ${appliedCount} 个依赖并通过编译校验，已重新扫描。${leftover}`
      );
      const spring = chosen.find(
        (item) =>
          item.groupId === 'org.springframework.boot' && (item.mode === 'parent' || item.mode === 'bom')
      );
      if (spring) {
        const bootVersion = spring.to;
        const answer = await vscode.window.showInformationMessage(
          `Spring Boot 已升级到 ${bootVersion} 并通过编译。是否继续执行代码级迁移？` +
            '（rewrite-spring，会改动业务代码，执行前可预览 diff）',
          '执行代码迁移',
          '稍后'
        );
        if (answer === '执行代码迁移') {
          await this.deepFix({
            recipes: ['org.openrewrite.java.spring.boot2.UpgradeSpringBoot_2_7'],
            label: `Spring Boot ${bootVersion} 代码迁移`
          });
        }
      }
    }
  }

  /**
   * 向导第 1 步：只生成计划，不碰 pom。
   * 与 CLI/MCP 共用 createUpgradePlan，避免面板另起一套候选算法。
   */
  private async createPlanOnly(): Promise<void> {
    const root = this.runner.root();
    const result = this.runner.result;
    if (!root || !result) {
      void vscode.window.showInformationMessage('还没有扫描结果，请先执行扫描。');
      return;
    }
    try {
      const plan = createUpgradePlan(root, result.issues, { reuse: true }).plan;
      if (plan.candidates.length === 0) {
        const detail = plan.skipped.slice(0, 5).map((item) => `· ${item.packageName}：${item.reason}`).join('\n');
        void vscode.window.showInformationMessage(`没有可直接升级的依赖${detail ? `：\n${detail}` : ''}`);
        return;
      }
      const groups = plan.groups.map((group) => `${group.label} ${group.candidates.length} 项`).join(' · ');
      const first = plan.groups[0];
      const pick = await vscode.window.showInformationMessage(
        `计划 ${plan.planId} 已生成：${groups}。建议先升级「${first ? PLAN_GROUP_LABEL[first.name] : ''}」。`,
        '升级第一组',
        '打开交接'
      );
      if (pick === '升级第一组') {
        await this.upgradeNextGroup();
      } else if (pick === '打开交接') {
        await this.openHandoffFile();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `生成升级计划失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
    this.push();
  }

  /**
   * 向导主入口：只升级当前一组，组后立刻跑策略门禁。
   * 成功自动提示下一组；失败保留现场，并把 Maven 报错翻译成原因/影响/建议。
   */
  private async upgradeNextGroup(): Promise<void> {
    this.log('向导：收到「只升级当前组」');
    const root = this.runner.root();
    const result = this.runner.result;
    if (!root || !result) {
      void vscode.window.showInformationMessage('还没有扫描结果，请先执行扫描。');
      return;
    }
    if (this.deepFixState) {
      void vscode.window.showInformationMessage('当前有修复任务在执行，请稍后再试。');
      return;
    }
    if (this.previewPanel) {
      this.previewPanel.reveal();
      void vscode.window.showInformationMessage('已有预览窗口打开，请先应用或取消。');
      return;
    }
    const pomFile = path.join(root, 'pom.xml');
    const openPom = vscode.workspace.textDocuments.find(
      (document) => document.uri.fsPath.toLowerCase() === pomFile.toLowerCase()
    );
    if (openPom?.isDirty) {
      void vscode.window.showWarningMessage('pom.xml 有未保存的修改，请先保存后再执行升级。');
      return;
    }

    let planFile: ReturnType<typeof createUpgradePlan>['plan'];
    try {
      planFile = createUpgradePlan(root, result.issues, { reuse: true }).plan;
    } catch (error) {
      void vscode.window.showErrorMessage(
        `生成升级计划失败：${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    if (planFile.candidates.length === 0) {
      void vscode.window.showInformationMessage('没有可直接升级的依赖，先重新扫描确认。');
      return;
    }

    const state = checkUpgradePlan(root, planFile.planId);
    const group = state.nextGroup;
    if (!group) {
      const pick = await vscode.window.showInformationMessage(
        `计划 ${planFile.planId} 的候选都已落盘，下一步是构建门禁。`,
        '跑构建门禁',
        '打开交接'
      );
      if (pick === '跑构建门禁') {
        await this.buildGate();
      } else if (pick === '打开交接') {
        await this.openHandoffFile();
      }
      return;
    }

    const groupCandidates = planFile.candidates.filter((item) => item.group === group);
    const cveCount = groupCandidates.reduce((sum, item) => sum + item.cveCount, 0);
    const label = PLAN_GROUP_LABEL[group];
    const crossLine = group === 'cross-line';
    const actionLabel = crossLine ? '已确认跨大版本，继续' : '升级这一组';
    const confirm = await vscode.window.showWarningMessage(
      `执行「${label}」：${groupCandidates.length} 项，涉及 ${cveCount} 条漏洞。` +
        `写入后会跑构建门禁；失败会保留现场并给出原因。`,
      { modal: true },
      actionLabel,
      '稍后'
    );
    if (confirm !== actionLabel) {
      return;
    }

    const current = fs.readFileSync(pomFile, 'utf8');
    this.beginDeepFix('写入 pom', 2);
    this.log(
      `向导升级「${label}」：${groupCandidates.map((item) => `${item.packageName} ${item.from}→${item.to}`).join(', ')}`
    );
    try {
      const applied = applyUpgradePlan(root, {
        planId: planFile.planId,
        write: true,
        expectedHash: hashText(current),
        group,
        allowCrossLine: crossLine
      });
      if (!applied.ok) {
        this.deepFixState = null;
        this.push();
        void vscode.window.showErrorMessage(`写入 pom 失败：${applied.reason ?? '未知原因'}`);
        return;
      }

      this.setDeepFixStage('构建门禁');
      const build = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `质量中心：「${label}」已写入，正在跑构建门禁…`,
          cancellable: false
        },
        () =>
          buildProject(root, (line) => {
            if (/^\[INFO\] (Building|BUILD|---)|^\[ERROR\]/.test(line)) {
              this.log(line.replace(/^\[INFO\]\s*/, ''));
            }
          })
      );
      this.deepFixState = null;
      this.push();

      if (!build.ok) {
        const explanation = explainBuildFailure(root);
        this.log(`「${label}」构建失败：${explanation.cause}\n${explanation.suggestion}`);
        const pick = await vscode.window.showErrorMessage(
          `「${label}」构建失败，已保留现场（未自动回滚）。\n` +
            `原因：${explanation.cause}\n影响：${explanation.impact}\n建议：${explanation.suggestion}`,
          { modal: true },
          '回滚到计划前',
          '查看日志',
          '复制给 AI'
        );
        if (pick === '回滚到计划前') {
          await this.rollbackPlan(planFile.planId);
        } else if (pick === '查看日志') {
          await this.openBuildLog();
        } else if (pick === '复制给 AI') {
          await vscode.env.clipboard.writeText(
            buildAgentPrompt(root, {
              failure: `「${label}」构建失败。原因：${explanation.cause}\n影响：${explanation.impact}\n建议：${explanation.suggestion}`
            })
          );
          void vscode.window.showInformationMessage('已复制给 AI：包含失败原因、当前计划与「一次一组」的硬性规则。');
        }
        return;
      }

      const after = checkUpgradePlan(root, planFile.planId);
      await this.scanAndPush();
      if (after.state === 'applied') {
        const pick = await vscode.window.showInformationMessage(
          `「${label}」已升级并通过构建，计划全部落盘。下一步复扫验收。`,
          '复扫验收',
          '打开交接'
        );
        if (pick === '复扫验收') {
          await this.scanAndPush(true);
        } else if (pick === '打开交接') {
          await this.openHandoffFile();
        }
      } else {
        const nextGroup = after.nextGroup;
        const nextCount = nextGroup
          ? planFile.candidates.filter((item) => item.group === nextGroup).length
          : 0;
        const pick = await vscode.window.showInformationMessage(
          `「${label}」已升级并通过构建（${after.appliedCount ?? 0}/${after.total ?? 0}）。` +
            `${nextGroup ? `下一组：${PLAN_GROUP_LABEL[nextGroup]}（${nextCount} 项）。` : ''}`,
          '继续下一组',
          '打开交接',
          '稍后'
        );
        if (pick === '继续下一组') {
          await this.upgradeNextGroup();
        } else if (pick === '打开交接') {
          await this.openHandoffFile();
        }
      }
    } finally {
      if (this.deepFixState) {
        this.deepFixState = null;
        this.push();
      }
    }
  }

  /** 单独跑一次策略门禁：构建 + 写 build-result.json，失败给翻译 */
  private async buildGate(): Promise<void> {
    const root = this.runner.root();
    if (!root) {
      void vscode.window.showInformationMessage('还没有打开项目。');
      return;
    }
    if (this.deepFixState) {
      void vscode.window.showInformationMessage('当前有任务在执行，请稍后再试。');
      return;
    }
    const build = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '质量中心：跑构建门禁…',
        cancellable: false
      },
      () =>
        buildProject(root, (line) => {
          if (/^\[INFO\] (Building|BUILD|---)|^\[ERROR\]/.test(line)) {
            this.log(line.replace(/^\[INFO\]\s*/, ''));
          }
        })
    );
    this.push();
    if (!build.ok) {
      const explanation = explainBuildFailure(root);
      const pick = await vscode.window.showErrorMessage(
        `构建失败。\n原因：${explanation.cause}\n影响：${explanation.impact}\n建议：${explanation.suggestion}`,
        { modal: true },
        '查看日志'
      );
      if (pick === '查看日志') {
        await this.openBuildLog();
      }
      return;
    }
    const pick = await vscode.window.showInformationMessage(
      `构建通过（${build.seconds.toFixed(1)} 秒，门禁 ${build.gate ?? 'package'}）。`,
      '复扫验收',
      '打开交接'
    );
    if (pick === '复扫验收') {
      await this.scanAndPush(true);
    } else if (pick === '打开交接') {
      await this.openHandoffFile();
    }
  }

  /** 把最近一次构建失败翻译成三段，而不是让用户自己读 Maven 日志 */
  private async showBuildExplanation(): Promise<void> {
    const root = this.runner.root();
    if (!root) {
      return;
    }
    const explanation = explainBuildFailure(root);
    if (explanation.ok) {
      void vscode.window.showInformationMessage(explanation.cause);
      return;
    }
    const pick = await vscode.window.showErrorMessage(
      `原因：${explanation.cause}\n影响：${explanation.impact}\n建议：${explanation.suggestion}`,
      { modal: true },
      '回滚到计划前',
      '查看日志',
      '复制给 AI'
    );
    if (pick === '回滚到计划前') {
      let planId = '';
      try {
        planId = checkUpgradePlan(root).planId;
      } catch {
        planId = '';
      }
      if (planId) {
        await this.rollbackPlan(planId);
      } else {
        void vscode.window.showInformationMessage('没有可回滚的升级计划。');
      }
    } else if (pick === '查看日志') {
      await this.openBuildLog();
    } else if (pick === '复制给 AI') {
      await vscode.env.clipboard.writeText(
        buildAgentPrompt(root, {
          failure: `原因：${explanation.cause}\n影响：${explanation.impact}\n建议：${explanation.suggestion}`
        })
      );
      void vscode.window.showInformationMessage('已复制给 AI。');
    }
  }

  private async rollbackPlan(planId: string): Promise<void> {
    const root = this.runner.root();
    if (!root) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      '回滚会把 pom.xml 恢复到「计划生成前」，已完成的分组也会一起退回。确认继续？',
      { modal: true },
      '回滚到计划前',
      '先不回滚'
    );
    if (confirm !== '回滚到计划前') {
      return;
    }
    const result = revertUpgradePlan(root, planId);
    this.push();
    if (!result.ok) {
      void vscode.window.showErrorMessage(`回滚失败：${result.reason ?? '未知原因'}`);
      return;
    }
    void vscode.window.showInformationMessage('已回滚到计划前快照。重新扫描后会给出新的计划。');
  }

  private async revertLatestPlan(): Promise<void> {
    const root = this.runner.root();
    if (!root) {
      return;
    }
    try {
      const plan = readUpgradePlan(root);
      await this.rollbackPlan(plan.planId);
    } catch (error) {
      void vscode.window.showInformationMessage(
        `没有可回滚的计划：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** 重新检测 MCP：配置是否存在、启动器是否齐全、服务是否响应 tools/list */
  private async refreshMcpStatus(): Promise<void> {
    const root = this.runner.root();
    if (!root) {
      this.mcpStatus = {
        state: 'missing',
        label: 'MCP 未配置',
        detail: '还没有打开项目，无法检测。'
      };
      this.push();
      return;
    }
    this.mcpStatus = { state: 'checking', label: '检测 MCP…', detail: '正在启动 qc.cjs mcp 做协议自检。' };
    this.push();
    try {
      this.mcpStatus = await probeMcp(root);
    } catch (error) {
      this.mcpStatus = {
        state: 'broken',
        label: 'MCP 检测失败',
        detail: error instanceof Error ? error.message : String(error)
      };
    }
    this.push();
    await this.maybePromptMcpInstall();
  }

  /** 面板首次发现 MCP 未配置/异常时提示安装；设置里可关闭 */
  private async maybePromptMcpInstall(): Promise<void> {
    if (this.mcpPrompted) {
      return;
    }
    if (this.mcpStatus.state !== 'missing' && this.mcpStatus.state !== 'broken') {
      return;
    }
    if (!vscode.workspace.getConfiguration('qualityCenter').get<boolean>('mcp.notifyMissing', true)) {
      return;
    }
    this.mcpPrompted = true;
    const pick = await vscode.window.showWarningMessage(
      `质量中心：${this.mcpStatus.label}。${this.mcpStatus.detail}`,
      '生成/修复 MCP 配置',
      '稍后'
    );
    if (pick === '生成/修复 MCP 配置') {
      await this.setupMcp();
    }
  }

  private async setupMcp(): Promise<void> {
    const root = this.runner.root();
    if (!root) {
      return;
    }
    await vscode.commands.executeCommand('qualityCenter.integrateAll');
    await this.refreshMcpStatus();
  }

  private async openMcpConfig(): Promise<void> {
    const root = this.runner.root();
    if (!root) {
      return;
    }
    const candidates = ['.trae/mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.mcp.json'];
    const file = candidates.map((item) => path.join(root, item)).find((item) => fs.existsSync(item));
    if (!file) {
      void vscode.window.showInformationMessage('还没有生成 MCP 配置。先点「接入」生成。');
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
  }

  /** 复制“全权推进”指令：AI 按 qc next 循环执行，而不是每步等用户点按钮 */
  private async copyDrivePrompt(): Promise<void> {
    const root = this.runner.root();
    if (!root) {
      void vscode.window.showInformationMessage('还没有打开项目。');
      return;
    }
    await vscode.env.clipboard.writeText(
      '使用 quality-center MCP：先调用 quality_agent_brief（mode=autopilot）；先做一次目标确认（范围、JDK/框架边界、门禁），确认后连续执行到收尾，不要每步停下等我再发起。' +
        '默认 Java 8、package 门禁，允许属性覆盖与最小代码修复；只有 JDK 11/17/21、Spring Boot 3、跨线无兼容版本等硬阻塞才再次询问，最后必须 quality_scan 复验。' +
        '没有 MCP 时运行 node .quality-center/bin/qc.cjs prompt . --drive 后照它执行。'
    );
    const pick = await vscode.window.showInformationMessage(
      '已复制 MCP 入口：AI 会先做一次目标确认，然后按 autopilot 连续执行并在最后复扫。',
      '打开交接'
    );
    if (pick === '打开交接') {
      await this.openHandoffFile();
    }
  }

  /** 失败时要打开真正的构建日志文件，而不是插件输出通道 */
  private async openBuildLog(): Promise<void> {
    const root = this.runner.root();
    if (!root) {
      return;
    }
    const explanation = explainBuildFailure(root);
    if (!explanation.logFile) {
      this.output?.show(true);
      return;
    }
    const file = path.resolve(root, explanation.logFile);
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document, { preview: false });
    } catch {
      this.output?.show(true);
    }
  }

  /** 打开/生成一页交接：新会话、新 Agent 或人接手时先看它 */
  private async openHandoffFile(): Promise<void> {
    this.log('向导：收到「打开交接」');
    const root = this.runner.root();
    if (!root) {
      return;
    }
    try {
      const next = buildNextAction(root, { writeHandoff: true });
      if (!next.handoffFile) {
        return;
      }
      const file = path.resolve(root, next.handoffFile);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `打开交接文件失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * 依赖树 + BOM 索引，用于判断版本来源与联动关系。
   * 按 pom 内容哈希缓存，避免每次打开预览都重新跑 Maven。
   */
  private depContextCache?: { key: string; context: UpgradeContext };

  /** 解析依赖树并生成升级方案；进度条按「解析依赖树 → 对齐 BOM 版本」展示两只猫 */
  private async buildUpgradePlan(root: string): Promise<ReturnType<typeof planUpgrades>> {
    this.beginDeepFix('解析依赖树', 2);
    try {
      const context = await this.loadUpgradeContext(root);
      this.setDeepFixStage('对齐 BOM 版本');
      return planUpgrades(root, this.runner.result?.issues ?? [], context);
    } finally {
      this.deepFixState = null;
      this.push();
    }
  }

  private async loadUpgradeContext(root: string): Promise<UpgradeContext> {
    const pomFile = path.join(root, 'pom.xml');
    let pom = '';
    try {
      pom = fs.readFileSync(pomFile, 'utf8');
    } catch {
      return {};
    }
    const key = createHash('sha1').update(pom).digest('hex');
    if (this.depContextCache?.key === key) {
      return this.depContextCache.context;
    }

    // 框架目标走统一的策略文件（.quality-center/upgrade-policy.json + Java 版本推导），
    // 面板与 CLI/MCP 必须同一个口径，否则面板会把 spring-* 逐个推到 7.x。
    const loaded = loadPolicy(root, pom);
    const context: UpgradeContext = {
      frameworkTarget: loaded.frameworkTarget,
      currentJavaVersion: loaded.javaVersion,
      targetJavaVersion: loaded.targetJavaVersion,
      allowDependencyManagement: loaded.policy.allowDependencyManagement
    };
    if (loaded.frameworkTarget) {
      this.log(`框架目标版本 ${loaded.frameworkTarget}（${loaded.sources[0] ?? '策略推导'}）`);
    }
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '质量中心：解析依赖树与 BOM 版本…',
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: 'mvn dependency:tree' });
          const outDir = path.join(os.tmpdir(), 'quality-center');
          fs.mkdirSync(outDir, { recursive: true });
          const outFile = path.join(outDir, `dependency-tree-${key.slice(0, 8)}.txt`);
          fs.rmSync(outFile, { force: true });
          const outcome = await run(
            'mvn',
            ['-B', '-q', ...mavenMirrorArgs(), 'dependency:tree', '-Dverbose', `-DoutputFile=${outFile}`],
            root,
            10 * 60_000
          );
          const text = fs.existsSync(outFile)
            ? fs.readFileSync(outFile, 'utf8')
            : `${outcome.stdout}\n${outcome.stderr}`;
          if (outcome.code !== 0 && !text.trim()) {
            this.log('解析依赖树失败，升级预览将只依据扫描结果');
          }
          context.nodes = parseDependencyTree(text);

          progress.report({ message: '读取 BOM 管理版本' });
          const repo = await localRepository(root);
          context.managed = await indexBomManagement(parseBomRefs(pom), repo);
          this.log(
            `依赖树 ${context.nodes.size} 个组件；BOM 索引 ${context.managed.size} 个受管版本`
          );
        }
      );
    } catch (error) {
      this.log(`解析依赖信息失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.depContextCache = { key, context };
    return context;
  }

  /** 项目画像（Java / Spring Boot / JUnit），按 pom 修改时间缓存，避免每次 push 都重新解析 */
  private profileCache?: { key: string; profile: ProjectProfile };

  private projectProfile(root: string): ProjectProfile {
    try {
      const stat = fs.statSync(path.join(root, 'pom.xml'));
      const key = `${stat.mtimeMs}:${stat.size}`;
      if (this.profileCache?.key === key) {
        return this.profileCache.profile;
      }
      const profile = detectProjectProfile(root);
      this.profileCache = { key, profile };
      return profile;
    } catch {
      return {};
    }
  }

  /** discover 结果与项目无关，缓存一次即可 */
  private discoverCache?: RecipeDefinition[];
  private discoverInFlight?: Promise<RecipeDefinition[]>;

  /** 通过 rewrite:discover 列出类路径上的全部配方，作为精选清单之外的扩展 */
  private async discoverRecipes(root: string): Promise<RecipeDefinition[]> {
    if (this.discoverCache) {
      return this.discoverCache;
    }
    if (this.discoverInFlight) {
      return this.discoverInFlight;
    }
    this.discoverInFlight = (async () => {
      const outcome = await run(
        'mvn',
        [
          '-B',
          ...mavenMirrorArgs(),
          '-Dfile.encoding=UTF-8',
          '-Ddetail=true',
          `-Drewrite.recipeArtifactCoordinates=${DEFAULT_RECIPE_ARTIFACTS.join(',')}`,
          `org.openrewrite.maven:rewrite-maven-plugin:${RECIPE_PLUGIN_VERSION}:discover`
        ],
        root,
        5 * 60_000
      );
      const items = parseDiscoverOutput(`${outcome.stdout}\n${outcome.stderr}`);
      if (outcome.code !== 0 && items.length === 0) {
        throw new Error('rewrite:discover 执行失败');
      }
      const recipes = classifyDiscoveredRecipes(items);
      this.discoverCache = recipes;
      this.log(`discover 发现 ${items.length} 个配方，新增 ${recipes.length} 个可选配方（含官方描述）`);
      return recipes;
    })();
    try {
      return await this.discoverInFlight;
    } finally {
      this.discoverInFlight = undefined;
    }
  }

  /** 开启「显示全部配方」时，后台加载一次 discover 结果并刷新面板 */
  private maybeDiscover(): void {
    const root = this.runner.root();
    const config = vscode.workspace.getConfiguration('qualityCenter');
    if (!root || !config.get<boolean>('openRewrite.showAllRecipes', false) || this.discoverCache) {
      return;
    }
    void this.discoverRecipes(root).then(
      () => this.push(),
      (error) => this.log(`加载全部配方失败：${error instanceof Error ? error.message : String(error)}`)
    );
  }

  /** 面板内设置：写入工作区配置后立即重新扫描 */
  private async saveScanSettings(options?: ScanSettingsInput): Promise<void> {
    if (!options) {
      return;
    }
    const config = vscode.workspace.getConfiguration('qualityCenter');
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    const updates: [string, boolean | undefined][] = [
      ['checkstyle.enabled', options.checkstyle],
      ['gitleaks.enabled', options.gitleaks],
      ['trivy.enabled', options.trivy],
      ['spotbugs.enabled', options.spotbugs],
      ['qcsec.enabled', options.qcsec],
      ['astgrep.enabled', options.astgrep],
      ['scanOnSave', options.scanOnSave]
    ];
    for (const [key, value] of updates) {
      if (typeof value === 'boolean') {
        await config.update(key, value, target);
      }
    }
    if (Array.isArray(options.recipes)) {
      await config.update('openRewrite.recipes', options.recipes, target);
    }
    if (typeof options.autoRecipes === 'boolean') {
      await config.update('openRewrite.autoRecipes', options.autoRecipes, target);
    }
    if (typeof options.showAllRecipes === 'boolean') {
      await config.update('openRewrite.showAllRecipes', options.showAllRecipes, target);
    }
    // 配方变化后，预演缓存不再可信
    this.fixCache = undefined;
    this.log(
      `扫描设置已更新：${updates
        .filter(([, value]) => typeof value === 'boolean')
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')}` +
        (Array.isArray(options.recipes)
          ? `；配方=${options.recipes.length} 个，自动低风险=${options.autoRecipes !== false}`
          : '')
    );
    this.push();
    this.maybeDiscover();
    void vscode.window.showInformationMessage('扫描设置已保存，下次扫描生效。');
  }

  /** 预演缓存键：HEAD + 工作区改动 + 配方配置，任一变化都会重新 dry-run */
  private async fixPreviewKey(
    root: string,
    statusText: string,
    recipes: string[],
    artifacts: string[],
    version: string
  ): Promise<string> {
    const [head, diff] = await Promise.all([
      run('git', ['rev-parse', 'HEAD'], root, 15_000),
      run('git', ['diff'], root, 30_000)
    ]);
    return createHash('sha1')
      .update(head.stdout.trim())
      .update(statusText)
      .update(diff.stdout)
      .update(recipes.join(','))
      .update(artifacts.join(','))
      .update(version)
      .digest('hex');
  }

  /** 在编辑器区域打开修复预览面板，返回用户勾选的文件；关闭面板视为取消 */
  private showFixPreview(
    patchFile: string | undefined,
    files: string[],
    info: {
      label?: string;
      project: string;
      recipes: string[];
      advice: string[];
      dirtyCount: number;
      selectable: boolean;
    }
  ): Promise<{ files: string[] } | null> {
    const panel = vscode.window.createWebviewPanel(
      'qualityCenter.deepFixPreview',
      '深度修复预览',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.previewPanel = panel;
    panel.webview.html = buildDeepFixPreviewHtml(createNonce(), {
      ...info,
      patchFile,
      files
    });

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: { files: string[] } | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.previewPanel === panel) {
          this.previewPanel = undefined;
        }
        resolve(value);
      };
      panel.onDidDispose(() => finish(null));
      panel.webview.onDidReceiveMessage((message: { type?: string; files?: string[] }) => {
        if (message.type === 'cancel') {
          finish(null);
          panel.dispose();
          return;
        }
        if (message.type !== 'apply') {
          return;
        }
        const picks = (message.files ?? []).filter((file) => files.includes(file));
        if (!picks.length) {
          return;
        }
        if (this.runner.isRunning) {
          void vscode.window.showInformationMessage('扫描进行中，请稍后再应用修复。');
          return;
        }
        finish({ files: picks });
        panel.dispose();
      });
    });
  }

  /** 依赖升级预览页：展示版本来源、冲突与 pom 改动，勾选后执行 */
  private showUpgradePreview(
    entries: UpgradePreviewEntry[],
    skipped: Array<{ packageName: string; reason: string }>,
    project: string
  ): Promise<{ packages: string[]; versions: Record<string, string> } | null> {
    const panel = vscode.window.createWebviewPanel(
      'qualityCenter.upgradePreview',
      '依赖升级预览',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.previewPanel = panel;
    panel.webview.html = buildUpgradePreviewHtml(createNonce(), {
      project: project || 'Maven 项目',
      entries,
      skipped
    });

    const known = new Set(entries.map((entry) => entry.packageName));
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: { packages: string[]; versions: Record<string, string> } | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.previewPanel === panel) {
          this.previewPanel = undefined;
        }
        resolve(value);
      };
      panel.onDidDispose(() => finish(null));
      panel.webview.onDidReceiveMessage(
        (message: { type?: string; packages?: string[]; versions?: Record<string, string> }) => {
          if (message.type === 'cancel') {
            finish(null);
            panel.dispose();
            return;
          }
          if (message.type === 'copyAgentPrompt') {
            const root = this.runner.root();
            if (root) {
              void vscode.env.clipboard.writeText(buildAgentPrompt(root));
              void vscode.window.showInformationMessage(
                '已复制给 AI：当前计划、分组顺序与硬性规则都在里面，粘贴到编辑器 AI 对话框即可继续。'
              );
            }
            return;
          }
          if (message.type !== 'apply') {
            return;
          }
          const picks = (message.packages ?? []).filter((name) => known.has(name));
          if (!picks.length) {
            return;
          }
          if (this.runner.isRunning) {
            void vscode.window.showInformationMessage('扫描进行中，请稍后再执行依赖升级。');
            return;
          }
          const versions: Record<string, string> = {};
          for (const name of picks) {
            const version = message.versions?.[name];
            if (version) {
              versions[name] = version;
            }
          }
          finish({ packages: picks, versions });
          panel.dispose();
        }
      );
    });
  }

  /** 针对单条问题所属规则执行深度修复 */
  private async deepFixRule(id: number): Promise<void> {
    const issue = this.runner.result?.issues[id - 1];
    if (!issue) {
      return;
    }
    const mapping = RULE_RECIPE[issue.rule];
    if (!mapping) {
      void vscode.window.showInformationMessage(`规则 ${issue.rule} 暂未配置深度修复配方。`);
      return;
    }
    await this.deepFix({
      recipes: [mapping.recipe],
      artifacts: mapping.artifact ? [mapping.artifact] : [],
      label: mapping.label
    });
  }

  /** dry-run 预演，返回将改动的文件与补丁路径，不改动代码 */
  private async previewDeepFix(
    root: string,
    recipes: string[],
    artifacts: string[],
    version: string
  ): Promise<{ files: string[]; patchFile?: string } | null> {
    const startedAt = Date.now();
    const encoding = sourceEncoding(root);
    const args = [
      '-B',
      ...mavenMirrorArgs(),
      `-Dproject.build.sourceEncoding=${encoding}`,
      `-Drewrite.activeRecipes=${recipes.join(',')}`
    ];
    if (artifacts.length > 0) {
      args.push(`-Drewrite.recipeArtifactCoordinates=${artifacts.join(',')}`);
    }
    args.push(`org.openrewrite.maven:rewrite-maven-plugin:${version}:dryRun`);

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '质量中心：预演深度修复（不会改动代码）…',
        cancellable: false
      },
      () => run('mvn', args, root, 20 * 60_000, encodingEnv(encoding))
    );
    if (result.code !== 0) {
      const tail = (result.stderr || result.stdout)
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-6)
        .join('\n');
      this.log(`预演失败：\n${tail}`);
      return null;
    }

    const output = `${result.stdout}\n${result.stderr}`;
    const files = new Set<string>();
    output.split(/\r?\n/).forEach((line) => {
      const match = line.match(/These recipes would make changes to (.+):\s*$/i);
      if (match) {
        files.add(match[1].trim().split(path.sep).join('/'));
      }
    });

    const candidates: string[] = [];
    const patchLine = output.match(/Patch file available:\s*\r?\n\s*([^\r\n]+)/i);
    if (patchLine) {
      candidates.push(patchLine[1].replace(/^\[[A-Z]+\]\s*/, '').trim());
    }
    candidates.push(path.join(root, 'target', 'rewrite', 'rewrite.patch'));
    const patchFile = candidates.find((file) => {
      try {
        return fs.statSync(file).mtimeMs >= startedAt;
      } catch {
        return false;
      }
    });

    if (files.size === 0 && patchFile) {
      const patch = fs.readFileSync(patchFile, 'utf8');
      patch.split(/\r?\n/).forEach((line) => {
        const match = line.match(/^\+\+\+ b\/(.+)$/);
        if (match) {
          files.add(match[1]);
        }
      });
    }
    this.log(`预演结果：${files.size} 个文件，补丁 ${patchFile ?? '未生成'}`);
    return { files: Array.from(files).sort(), patchFile };
  }

  private async copySuggestion(id: number): Promise<void> {
    const suggestion = this.runner.result?.suggestions[id - 1];
    if (!suggestion) {
      return;
    }
    const text = [
      `### 修复建议：${suggestion.title}`,
      `- 可覆盖问题数：${suggestion.impact}`,
      `- 类别：${suggestion.category}`,
      `- 说明：${suggestion.detail}`
    ].join('\n');
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage('已复制修复建议，可直接粘贴给 AI。');
  }

  private async openAgentFile(): Promise<void> {
    const root = this.runner.root();
    if (!root || !this.agentFile) {
      void vscode.window.showInformationMessage('尚未生成 AI 数据文件，请先执行扫描。');
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, this.agentFile)));
    await vscode.window.showTextDocument(document, { preview: true });
  }

  async fixAll(): Promise<void> {
    const issues = this.runner.result?.issues ?? [];
    const targets = issues.filter(isFixable);
    if (targets.length === 0) {
      void vscode.window.showInformationMessage('当前没有可自动修复的问题。');
      return;
    }
    const fileCount = new Set(targets.map((item) => item.file)).size;
    const answer = await vscode.window.showWarningMessage(
      `将自动修复 ${targets.length} 项（涉及 ${fileCount} 个文件）：删除无用/冗余导入、重排修饰符顺序、简化布尔字面量比较。是否继续？`,
      { modal: true },
      '修复'
    );
    if (answer !== '修复') {
      return;
    }
    await this.applyFixes(targets);
  }

  async fixIssue(id: number): Promise<void> {
    const issue = this.runner.result?.issues[id - 1];
    if (!issue || !isFixable(issue)) {
      return;
    }
    await this.applyFixes([issue]);
  }

  private async applyFixes(targets: Issue[]): Promise<void> {
    const outcome = await applyAutoFixes(targets);
    await this.scanAndPush();
    void vscode.window.showInformationMessage(
      `已修复 ${outcome.applied} 项，跳过 ${outcome.skipped} 项。`
    );
  }

  push(override?: { scanning: boolean }): void {
    if (!this.view) {
      return;
    }
    const result = this.runner.result;
    const root = this.runner.root() ?? '';
    if (root) {
      this.ensureWatchers(root);
    }
    const config = vscode.workspace.getConfiguration('qualityCenter');
    const toSnapshot = (issue: Issue, index: number): SnapshotIssue => {
      const relative = issue.file ? path.relative(root, issue.file) : '';
      return {
        id: index + 1,
        source: issue.source,
        severity: issue.severity,
        file: relative.split(path.sep).join('/'),
        abs: issue.file ?? '',
        line: issue.line ?? 0,
        rule: issue.rule,
        message: issue.message,
        link: issue.link ?? '',
        fixable: isFixable(issue),
        deepFixable: issue.source === 'checkstyle' && !!RULE_RECIPE[issue.rule],
        packageName: issue.packageName ?? '',
        installedVersion: issue.installedVersion ?? '',
        fixedVersion: issue.fixedVersion ?? '',
        zhSummary: issue.zhSummary ?? '',
        advice: issue.advice ?? '',
        title: issue.title ?? '',
        description: issue.description ?? '',
        cvss: issue.cvss ?? 0,
        cwe: issue.cwe ?? [],
        references: issue.references ?? [],
        publishedAt: issue.publishedAt ?? '',
        category: issue.category ?? ''
      };
    };
    const issues: SnapshotIssue[] = (result?.issues ?? []).map(toSnapshot);
    const ignored: SnapshotIssue[] = (result?.ignored ?? []).map(toSnapshot);
    let next: ReturnType<typeof buildNextAction> | undefined;
    if (root && fs.existsSync(path.join(root, 'pom.xml'))) {
      try {
        // 只算不写：面板每次 push 都刷新，但 handoff.md 由用户点「打开交接」或 AI 调 quality_next 时再落盘
        next = buildNextAction(root, { writeHandoff: false });
      } catch {
        next = undefined;
      }
    }
    const snapshot: Snapshot = {
      type: 'state',
      run: root ? runSnapshot(root) : undefined,
      scanning: override ? override.scanning : this.runner.isRunning,
      paused: this.runner.isPaused,
      deepFix: this.deepFixState,
      task: this.taskState,
      next,
      scanStartedAt: this.scanStartedAt,
      scanProgress: this.scanProgress,
      finishedAt: result?.finishedAt ?? null,
      issues,
      ignored,
      suggestions: (result?.suggestions ?? []).map((item) => ({
        category: item.category,
        title: item.title,
        detail: item.detail,
        impact: item.impact
      })),
      errors: (result?.errors ?? []).map((error) => ({
        source: SOURCE_LABEL[error.source],
        message: error.message
      })),
      skipped: (result?.skipped ?? []).map((item) => ({
        source: SOURCE_LABEL[item.source],
        reason: item.reason,
        tool: item.tool
      })),
      missingTools: result?.missingTools ?? [],
      agentFile: this.agentFile,
      buildHint: result?.buildHint,
      upgradeEnabled: config.get<boolean>('dependencyUpgrade.enabled', true),
      scanOptions: {
        checkstyle: config.get<boolean>('checkstyle.enabled', true),
        gitleaks: config.get<boolean>('gitleaks.enabled', true),
        trivy: config.get<boolean>('trivy.enabled', true),
        spotbugs: config.get<boolean>('spotbugs.enabled', true),
        qcsec: config.get<boolean>('qcsec.enabled', true),
        astgrep: config.get<boolean>('astgrep.enabled', true),
        scanOnSave: config.get<boolean>('scanOnSave', true),
        recipes: config.get<string[]>('openRewrite.recipes', []),
        autoRecipes: config.get<boolean>('openRewrite.autoRecipes', true),
        showAllRecipes: config.get<boolean>('openRewrite.showAllRecipes', false)
      },
      recipeLibrary:
        config.get<boolean>('openRewrite.showAllRecipes', false) && this.discoverCache
          ? mergeRecipeLibrary(this.discoverCache)
          : RECIPE_LIBRARY,
      recipesDiscovering: this.discoverInFlight !== undefined,
      mcp: this.mcpStatus,
      projectProfile: root ? this.projectProfile(root) : {}
    };
    void this.view.webview.postMessage(snapshot);
  }

  markdown(): string | undefined {
    const result = this.runner.result;
    const root = this.runner.root();
    if (!result || !root) {
      return undefined;
    }
    return toMarkdown(result, root);
  }

  async copyMarkdown(): Promise<void> {
    const text = this.markdown();
    if (!text) {
      void vscode.window.showInformationMessage('还没有扫描结果，请先执行扫描。');
      return;
    }
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage(
      `已复制 ${this.runner.result?.issues.length ?? 0} 个问题到剪贴板，可直接粘贴给 AI。`
    );
  }

  async exportReport(): Promise<void> {
    const text = this.markdown();
    const root = this.runner.root();
    if (!text || !root) {
      void vscode.window.showInformationMessage('还没有扫描结果，请先执行扫描。');
      return;
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(root, 'quality-report.md')),
      filters: { Markdown: ['md'] },
      saveLabel: '保存报告'
    });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    const document = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(document, { preview: false });
  }
}

export async function openIssue(file: string, line: number): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(document, { preview: true });
    if (line > 0) {
      const position = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter
      );
    }
  } catch (err) {
    void vscode.window.showWarningMessage(`无法打开文件：${(err as Error).message}`);
  }
}
