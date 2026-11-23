import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { addToBaseline, removeFromBaseline, splitByBaseline } from './baseline';
import { killRunningCommands, resolveBinary } from './exec';
import { Issue, IssueSource, ScanResult, SEVERITY_ORDER } from './model';
import type { ToolId } from './tools';
import { CheckstyleResult, resolveConfig, scanCheckstyle } from './scanners/checkstyle';
import { scanGitleaks } from './scanners/gitleaks';
import { scanSpotbugs, SpotbugsResult } from './scanners/spotbugs';
import { scanTrivy, TrivyResult } from './scanners/trivy';
import { buildSuggestions } from './suggest';

interface FileStat {
  rel: string;
  size: number;
  mtime: number;
}

/** 采集目录下符合条件的文件状态，用于判断扫描结果是否还能复用 */
function collectStats(
  dir: string,
  accept: (name: string) => boolean,
  depth = 0,
  out: FileStat[] = []
): FileStat[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 20) {
        collectStats(full, accept, depth + 1, out);
      }
    } else if (entry.isFile() && accept(entry.name)) {
      try {
        const stat = fs.statSync(full);
        out.push({ rel: full, size: stat.size, mtime: Math.floor(stat.mtimeMs) });
      } catch {
        // 文件在遍历过程中被删除，忽略
      }
    }
  }
  return out;
}

function statFile(file: string): FileStat[] {
  try {
    const stat = fs.statSync(file);
    return [{ rel: file, size: stat.size, mtime: Math.floor(stat.mtimeMs) }];
  } catch {
    return [];
  }
}

/** 把文件状态与配置拼成指纹，指纹一致即认为结果仍有效 */
function fingerprint(stats: FileStat[], extras: (string | number | boolean | undefined)[]): string {
  const hash = createHash('sha1');
  stats
    .sort((a, b) => a.rel.localeCompare(b.rel))
    .forEach((item) => hash.update(`${item.rel}|${item.size}|${item.mtime}\n`));
  extras.forEach((item) => hash.update(`${String(item ?? '')}\n`));
  return hash.digest('hex');
}

/** 扫描进度：已完成的扫描器数量 + 仍在运行的扫描器 */
export interface ScanProgress {
  done: number;
  total: number;
  active: string[];
}

export class ScanRunner {
  private running = false;
  private lastResult?: ScanResult;
  /** 扫描队列暂停：当前扫描器结束后不再启动新的扫描器 */
  private paused = false;
  private cancelled = false;
  private resumeWaiters: Array<() => void> = [];
  /** 扫描器结果缓存：文件指纹一致时跳过 Maven/Trivy 调用 */
  private caches = new Map<string, { sig: string; value: unknown }>();
  private cacheLoaded = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get result(): ScanResult | undefined {
    if (!this.lastResult) {
      this.loadPersisted();
    }
    return this.lastResult;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const waiters = this.resumeWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }

  /** 终止当前扫描：唤醒等待中的队列并杀掉正在运行的命令进程树 */
  cancel(): void {
    this.cancelled = true;
    const waiters = this.resumeWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
    killRunningCommands();
  }

  private waitForResume(): Promise<void> {
    return new Promise((resolve) => this.resumeWaiters.push(resolve));
  }

  root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private cacheFile(): string | undefined {
    const base = this.context.storageUri?.fsPath ?? this.context.globalStorageUri?.fsPath;
    return base ? path.join(base, 'scan-cache.json') : undefined;
  }

