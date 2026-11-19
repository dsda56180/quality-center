import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { exportForAgent, formatIssueForCopy } from '../agentExport';
import { run } from '../exec';
import { applyAutoFixes, isFixable } from '../fixer';
import { Issue, SOURCE_LABEL } from '../model';
import { toMarkdown } from '../report';
import { ScanRunner } from '../scanner';
import { getHtml, Snapshot, SnapshotIssue } from './html';

const RECIPE_LABELS: Record<string, string> = {
  'org.openrewrite.java.RemoveUnusedImports': '清理无用导入',
  'org.openrewrite.java.RemoveObjectsIsNull': 'Objects.isNull 改为 == null',
  'org.openrewrite.java.ShortenFullyQualifiedTypeReferences': '缩短全限定类名'
};

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
  private deepFixState: { stage: string; startedAt: number } | null = null;
  private output?: vscode.OutputChannel;

  constructor(private readonly runner: ScanRunner) {}

  dispose(): void {
    this.output?.dispose();
  }

  private log(message: string): void {
    if (!this.output) {
      this.output = vscode.window.createOutputChannel('质量中心');
    }
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  }

  private setDeepFixStage(stage: string): void {
    if (this.deepFixState) {
      this.deepFixState.stage = stage;
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
      case 'deepFix':
        await this.deepFix();
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
    if (this.runner.isRunning || this.deepFixState) {
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

  /**
   * 深度修复：调用 OpenRewrite 跑白名单配方。
   * 不改项目 pom，用全限定插件坐标临时加载；因此只支持插件内置类路径自带的配方。
   */
  async deepFix(): Promise<void> {
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

    const recipes = config.get<string[]>('openRewrite.recipes', []);
    if (recipes.length === 0) {
      void vscode.window.showWarningMessage('未配置 OpenRewrite 配方，请先在设置中填写白名单。');
      return;
    }
    const version = config.get<string>('openRewrite.pluginVersion', '5.44.0');
    const recipeArtifacts = config
      .get<string[]>('openRewrite.recipeArtifacts', [])
      .map((item) => item.trim())
      .filter(Boolean);

    const recipeLines = recipes
      .map((recipe) => `· ${RECIPE_LABELS[recipe] ?? recipe}`)
      .join('\n');
    const answer = await vscode.window.showWarningMessage(
      `将执行 ${recipes.length} 个 OpenRewrite 配方：\n${recipeLines}\n\n` +
        (dirtyCount > 0
          ? `检测到 ${dirtyCount} 处未提交改动，会在临时目录做完整备份；修复失败或编译不通过时可恢复到修复前。\n`
          : '') +
        '直接在现有代码上做编译级改写，不会再产生 stash 冲突。完成后自动校验编译。是否继续？',
      { modal: true },
      '执行深度修复'
    );
    if (answer !== '执行深度修复') {
      return;
    }

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

    this.deepFixState = { stage: '准备执行', startedAt: Date.now() };
    this.push();
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
      const outcome = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '质量中心：OpenRewrite 深度修复中…',
          cancellable: false
        },
        () => {
          const args = ['-B', '-q', `-Drewrite.activeRecipes=${recipes.join(',')}`];
          if (recipeArtifacts.length > 0) {
            args.push(`-Drewrite.recipeArtifactCoordinates=${recipeArtifacts.join(',')}`);
          }
          args.push(`org.openrewrite.maven:rewrite-maven-plugin:${version}:run`);
          return run('mvn', args, root, 20 * 60_000);
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
          () => run('mvn', ['-B', '-q', '-DskipTests', 'compile'], root, 20 * 60_000)
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
        fixable: isFixable(issue),
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
        publishedAt: issue.publishedAt ?? ''
      };
    });
    const snapshot: Snapshot = {
      type: 'state',
      scanning: override ? override.scanning : this.runner.isRunning,
      deepFix: this.deepFixState,
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
