import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { addToBaseline, removeFromBaseline, splitByBaseline } from './baseline';
import { Issue, ScanResult, SEVERITY_ORDER } from './model';
import { resolveConfig, scanCheckstyle } from './scanners/checkstyle';
import { scanGitleaks } from './scanners/gitleaks';
import { scanTrivy } from './scanners/trivy';
import { buildSuggestions } from './suggest';

export class ScanRunner {
  private running = false;
  private lastResult?: ScanResult;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get result(): ScanResult | undefined {
    return this.lastResult;
  }

  get isRunning(): boolean {
    return this.running;
  }

  root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private outputDir(root: string): string {
    const base = this.context.storageUri?.fsPath ?? path.join(os.tmpdir(), 'quality-center');
    return path.join(base, 'reports', path.basename(root));
  }

  async scan(): Promise<ScanResult | undefined> {
    const root = this.root();
    if (!root) {
      return undefined;
    }
    if (this.running) {
      return this.lastResult;
    }

    this.running = true;
    const startedAt = Date.now();
    const issues: Issue[] = [];
    const errors: ScanResult['errors'] = [];
    const skipped: ScanResult['skipped'] = [];
    const config = vscode.workspace.getConfiguration('qualityCenter');
    const outDir = this.outputDir(root);
    let buildHint: string | undefined;

    try {
      const jobs: Promise<void>[] = [];

      if (config.get<boolean>('checkstyle.enabled', true)) {
        const configured = config.get<string>('checkstyle.config', '');
        const bundled = path.join(this.context.extensionPath, 'media', 'checkstyle-default.xml');
        const configPath = resolveConfig(root, configured, bundled);
        if (!configPath) {
          skipped.push({ source: 'checkstyle', reason: '未找到 Checkstyle 规则文件' });
        } else {
          jobs.push(
            scanCheckstyle(root, configPath, path.join(outDir, 'checkstyle.xml')).then((res) => {
              issues.push(...res.issues);
              if (res.error) {
                errors.push({ source: 'checkstyle', message: res.error });
              }
            })
          );
        }
      } else {
        skipped.push({ source: 'checkstyle', reason: '已在设置中关闭' });
      }

      if (config.get<boolean>('gitleaks.enabled', true)) {
        const localConfig = path.join(root, '.gitleaks.toml');
        const gitleaksConfig = fs.existsSync(localConfig)
          ? localConfig
          : path.join(this.context.extensionPath, 'media', 'gitleaks.toml');
        jobs.push(
          scanGitleaks(
            root,
            config.get<string>('gitleaks.path', ''),
            path.join(outDir, 'gitleaks.json'),
            gitleaksConfig
          ).then((res) => {
              if (res.missing) {
                skipped.push({ source: 'gitleaks', reason: '未找到 gitleaks 可执行文件' });
                return;
              }
              issues.push(...res.issues);
              if (res.error) {
                errors.push({ source: 'gitleaks', message: res.error });
              }
            }
          )
        );
      } else {
        skipped.push({ source: 'gitleaks', reason: '已在设置中关闭' });
      }

      if (config.get<boolean>('trivy.enabled', true)) {
        jobs.push(
          scanTrivy(root, {
            executable: config.get<string>('trivy.path', ''),
            scanTarget: config.get<string>('trivy.scanTarget', ''),
            dbRepository: config.get<string>('trivy.dbRepository', ''),
            javaDbRepository: config.get<string>('trivy.javaDbRepository', ''),
            minSeverity: config.get<string>('trivy.minSeverity', 'low') as never,
            onlyFixed: config.get<boolean>('trivy.onlyFixed', true)
          }).then((res) => {
            if (res.missing) {
              skipped.push({ source: 'trivy', reason: '未找到 trivy 可执行文件' });
              return;
            }
            issues.push(...res.issues);
            if (res.error) {
              errors.push({ source: 'trivy', message: res.error });
            } else if (res.usedBuildArtifacts === false) {
              buildHint =
                '未找到可用的构建产物（target 下没有 jar/pom），当前基于源码离线解析，依赖版本可能不完整。' +
                '点击「构建并扫描」执行 mvn package 后可获得准确的依赖漏洞清单。';
            }
          })
        );
      } else {
        skipped.push({ source: 'trivy', reason: '已在设置中关闭' });
      }

      await Promise.all(jobs);
    } finally {
      this.running = false;
    }

    issues.sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    );

    const split = splitByBaseline(root, issues);
    this.lastResult = {
      startedAt,
      finishedAt: Date.now(),
      issues: split.active,
      ignored: split.ignored,
      errors,
      skipped,
      suggestions: [],
      buildHint
    };
    this.lastResult.suggestions = buildSuggestions(root, this.lastResult);
    return this.lastResult;
  }

  /** 忽略某条问题并写入本地基线 */
  ignoreIssue(id: number): boolean {
    const root = this.root();
    const result = this.lastResult;
    if (!root || !result) {
      return false;
    }
    const issue = result.issues[id - 1];
    if (!issue) {
      return false;
    }
    addToBaseline(root, issue);
    result.issues.splice(id - 1, 1);
    result.ignored.push(issue);
    result.suggestions = buildSuggestions(root, result);
    return true;
  }

  /** 从基线恢复某条已忽略问题 */
  unignoreIssue(id: number): boolean {
    const root = this.root();
    const result = this.lastResult;
    if (!root || !result) {
      return false;
    }
    const issue = result.ignored[id - 1];
    if (!issue) {
      return false;
    }
    removeFromBaseline(root, issue);
    result.ignored.splice(id - 1, 1);
    result.issues.push(issue);
    result.issues.sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    );
    result.suggestions = buildSuggestions(root, result);
    return true;
  }
}
