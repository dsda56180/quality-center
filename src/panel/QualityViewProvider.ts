import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { exportForAgent, formatIssueForCopy } from '../agentExport';
import { run } from '../exec';
import { applyAutoFixes, isFixable } from '../fixer';
import { Issue, SOURCE_LABEL } from '../model';
import { detectProjectProfile, ProjectProfile, recipeAdvice } from '../projectProfile';
import { toMarkdown } from '../report';
import { ScanRunner } from '../scanner';
import { mavenMirrorArgs } from '../maven';
import { buildDeepFixPreviewHtml, buildUpgradePreviewHtml, readPatchText, UpgradePreviewEntry } from './deepFixPanel';
import { applyUpgrade, planUpgrades, UpgradeCandidate, UpgradeContext } from '../upgrader';
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
  scanOnSave?: boolean;
  recipes?: string[];
  autoRecipes?: boolean;
  showAllRecipes?: boolean;
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
  private deepFixState: { stage: string; startedAt: number } | null = null;
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
    this.maybeDiscover();
  }

  private async handleMessage(message: {
    type?: string;
    file?: string;
    line?: number;
    url?: string;
    id?: number;
    pkg?: string;
    options?: ScanSettingsInput;
  }): Promise<void> {
    switch (message.type) {
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
      }
    } finally {
      this.scanStartedAt = null;
      this.scanProgress = { done: 0, total: 0, active: [] };
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
      () => run('mvn', ['-B', '-q', ...mavenMirrorArgs(), '-DskipTests', 'package'], root, 20 * 60_000)
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
        this.deepFixState = { stage: '预演修复（不会改动代码）', startedAt: Date.now() };
        this.push();
        this.log('开始 dry-run 预演');
        try {
          const preview = await this.previewDeepFix(root, recipes, recipeArtifacts, version);
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

    this.deepFixState = { stage: '准备执行', startedAt: Date.now() };
    this.push();
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

    const context = await this.loadUpgradeContext(root);
    const plan = planUpgrades(root, result.issues, context);
    if (plan.candidates.length === 0) {
      const detail = plan.skipped.length
        ? plan.skipped
            .slice(0, 5)
            .map((item) => `· ${item.packageName}：${item.reason}`)
            .join('\n')
        : '· 没有带修复版本的直接依赖漏洞';
      void vscode.window.showInformationMessage(`没有可直接升级的依赖：\n${detail}`);
      return;
    }

    let pool: UpgradeCandidate[];
    if (packageName) {
      const matched = plan.candidates.find((item) => item.packageName === packageName);
      if (!matched) {
        const reason = plan.skipped.find((item) => item.packageName === packageName)?.reason;
        void vscode.window.showInformationMessage(
          `${packageName} 不在可自动升级范围${reason ? `：${reason}` : ''}。`
        );
        return;
      }
      pool = [matched];
    } else {
      pool = plan.candidates;
    }

    const original = fs.readFileSync(pomFile, 'utf8');
    const entries = pool
      .map((candidate): UpgradePreviewEntry | undefined => {
        const applied = applyUpgrade(original, candidate);
        if (!applied) {
          return undefined;
        }
        return {
          packageName: candidate.packageName,
          from: candidate.from,
          to: candidate.to,
          cveCount: candidate.cveCount,
          mode: candidate.mode,
          source: candidate.source,
          affects: candidate.affects,
          conflicts: candidate.conflicts,
          note: candidate.note,
          alternatives: candidate.alternatives,
          changes: applied.changes
        };
      })
      .filter((entry): entry is UpgradePreviewEntry => !!entry);
    if (entries.length === 0) {
      void vscode.window.showInformationMessage('没有可在 pom.xml 中定位到的升级项。');
      return;
    }

    const profile = detectProjectProfile(root);
    const projectParts = [
      profile.javaVersion ? `Java ${profile.javaVersion}` : '',
      profile.springBootVersion ? `Spring Boot ${profile.springBootVersion}` : ''
    ].filter(Boolean);
    const decision = await this.showUpgradePreview(entries, plan.skipped, projectParts.join(' · '));
    if (!decision) {
      this.log('用户取消了依赖升级预览');
      return;
    }
    const chosen = pool.filter((item) => decision.packages.includes(item.packageName));
    if (chosen.length === 0) {
      return;
    }

    let text = original;
    for (const item of chosen) {
      const target = decision.versions[item.packageName] || item.to;
      const applied = applyUpgrade(text, item, target);
      if (!applied) {
        void vscode.window.showErrorMessage(
          `未在 pom.xml 中找到 ${item.packageName} ${item.from}，已取消本次升级。`
        );
        return;
      }
      text = applied.text;
    }
    this.fixCache = undefined;

    this.deepFixState = { stage: '升级依赖并校验编译', startedAt: Date.now() };
    this.push();
    this.log(
      `开始升级依赖：${chosen
        .map((item) => `${item.packageName} ${item.from}→${decision.versions[item.packageName] || item.to}`)
        .join(', ')}`
    );
    let compiled = false;
    try {
      fs.writeFileSync(pomFile, text, 'utf8');
      const build = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '质量中心：升级依赖后校验编译…',
          cancellable: false
        },
        () => run('mvn', ['-B', '-q', ...mavenMirrorArgs(), '-DskipTests', 'compile'], root, 20 * 60_000)
      );
      if (build.code !== 0) {
        fs.writeFileSync(pomFile, original, 'utf8');
        const tail = (build.stderr || build.stdout)
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-6)
          .join('\n');
        this.log(`依赖升级后编译失败，已还原 pom：\n${tail}`);
        const pick = await vscode.window.showErrorMessage(
          `依赖升级后编译失败，已还原 pom.xml：\n${tail}`,
          '查看日志'
        );
        if (pick === '查看日志') {
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
      void vscode.window.showInformationMessage(
        `已升级 ${chosen.length} 个依赖并通过编译校验，已重新扫描。`
      );
      const spring = chosen.find(
        (item) =>
          item.groupId === 'org.springframework.boot' && (item.mode === 'parent' || item.mode === 'bom')
      );
      if (spring) {
        const bootVersion = decision.versions[spring.packageName] || spring.to;
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
   * 依赖树 + BOM 索引，用于判断版本来源与联动关系。
   * 按 pom 内容哈希缓存，避免每次打开预览都重新跑 Maven。
   */
  private depContextCache?: { key: string; context: UpgradeContext };

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

    const context: UpgradeContext = {};
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
    const snapshot: Snapshot = {
      type: 'state',
      scanning: override ? override.scanning : this.runner.isRunning,
      paused: this.runner.isPaused,
      deepFix: this.deepFixState,
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
        reason: item.reason
      })),
      agentFile: this.agentFile,
      buildHint: result?.buildHint,
      upgradeEnabled: config.get<boolean>('dependencyUpgrade.enabled', true),
      scanOptions: {
        checkstyle: config.get<boolean>('checkstyle.enabled', true),
        gitleaks: config.get<boolean>('gitleaks.enabled', true),
        trivy: config.get<boolean>('trivy.enabled', true),
        spotbugs: config.get<boolean>('spotbugs.enabled', true),
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
