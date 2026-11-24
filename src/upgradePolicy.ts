/**
 * 升级策略：把「不可从项目本身推导」的硬约束外置成文件，其余一律从 pom 推导。
 *
 * 设计要点：
 * - 规则只有一份，插件面板 / CLI / MCP / 编辑器适配器都读同一个 .quality-center/upgrade-policy.json；
 * - 策略缺省时按项目事实推导（Java 版本、框架版本、构建参数），并在结果里标明来源，便于审计；
 * - 框架上限用「Java 版本 → 目标版本」映射表表达，不再把某个版本号写死在代码里。
 */
import * as fs from 'fs';
import * as path from 'path';

export type BuildGate = 'compile' | 'package' | 'test';

export interface UpgradePolicy {
  /** 允许的目标版本映射：{"8": "2.7.18"} */
  frameworkTargets: Record<string, string>;
  /** 允许跨到 Spring Boot 3.x（默认不允许） */
  allowNextFrameworkLine: boolean;
  /** 禁止保留的依赖坐标（group:artifact） */
  forbiddenPackages: string[];
  /** 构建门禁级别 */
  buildGate: BuildGate;
  /** 构建时附加的 Maven 参数，例如 ["-Pdev", "-o"] */
  mavenArgs: string[];
  /** 单测是否在跨大版本升级时强制开启 */
  runTestsOnNextLine: boolean;
}

export interface LoadedPolicy {
  policy: UpgradePolicy;
  /** 策略文件绝对路径；缺省时为空，表示全部来自推导 */
  file?: string;
  /** 推导出的 Java 版本 */
  javaVersion?: string;
  /** 实际使用的框架目标版本 */
  frameworkTarget?: string;
  /** 说明每一项的来源，直接写进报告 */
  sources: string[];
}

const POLICY_REL = path.join('.quality-center', 'upgrade-policy.json');

/** Java 8 / 11 的 Spring Boot 上限是社区事实，不是本项目特例：放表里而不是常量里 */
export const FRAMEWORK_TARGET_TABLE: Record<string, string> = {
  '8': '2.7.18',
  '11': '2.7.18'
};

export const DEFAULT_POLICY: UpgradePolicy = {
  frameworkTargets: { ...FRAMEWORK_TARGET_TABLE },
  allowNextFrameworkLine: false,
  forbiddenPackages: [],
  buildGate: 'package',
  mavenArgs: [],
  runTestsOnNextLine: true
};

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

/** 读 pom 中的 Java 版本：java.version 优先，其次 maven.compiler.source / release */
export function inferJavaVersion(pom: string): string | undefined {
  const patterns = [
    /<java\.version>\s*([^<]+?)\s*<\/java\.version>/,
    /<maven\.compiler\.source>\s*([^<]+?)\s*<\/maven\.compiler\.source>/,
    /<maven\.compiler\.release>\s*([^<]+?)\s*<\/maven\.compiler\.release>/
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(pom);
    if (match) {
      const raw = match[1].trim();
      // 1.8 / 8 都归一成 8
      const normalized = raw.replace(/^1\./, '');
      return normalized;
    }
  }
  return undefined;
}

/** 读 pom 中的 Spring Boot 版本（parent 或 import 的 BOM） */
export function inferFrameworkVersion(pom: string): string | undefined {
  const parent = /<parent>[\s\S]*?<\/parent>/.exec(pom);
  if (parent && /<artifactId>\s*spring-boot-starter-parent\s*</.test(parent[0])) {
    const version = /<version>\s*([^<]+?)\s*<\/version>/.exec(parent[0]);
    if (version) {
      return version[1].trim();
    }
  }
  const bom = /<artifactId>\s*spring-boot-dependencies\s*</.exec(pom);
  if (bom) {
    const rest = pom.slice(bom.index);
    const version = /<version>\s*([^<]+?)\s*<\/version>/.exec(rest.slice(0, 400));
    if (version) {
      return version[1].trim();
    }
  }
  return undefined;
}

