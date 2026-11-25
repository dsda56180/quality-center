/**
 * 构建失败翻译：把 Maven 的原始报错收敛成「原因 / 影响 / 建议」三段。
 *
 * 动机：AI 和人读一屏 Maven 日志都会抓错重点——真正有用的是
 * 「哪个属性覆盖了 BOM」「哪个坐标在仓库不存在」「哪一行编译不过」，
 * 以及「这组改动该不该回滚」。这里只做确定性归类，不做猜测性修复。
 */
import * as fs from 'fs';
import * as path from 'path';
import { BuildError, parseBuildErrors } from './agentOps';

export type ExplainKind =
  | 'none'
  | 'pom-missing'
  | 'property-collision'
  | 'missing-artifact'
  | 'dependency-resolution'
  | 'compile-error'
  | 'convergence'
  | 'unknown';

export interface BuildExplanation {
  kind: ExplainKind;
  /** 是否能判定为构建成功（没有失败现场时为 true） */
  ok: boolean;
  cause: string;
  impact: string;
  suggestion: string;
  /** 命中的原始日志行，最多 3 条，便于核对 */
  evidence: string[];
  errors?: BuildError[];
  logFile?: string;
  checkedAt: string;
}

/** 每次构建都落盘的结果台账：next / 面板 / AI 都读它，不再靠猜日志时间 */
export interface BuildState {
  ok: boolean;
  code: number;
  at: string;
  seconds: number;
  pomHash?: string;
  gate?: string;
  args?: string[];
  logFile?: string;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function readBuildState(root: string): BuildState | null {
  const state = readJson<BuildState>(path.join(root, '.quality-center', 'build-result.json'));
  return state && typeof state.at === 'string' ? state : null;
}

export function readBuildLog(root: string): { file: string; text: string; at: string } | null {
  const file = path.join(root, '.quality-center', 'build.log');
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return { file, text: fs.readFileSync(file, 'utf8'), at: fs.statSync(file).mtime.toISOString() };
  } catch {
    return null;
  }
}

interface PomProperty {
  name: string;
  value: string;
}

function pomProperties(pom: string): PomProperty[] {
  const block = /<properties>([\s\S]*?)<\/properties>/.exec(pom);
  if (!block) {
    return [];
  }
  const result: PomProperty[] = [];
  const pattern = /<([A-Za-z0-9_.-]+)>\s*([^<]+?)\s*<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(block[1])) !== null) {
    result.push({ name: match[1].trim(), value: match[2].trim() });
  }
  return result;
}

/** 项目属性与 Spring Boot BOM 管理的属性同名时，会覆盖 BOM 的版本，最容易在框架组落盘后炸 */
const MANAGED_PROPERTY_HINTS: Record<string, string> = {
  'okhttp.version': 'OkHttp',
  'kotlin.version': 'Kotlin',
  'jackson-bom.version': 'Jackson',
  'tomcat.version': 'Tomcat',
  'jetty.version': 'Jetty',
  'netty.version': 'Netty',
  'reactor-netty.version': 'Reactor Netty',
  'spring-framework.version': 'Spring Framework',
  'spring-security.version': 'Spring Security',
  'spring-data-bom.version': 'Spring Data',
  'log4j2.version': 'Log4j2',
  'slf4j.version': 'SLF4J',
  'junit-jupiter.version': 'JUnit Jupiter',
  'mockito.version': 'Mockito',
  'assertj.version': 'AssertJ',
  'caffeine.version': 'Caffeine',
  'commons-pool2.version': 'Commons Pool2',
  'httpclient.version': 'HttpClient',
  'httpcore.version': 'HttpCore',
  'groovy.version': 'Groovy',
  'hibernate.version': 'Hibernate',
  'h2.version': 'H2',
  'mysql.version': 'MySQL Driver',
  'postgresql.version': 'PostgreSQL Driver',
  'mongodb.version': 'MongoDB Driver',
  'kafka.version': 'Kafka',
  'lettuce.version': 'Lettuce',
  'micrometer.version': 'Micrometer',
  'flyway.version': 'Flyway',
  'liquibase.version': 'Liquibase',
  'thymeleaf.version': 'Thymeleaf',
  'undertow.version': 'Undertow',
  'aspectj.version': 'AspectJ',
  'elasticsearch.version': 'Elasticsearch',
  'solr.version': 'Solr'
};

