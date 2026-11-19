import * as path from 'path';
import * as vscode from 'vscode';
import { exportForAgent, formatIssueForCopy } from '../agentExport';
import { run } from '../exec';
import { applyAutoFixes, isFixable } from '../fixer';
import { Issue, SOURCE_LABEL } from '../model';
import { toMarkdown } from '../report';
import { ScanRunner } from '../scanner';
import { getHtml, Snapshot, SnapshotIssue } from './html';

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export class QualityViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'qualityCenter.main';

  private view?: vscode.WebviewView;
  private agentFile?: string;

  constructor(private readonly runner: ScanRunner) {}

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
    this.push();
  }

  private async handleMessage(message: {
    type?: string;
    file?: string;
    line?: number;
    url?: string;
    id?: number;
  }): Promise<void> {
    switch (message.type) {
      case 'scan':
        await this.scanAndPush();
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

  async scanAndPush(): Promise<void> {
    if (this.runner.isRunning) {
      return;
    }
    this.push({ scanning: true });
    try {
      await this.runner.scan();
      this.writeAgentFiles();
    } finally {
      this.push();
    }
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

  /** 构建项目后再扫描，用于补齐依赖漏洞所需的构建产物 */
  async buildAndScan(): Promise<void> {
    const root = this.runner.root();
    if (!root) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      '将执行 mvn -DskipTests package 构建项目（可能需要几分钟），完成后自动重新扫描。是否继续？',
      { modal: true },
      '构建并扫描'
    );
    if (answer !== '构建并扫描') {
      return;
    }
    const outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '质量中心：正在构建项目…',
        cancellable: false
      },
      () => run('mvn', ['-B', '-q', '-DskipTests', 'package'], root, 20 * 60_000)
    );
    if (outcome.code !== 0) {
      const tail = (outcome.stderr || outcome.stdout)
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-6)
        .join('\n');
      void vscode.window.showErrorMessage(`构建失败，未执行扫描：\n${tail}`);
      return;
    }
    await this.scanAndPush();
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
      `将自动修复 ${targets.length} 项（涉及 ${fileCount} 个文件）：删除无用/冗余导入、重排修饰符顺序。是否继续？`,
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
    const issues: SnapshotIssue[] = (result?.issues ?? []).map((issue, index) => {
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
        fixable: isFixable(issue)
      };
    });
    const snapshot: Snapshot = {
      type: 'state',
      scanning: override ? override.scanning : this.runner.isRunning,
      finishedAt: result?.finishedAt ?? null,
      issues,
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
        reason: item.reason
      })),
      agentFile: this.agentFile,
      buildHint: result?.buildHint
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