  /** 载入上一次扫描结果与扫描器缓存，打开面板即可先看到旧结果 */
  private loadPersisted(): void {
    if (this.cacheLoaded) {
      return;
    }
    this.cacheLoaded = true;
    const file = this.cacheFile();
    const root = this.root();
    if (!file || !root || !fs.existsSync(file)) {
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        root?: string;
        result?: ScanResult;
        scanners?: Record<string, { sig: string; value: unknown }>;
      };
      if (data.root !== root) {
        return;
      }
      this.lastResult = data.result;
      Object.entries(data.scanners ?? {}).forEach(([key, value]) => {
        if (value && typeof value.sig === 'string') {
          this.caches.set(key, value);
        }
      });
    } catch {
      // 缓存损坏时忽略，按无缓存处理
    }
  }

  private persist(): void {
    const file = this.cacheFile();
    const root = this.root();
    if (!file || !root || !this.lastResult) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const scanners: Record<string, { sig: string; value: unknown }> = {};
      this.caches.forEach((value, key) => {
        scanners[key] = value;
      });
      fs.writeFileSync(file, JSON.stringify({ root, result: this.lastResult, scanners }), 'utf8');
    } catch {
      // 缓存写入失败不影响扫描
    }
  }

  private cached<T>(key: string, sig: string): T | undefined {
    const entry = this.caches.get(key);
    return entry && entry.sig === sig ? (entry.value as T) : undefined;
  }

  private remember(key: string, sig: string, value: unknown): void {
    this.caches.set(key, { sig, value });
  }

  /**
   * 外部工具状态发生变化（例如刚用 winget 装了 trivy）后清空扫描器缓存，
   * 否则旧的「missing」结果会一直命中，装完仍然显示已跳过。
   */
  resetCache(): void {
    this.caches.clear();
    this.persist();
  }

  private outputDir(root: string): string {
    const base = this.context.storageUri?.fsPath ?? path.join(os.tmpdir(), 'quality-center');
    return path.join(base, 'reports', path.basename(root));
  }

  async scan(onProgress?: (progress: ScanProgress) => void): Promise<ScanResult | undefined> {
    const root = this.root();
    if (!root) {
      return undefined;
    }
    if (this.running) {
      return this.lastResult;
    }

    this.running = true;
    this.cancelled = false;
    const startedAt = Date.now();
    const issues: Issue[] = [];
    const errors: ScanResult['errors'] = [];
    const skipped: ScanResult['skipped'] = [];
    const config = vscode.workspace.getConfiguration('qualityCenter');
    const outDir = this.outputDir(root);
    let buildHint: string | undefined;
    /** 本轮缺失的外部工具，扫描结束后由 UI 弹「一键安装」提示 */
    const missing = new Set<ToolId>();
    /** 因缺少外部工具而跳过：skipped 带上 tool，面板才能给出「安装」入口 */
    const skipForMissing = (source: IssueSource, tool: ToolId, reason: string): void => {
      missing.add(tool);
      skipped.push({ source, reason, tool });
    };
    // IDE 可能在工具安装前就已启动，PATH 会过期，统一交给 resolveBinary 兜底
    const mvn = resolveBinary('mvn');

    try {
      const jobs: { label: string; run: () => Promise<void> }[] = [];

      if (!config.get<boolean>('checkstyle.enabled', true)) {
        skipped.push({ source: 'checkstyle', reason: '已在设置中关闭' });
      } else if (!mvn) {
        skipForMissing('checkstyle', 'mvn', '未找到 mvn 可执行文件，Checkstyle 需要 Maven 才能运行');
      } else {
        const configured = config.get<string>('checkstyle.config', '');
        const bundled = path.join(this.context.extensionPath, 'media', 'checkstyle-default.xml');
        const configPath = resolveConfig(root, configured, bundled);
        if (!configPath) {
          skipped.push({ source: 'checkstyle', reason: '未找到 Checkstyle 规则文件' });
        } else {
          const sig = fingerprint(
            [
              ...collectStats(path.join(root, 'src'), (name) => name.endsWith('.java')),
              ...statFile(configPath),
              ...statFile(path.join(root, 'pom.xml'))
            ],
            ['checkstyle-v1', configPath]
          );
          const hit = this.cached<CheckstyleResult>('checkstyle', sig);
          if (hit) {
            issues.push(...hit.issues);
            if (hit.error) {
              errors.push({ source: 'checkstyle', message: hit.error });
            }
          } else {
            jobs.push({
              label: 'Checkstyle',
              run: () => scanCheckstyle(root, configPath, path.join(outDir, 'checkstyle.xml'), mvn).then((res) => {
                issues.push(...res.issues);
                if (res.error) {
                  errors.push({ source: 'checkstyle', message: res.error });
                } else {
                  this.remember('checkstyle', sig, res);
                }
              })
            });
          }
        }
      }

      if (config.get<boolean>('gitleaks.enabled', true)) {
        const localConfig = path.join(root, '.gitleaks.toml');
        const gitleaksConfig = fs.existsSync(localConfig)
          ? localConfig
          : path.join(this.context.extensionPath, 'media', 'gitleaks.toml');
        jobs.push({
          label: 'Gitleaks',
          run: () => scanGitleaks(
            root,
            config.get<string>('gitleaks.path', ''),
            path.join(outDir, 'gitleaks.json'),
            gitleaksConfig
          ).then((res) => {
            if (res.missing) {
              skipForMissing('gitleaks', 'gitleaks', '未找到 gitleaks 可执行文件');
              return;
            }
            issues.push(...res.issues);
            if (res.error) {
              errors.push({ source: 'gitleaks', message: res.error });
            }
          })
        });
      } else {
        skipped.push({ source: 'gitleaks', reason: '已在设置中关闭' });
      }

      if (config.get<boolean>('trivy.enabled', true)) {
        const trivyOptions = {
          executable: config.get<string>('trivy.path', ''),
          scanTarget: config.get<string>('trivy.scanTarget', ''),
          dbRepository: config.get<string>('trivy.dbRepository', ''),
          javaDbRepository: config.get<string>('trivy.javaDbRepository', ''),
          preferMirror: config.get<boolean>('trivy.preferMirror', true),
          minSeverity: config.get<string>('trivy.minSeverity', 'low') as never,
          onlyFixed: config.get<boolean>('trivy.onlyFixed', true)
        };
        // 依赖漏洞只受 pom 与构建产物影响，改代码不需要重跑 trivy
        const sig = fingerprint(
          [
            ...statFile(path.join(root, 'pom.xml')),
            ...collectStats(path.join(root, 'target'), (name) => /\.(jar|pom)$/i.test(name))
          ],
          ['trivy-v1', JSON.stringify(trivyOptions), new Date().toISOString().slice(0, 10)]
        );
        const hit = this.cached<TrivyResult>('trivy', sig);
        if (hit) {
          if (hit.missing) {
            skipForMissing('trivy', 'trivy', '未找到 trivy 可执行文件');
          } else {
            issues.push(...hit.issues);
            if (hit.error) {
              errors.push({ source: 'trivy', message: hit.error });
            } else if (hit.usedBuildArtifacts === false) {
              buildHint =
                '未找到可用的构建产物（target 下没有 jar/pom），当前基于源码离线解析，依赖版本可能不完整。' +
                '点击「构建并扫描」执行 mvn package 后可获得准确的依赖漏洞清单。';
            }
          }
        } else {
          jobs.push({
            label: 'Trivy',
            run: () => scanTrivy(root, trivyOptions).then((res) => {
              if (res.missing) {
                skipForMissing('trivy', 'trivy', '未找到 trivy 可执行文件');
                return;
              }
              issues.push(...res.issues);
              if (res.error) {
                errors.push({ source: 'trivy', message: res.error });
              } else {
                if (res.usedBuildArtifacts === false) {
                  buildHint =
                    '未找到可用的构建产物（target 下没有 jar/pom），当前基于源码离线解析，依赖版本可能不完整。' +
                    '点击「构建并扫描」执行 mvn package 后可获得准确的依赖漏洞清单。';
                }
                this.remember('trivy', sig, res);
              }
            })
          });
        }
      } else {
        skipped.push({ source: 'trivy', reason: '已在设置中关闭' });
      }

      if (!config.get<boolean>('spotbugs.enabled', true)) {
        skipped.push({ source: 'spotbugs', reason: '已在设置中关闭' });
      } else if (!mvn) {
        skipForMissing('spotbugs', 'mvn', '未找到 mvn 可执行文件，SpotBugs 需要 Maven 才能运行');
      } else {
        // 字节码没变就不需要再启动一次 Maven + SpotBugs（单次约 30 秒）
        const sig = fingerprint(
          [
            ...collectStats(path.join(root, 'target', 'classes'), (name) => name.endsWith('.class')),
            ...statFile(path.join(root, 'pom.xml'))
          ],
          ['spotbugs-v1', '4.7.3.0', 'findsecbugs-1.12.0', 'Max', 'Low']
        );
        const hit = this.cached<SpotbugsResult>('spotbugs', sig);
        if (hit) {
          if (hit.needsBuild) {
            skipped.push({ source: 'spotbugs', reason: '未找到 target/classes，需要先构建项目' });
            buildHint =
              buildHint ??
              '未找到编译产物，字节码级静态缺陷扫描（SpotBugs）已跳过。点击「构建并扫描」执行 mvn package 后可获得完整结果。';
          } else {
            issues.push(...hit.issues);
            if (hit.error) {
              errors.push({ source: 'spotbugs', message: hit.error });
            }
          }
        } else {
          jobs.push({
            label: 'SpotBugs',
            run: () => scanSpotbugs(root, mvn).then((res) => {
              if (res.needsBuild) {
                skipped.push({ source: 'spotbugs', reason: '未找到 target/classes，需要先构建项目' });
                buildHint =
                  buildHint ??
                  '未找到编译产物，字节码级静态缺陷扫描（SpotBugs）已跳过。点击「构建并扫描」执行 mvn package 后可获得完整结果。';
                return;
              }
              issues.push(...res.issues);
              if (res.error) {
                errors.push({ source: 'spotbugs', message: res.error });
              } else {
                this.remember('spotbugs', sig, res);
              }
            })
          });
        }
      }

      const total = jobs.length;
      const active = new Set(jobs.map((job) => job.label));
      let done = 0;
      let next = 0;
      onProgress?.({ done, total, active: [...active] });

      // 最多同时跑两个扫描器：既保留并行速度，又让「暂停」能在扫描器边界生效
      const worker = async (): Promise<void> => {
        while (true) {
          while (this.paused && !this.cancelled) {
            await this.waitForResume();
          }
          if (this.cancelled) {
            return;
          }
          const job = jobs[next];
          if (!job) {
            return;
          }
          next += 1;
          try {
            await job.run();
          } catch {
            // 单个扫描器异常不阻断其它扫描器
          }
          active.delete(job.label);
          done += 1;
          onProgress?.({ done, total, active: [...active] });
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, () => worker()));

      if (this.cancelled) {
        // 终止扫描时，被杀进程会返回非零退出码，这里清掉由此产生的误报
        errors.length = 0;
        buildHint = undefined;
        missing.clear();
      }
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
      missingTools: missing.size > 0 ? Array.from(missing) : undefined,
      suggestions: [],
      buildHint
    };
    this.lastResult.suggestions = buildSuggestions(root, this.lastResult);
    this.persist();
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
    this.persist();
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
    this.persist();
    return true;
  }
}