export interface ManagedPropertyOverride {
  property: string;
  value: string;
  managed: string;
}

/** 升级前预检：列出会被项目属性覆盖的框架 BOM 属性（只告警，不阻断） */
export function detectManagedPropertyOverrides(pom: string): ManagedPropertyOverride[] {
  return pomProperties(pom)
    .filter((item) => MANAGED_PROPERTY_HINTS[item.name.toLowerCase()])
    .map((item) => ({
      property: item.name,
      value: item.value,
      managed: MANAGED_PROPERTY_HINTS[item.name.toLowerCase()]
    }));
}

function evidence(text: string, patterns: RegExp[], limit = 3): string[] {
  const lines = text.split(/\r?\n/).filter((line) => patterns.some((pattern) => pattern.test(line)));
  return lines
    .map((line) => line.trim().slice(0, 260))
    .slice(-limit);
}

function artifactBase(artifact: string): string {
  return artifact.replace(/-bom$/i, '').replace(/-dependencies$/i, '').replace(/\(.*\)$/, '');
}

/** 找出与报错坐标同名、且值等于目标版本的属性 */
function findCollisionProperty(pom: string, artifact: string, version: string): PomProperty | undefined {
  const base = artifactBase(artifact).toLowerCase();
  const candidates = pomProperties(pom);
  const exact = candidates.find(
    (item) => item.value === version && item.name.toLowerCase().includes(base)
  );
  if (exact) {
    return exact;
  }
  return candidates.find((item) => item.value === version);
}

const NO_LOG: BuildExplanation = {
  kind: 'none',
  ok: true,
  cause: '没有找到构建失败日志（.quality-center/build.log）',
  impact: '没有失败现场需要处理',
  suggestion: '如果刚构建成功，直接执行 qc next 给出的下一步',
  evidence: [],
  checkedAt: new Date().toISOString()
};

function noLog(): BuildExplanation {
  return { ...NO_LOG, checkedAt: new Date().toISOString() };
}