/** 加载策略：文件存在则合并默认值，不存在则全部按默认 + 推导，并记录来源 */
export function loadPolicy(root: string, pom?: string): LoadedPolicy {
  const sources: string[] = [];
  const policy: UpgradePolicy = { ...DEFAULT_POLICY, frameworkTargets: { ...DEFAULT_POLICY.frameworkTargets } };

  const file = path.join(root, POLICY_REL);
  const raw = fs.existsSync(file) ? readJson(file) : undefined;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (obj.frameworkTargets && typeof obj.frameworkTargets === 'object') {
      const targets: Record<string, string> = { ...policy.frameworkTargets };
      for (const [key, value] of Object.entries(obj.frameworkTargets as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim()) {
          targets[key] = value.trim();
        }
      }
      policy.frameworkTargets = targets;
    }
    if (typeof obj.allowNextFrameworkLine === 'boolean') {
      policy.allowNextFrameworkLine = obj.allowNextFrameworkLine;
    }
    if (typeof obj.buildGate === 'string' && ['compile', 'package', 'test'].includes(obj.buildGate)) {
      policy.buildGate = obj.buildGate as BuildGate;
    }
    if (typeof obj.runTestsOnNextLine === 'boolean') {
      policy.runTestsOnNextLine = obj.runTestsOnNextLine;
    }
    const forbidden = asStringArray(obj.forbiddenPackages);
    if (forbidden.length > 0) {
      policy.forbiddenPackages = forbidden;
    }
    const mavenArgs = asStringArray(obj.mavenArgs);
    if (mavenArgs.length > 0) {
      policy.mavenArgs = mavenArgs;
    }
    sources.push(`${POLICY_REL}（项目声明）`);
  } else {
    sources.push('策略文件缺省：Java 版本与框架上限从 pom 推导');
  }

  const pomText = pom ?? readPom(root);
  const javaVersion = pomText ? inferJavaVersion(pomText) : undefined;
  if (javaVersion) {
    sources.push(`Java ${javaVersion}（pom 推导）`);
  }

  const frameworkTarget = javaVersion ? policy.frameworkTargets[javaVersion] : undefined;
  if (frameworkTarget) {
    sources.push(`框架上限 ${frameworkTarget}（Java ${javaVersion} 映射表）`);
  }

  return { policy, file: fs.existsSync(file) ? file : undefined, javaVersion, frameworkTarget, sources };
}

function readPom(root: string): string | undefined {
  try {
    return fs.readFileSync(path.join(root, 'pom.xml'), 'utf8');
  } catch {
    return undefined;
  }
}

/** 生成默认策略文件内容（integrate 首次写入时用） */
export function defaultPolicyDocument(root: string): UpgradePolicy & { schemaVersion: string } {
  const loaded = loadPolicy(root);
  return {
    schemaVersion: '1',
    frameworkTargets: loaded.policy.frameworkTargets,
    allowNextFrameworkLine: loaded.policy.allowNextFrameworkLine,
    forbiddenPackages: loaded.policy.forbiddenPackages,
    buildGate: loaded.policy.buildGate,
    mavenArgs: loaded.policy.mavenArgs,
    runTestsOnNextLine: loaded.policy.runTestsOnNextLine
  };
}

/** 构建命令：按门禁级别与 mavenArgs 生成，供 CLI / MCP / 适配器共用 */
export function buildCommandArgs(policy: UpgradePolicy, options?: { skipTests?: boolean }): string[] {
  const skipTests = options?.skipTests ?? policy.buildGate !== 'test';
  const args = ['-B', '-q', ...policy.mavenArgs];
  if (skipTests) {
    args.push('-Dmaven.test.skip=true');
  }
  args.push(policy.buildGate === 'compile' ? 'compile' : policy.buildGate === 'test' ? 'test' : 'package');
  return args;
}
