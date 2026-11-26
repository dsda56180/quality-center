import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { initMaven } from './maven';
import { QualityViewProvider, openIssue } from './panel/QualityViewProvider';
import { ScanRunner } from './scanner';
import { integrate } from './integrate';
import { detectSetup } from './setupCheck';
import { buildAgentPrompt } from './agentPrompt';

/** 只有可能影响扫描结果的文件才触发保存后扫描 */
const SAVE_SCAN_EXT = /\.(java|xml|properties|ya?ml|toml|json|gradle|kts)$/i;
const IGNORED_DIRS = new Set(['target', 'node_modules', '.git', 'build', 'out']);

async function copyAgentPrompt(
  root: string,
  failure?: string,
  mode: 'assist' | 'drive' = 'assist'
): Promise<void> {
  const text =
    mode === 'drive'
      ? '使用 quality-center MCP：先调用 quality_agent_brief（mode=autopilot）；先做一次目标确认，确认后连续执行到收尾，不要每步停下等我再发起。只有 JDK 11/17/21、Spring Boot 3 等硬阻塞再询问。没有 MCP 时运行 node .quality-center/bin/qc.cjs prompt . --drive 后照它执行。'
      : buildAgentPrompt(root, { failure });
  await vscode.env.clipboard.writeText(text);
  void vscode.window.showInformationMessage(
    mode === 'drive'
      ? '已复制 MCP 入口：AI 会先做一次目标确认，然后按 autopilot 连续执行并在最后复扫。'
      : '已复制给 AI 的启动指令：粘贴到编辑器 AI 对话框（或让 CLI 里的 AI 读 .quality-center/ 与 MCP 工具）即可继续。'
  );
}

async function runIntegrate(root: string, mode: 'auto' | 'all'): Promise<void> {
  const result = integrate(root, { mode, check: false });
  const changed = result.files.filter((item) => item.action === 'created' || item.action === 'updated').length;
  const missingSkill = result.files.find((item) => item.action === 'missing');
  const message =
    changed > 0
      ? `质量中心：已为项目写入 ${changed} 个配置（策略 / 启动器 / Skill / 规则 / MCP）。`
      : '质量中心：项目配置已是最新，无需写入。';
  const detail = missingSkill
    ? `\n未生成：${missingSkill.file}（扩展内缺少源文件，请重新安装扩展）`
    : '\n重新加载窗口后，AI 才会读取这些配置。';
  const choice = await vscode.window.showInformationMessage(`${message}${detail}`, '重载窗口', '复制 AI 启动指令');
  if (choice === '重载窗口') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } else if (choice === '复制 AI 启动指令') {
    await copyAgentPrompt(root);
  }
}

async function maybePromptSetup(context: vscode.ExtensionContext, root: string): Promise<void> {
  if (!fs.existsSync(path.join(root, 'pom.xml'))) {
    return;
  }
  const key = `qualityCenter.setupPrompted:${root}`;
  if (context.globalState.get<boolean>(key)) {
    return;
  }
  const state = detectSetup(root);
  if (state.configured) {
    return;
  }
  const sample = state.missing.slice(0, 3).join('、');
  const choice = await vscode.window.showInformationMessage(
    `本项目还没接入质量中心的 AI 修复流程（缺 ${state.missing.length} 项：${sample}${state.missing.length > 3 ? ' 等' : ''}）。` +
      '配置后 AI 会按标准先出升级计划、不直接改 pom。',
    '一键配置',
    '为所有编辑器配置',
    '稍后',
    '本项目不再提示'
  );
  if (choice === '一键配置') {
    await runIntegrate(root, 'auto');
  } else if (choice === '为所有编辑器配置') {
    await runIntegrate(root, 'all');
  } else if (choice === '本项目不再提示') {
    await context.globalState.update(key, true);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  initMaven(context.storageUri?.fsPath ?? context.globalStorageUri?.fsPath);
  const runner = new ScanRunner(context);
  const provider = new QualityViewProvider(runner);

  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(QualityViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  const projectRoot = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  context.subscriptions.push(
    vscode.commands.registerCommand('qualityCenter.scan', () => provider.scanAndPush(true)),
    vscode.commands.registerCommand('qualityCenter.autoFix', () => provider.fixAll()),
    vscode.commands.registerCommand('qualityCenter.deepFix', () => provider.deepFix()),
    vscode.commands.registerCommand('qualityCenter.copyMarkdown', () => provider.copyMarkdown()),
    vscode.commands.registerCommand('qualityCenter.writeReport', () => provider.exportReport()),
    vscode.commands.registerCommand('qualityCenter.openIssue', (file?: string, line?: number) => {
      if (file) {
        return openIssue(file, line ?? 0);
      }
      return undefined;
    }),
    vscode.commands.registerCommand('qualityCenter.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'qualityCenter')
    ),
    vscode.commands.registerCommand('qualityCenter.upgradeDeps', () => provider.upgradeDependencies()),
    vscode.commands.registerCommand('qualityCenter.integrate', async () => {
      const root = projectRoot();
      if (!root) {
        void vscode.window.showInformationMessage('请先打开一个项目文件夹。');
        return;
      }
      await runIntegrate(root, 'auto');
    }),
    vscode.commands.registerCommand('qualityCenter.integrateAll', async () => {
      const root = projectRoot();
      if (!root) {
        void vscode.window.showInformationMessage('请先打开一个项目文件夹。');
        return;
      }
      await runIntegrate(root, 'all');
    }),
    vscode.commands.registerCommand('qualityCenter.copyAgentPrompt', async () => {
      const root = projectRoot();
      if (!root) {
        void vscode.window.showInformationMessage('请先打开一个项目文件夹。');
        return;
      }
      await copyAgentPrompt(root);
    }),
    vscode.commands.registerCommand('qualityCenter.copyAgentDriverPrompt', async () => {
      const root = projectRoot();
      if (!root) {
        void vscode.window.showInformationMessage('请先打开一个项目文件夹。');
        return;
      }
      await copyAgentPrompt(root, undefined, 'drive');
    })
  );

  // 启动检测：只提示一次，不自动改用户项目
  setTimeout(() => {
    const root = projectRoot();
    if (root) {
      void maybePromptSetup(context, root);
    }
  }, 3000);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const root = projectRoot();
      if (root) {
        void maybePromptSetup(context, root);
      }
    })
  );

  let timer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      const config = vscode.workspace.getConfiguration('qualityCenter');
      if (!config.get<boolean>('scanOnSave', true)) {
        return;
      }
      if (document.uri.scheme !== 'file' || !SAVE_SCAN_EXT.test(document.uri.fsPath)) {
        return;
      }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        return;
      }
      const relative = path.relative(root, document.uri.fsPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return;
      }
      if (relative.split(path.sep).some((segment) => IGNORED_DIRS.has(segment))) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void provider.scanAndPush();
      }, 1500);
    })
  );

  if (vscode.workspace.getConfiguration('qualityCenter').get<boolean>('scanOnStartup', true)) {
    setTimeout(() => {
      void provider.scanAndPush();
    }, 1500);
  }
}

export function deactivate(): void {
  // 无需清理：所有资源已注册到 context.subscriptions
}