export function explainBuildFailure(root: string, text?: string, logFile?: string): BuildExplanation {
  const pomFile = path.join(root, 'pom.xml');
  if (!fs.existsSync(pomFile)) {
    return {
      kind: 'pom-missing',
      ok: false,
      cause: `项目根目录没有 pom.xml：${root}`,
      impact: '无法生成计划、无法构建，所有升级动作都没有落点',
      suggestion: '确认目录是否选错；非 Maven 项目当前不适用标准升级流程',
      evidence: [],
      checkedAt: new Date().toISOString()
    };
  }

  let full = text ?? '';
  let sourceFile = logFile;
  if (!full.trim() && logFile && fs.existsSync(logFile)) {
    try {
      full = fs.readFileSync(logFile, 'utf8');
    } catch {
      // 读不到就退回默认日志
    }
  }
  if (!full.trim()) {
    const log = readBuildLog(root);
    if (!log) {
      return noLog();
    }
    full = log.text;
    sourceFile = log.file;
  }
  if (!full.trim()) {
    return noLog();
  }

  const pom = fs.readFileSync(pomFile, 'utf8');
  const errors = parseBuildErrors(full);
  const checkedAt = new Date().toISOString();

  if (errors.length > 0 && !/Non-resolvable import POM/.test(full)) {
    const first = errors[0];
    return {
      kind: 'compile-error',
      ok: false,
      cause: `编译错误 ${errors.length} 处，首条：${first.file}:${first.line} ${first.message}`,
      impact: 'target 产物没有更新，后续字节码扫描与部署都不可信',
      suggestion: '按 errors 的 file:line 定向修；若是升级引入的 API 变更，查该依赖的迁移说明，不要靠回退整个计划碰运气',
      evidence: evidence(full, [/\[ERROR\]\s+[^\s\[]+\.java:\[/], 3),
      errors,
      logFile: sourceFile,
      checkedAt
    };
  }

  const importPom = /Non-resolvable import POM: (?:Could not find artifact|Failure to find) ([^\s:]+):([^\s:]+):pom:([^\s]+)/.exec(full);
  if (importPom) {
    const groupId = importPom[1];
    const artifactId = importPom[2];
    const version = importPom[3];
    const collision = findCollisionProperty(pom, artifactId, version);
    if (collision) {
      return {
        kind: 'property-collision',
        ok: false,
        cause: `项目属性 ${collision.name}=${collision.value} 覆盖了框架 BOM 管理的版本，解析 ${groupId}:${artifactId}:${version} 时找不到该 POM`,
        impact: '框架组单独落盘后依赖树无法解析；继续构建或开下一组都会失败',
        suggestion: `把 ${artifactBase(artifactId)} 相关依赖归入 family 组同组升级，或从 pom 删除 ${collision.name} 交给 BOM 管理；改完重新 upgrade plan`,
        evidence: evidence(full, [/Non-resolvable import POM/, /org\.springframework\.boot:spring-boot-dependencies/], 3),
        logFile: sourceFile,
        checkedAt
      };
    }
    return {
      kind: 'missing-artifact',
      ok: false,
      cause: `仓库里找不到 ${groupId}:${artifactId}:${version} 这个 POM`,
      impact: '依赖树无法解析，构建必然失败',
      suggestion: '核对版本是否真实存在、公司镜像是否缺件；若是项目属性覆盖导致，删除该属性后重新 plan',
      evidence: evidence(full, [/Non-resolvable import POM/], 3),
      logFile: sourceFile,
      checkedAt
    };
  }

  if (/Could not resolve dependencies|The following artifacts could not be resolved/i.test(full)) {
    return {
      kind: 'dependency-resolution',
      ok: false,
      cause: '依赖解析失败：有坐标在当前仓库或镜像里拉不到',
      impact: '构建在依赖解析阶段就中断，代码编译根本没开始',
      suggestion: '先核对缺失坐标与版本是否存在；若是内网镜像，先确认 mirror 覆盖该 groupId；不要直接改业务代码',
      evidence: evidence(full, [/Could not resolve dependencies/, /could not be resolved/, /Could not find artifact/], 3),
      logFile: sourceFile,
      checkedAt
    };
  }

  if (/omitted for conflict|Dependency convergence error/i.test(full)) {
    return {
      kind: 'convergence',
      ok: false,
      cause: '依赖版本冲突：同一坐标被多条路径引入到不同版本',
      impact: '实际生效版本不可预期，运行期可能出现 NoSuchMethodError',
      suggestion: '在 dependencyManagement 显式钉住该版本，或把相关依赖并入 family 组统一对齐；不要只改一处版本号',
      evidence: evidence(full, [/omitted for conflict/, /Dependency convergence error/], 3),
      logFile: sourceFile,
      checkedAt
    };
  }

  if (/BUILD SUCCESS/.test(full)) {
    return {
      kind: 'none',
      ok: true,
      cause: '构建成功（BUILD SUCCESS）',
      impact: '没有失败需要处理',
      suggestion: '执行 qc next 看下一步：复扫验收或进入下一组',
      evidence: [],
      logFile: sourceFile,
      checkedAt
    };
  }

  const firstError = full
    .split(/\r?\n/)
    .find((line) => /\[ERROR\]/.test(line) && line.trim().length > 12);
  return {
    kind: 'unknown',
    ok: false,
    cause: firstError ? `未归类的构建失败：${firstError.trim().slice(0, 220)}` : '构建失败，但日志里没有可识别的错误模式',
    impact: '本次落盘没有通过门禁，不能当成已完成',
    suggestion: `先查看完整日志${sourceFile ? `（${path.relative(root, sourceFile)}）` : ''}；仍无法判断时，把日志尾部交给 AI，别继续叠加改动`,
    evidence: evidence(full, [/\[ERROR\]/], 3),
    logFile: sourceFile,
    checkedAt
  };
}
