import * as fs from 'fs';
import * as path from 'path';
import { Suggestion } from './model';

/**
 * 依赖治理建议，和“版本升级”分开：
 * - 版本升级解决 CVE，能生成 pom.diff 与哈希轨迹；
 * - 依赖收敛解决同一能力被重复实现，只给建议，不自动删依赖。
 *
 * 删除一个库通常伴随代码迁移，必须让 AI/人先看引用面，再决定替换顺序。
 */

interface DirectDependency {
  groupId: string;
  artifactId: string;
  version?: string;
  scope?: string;
}

interface CapabilityAlternative {
  name: string;
  groupId: string;
  artifactId?: string;
  importPrefixes: string[];
  /** true 表示仅靠依赖存在不够，必须真有代码引用才算“在用”（WebFlux 可能只用于服务端） */
  requiresUsage?: boolean;
}

interface CapabilityFamily {
  id: string;
  label: string;
  canonical: string;
  /** 至少出现几个“替代实现”才触发；JSON/日志是 1，HTTP 需要 2 套并存 */
  triggerCount: number;
  intro: (names: string, bootVersion: string) => string;
  alternatives: CapabilityAlternative[];
}

const JSON_FAMILY: CapabilityFamily = {
  id: 'json',
  label: 'JSON 实现收敛',
  canonical: 'Spring Boot 自带 Jackson',
  triggerCount: 1,
  intro: (names, bootVersion) =>
    `Spring Boot ${bootVersion} 已自带 Jackson，项目又直接引入了 ${names}，属于同一能力重复实现。`,
  alternatives: [
    { name: 'fastjson', groupId: 'com.alibaba', artifactId: 'fastjson', importPrefixes: ['com.alibaba.fastjson'] },
    { name: 'fastjson2', groupId: 'com.alibaba.fastjson2', artifactId: 'fastjson2', importPrefixes: ['com.alibaba.fastjson2'] },
    { name: 'Gson', groupId: 'com.google.code.gson', artifactId: 'gson', importPrefixes: ['com.google.gson'] },
    { name: 'Jackson 1.x', groupId: 'org.codehaus.jackson', importPrefixes: ['org.codehaus.jackson'] },
    { name: 'json-lib', groupId: 'net.sf.json-lib', importPrefixes: ['net.sf.json'] },
    { name: 'org.json', groupId: 'org.json', artifactId: 'json', importPrefixes: ['org.json'] }
  ]
};

const LOGGING_FAMILY: CapabilityFamily = {
  id: 'logging',
  label: '日志实现收敛',
  canonical: 'Spring Boot 默认 SLF4J + Logback',
  triggerCount: 1,
  intro: (names, bootVersion) =>
    `Spring Boot ${bootVersion} 默认使用 SLF4J + Logback，项目又直接引入了 ${names}，日志门面/实现存在重叠。` +
    '两套绑定同时存在时，日志级别、异步配置和输出格式可能互相覆盖，排查线上问题会非常困难。',
  alternatives: [
    { name: 'Log4j 1.x', groupId: 'log4j', artifactId: 'log4j', importPrefixes: ['org.apache.log4j'] },
    { name: 'Log4j2', groupId: 'org.apache.logging.log4j', artifactId: 'log4j-core', importPrefixes: ['org.apache.logging.log4j'] },
    { name: 'Commons Logging', groupId: 'commons-logging', artifactId: 'commons-logging', importPrefixes: ['org.apache.commons.logging'] }
  ]
};

const HTTP_FAMILY: CapabilityFamily = {
  id: 'http',
  label: 'HTTP 客户端收敛',
  canonical: '统一一个出站客户端',
  triggerCount: 2,
  intro: (names) =>
    `项目同时直接引入了 ${names}，同一“出站 HTTP 调用”能力有两套以上实现。`,
  alternatives: [
    { name: 'OkHttp', groupId: 'com.squareup.okhttp3', artifactId: 'okhttp', importPrefixes: ['okhttp3'] },
    {
      name: 'Apache HttpClient 4',
      groupId: 'org.apache.httpcomponents',
      artifactId: 'httpclient',
      importPrefixes: ['org.apache.http']
    },
    {
      name: 'Apache HttpClient 5',
      groupId: 'org.apache.httpcomponents.client5',
      artifactId: 'httpclient5',
      importPrefixes: ['org.apache.hc.client5']
    },
    { name: 'Retrofit', groupId: 'com.squareup.retrofit2', artifactId: 'retrofit', importPrefixes: ['retrofit2'] },
    {
      name: 'WebClient',
      groupId: 'org.springframework.boot',
      artifactId: 'spring-boot-starter-webflux',
      importPrefixes: ['org.springframework.web.reactive.function.client', 'reactor.netty.http.client'],
      requiresUsage: true
    }
  ]
};

const FAMILIES = [JSON_FAMILY, LOGGING_FAMILY, HTTP_FAMILY];

const SKIP_DIRS = new Set(['target', 'build', 'out', 'node_modules', '.git', '.idea', '.quality-center']);

/** Spring Boot BOM 明确管理的常见组件；只对高置信度前缀给建议，避免误报 */
const BOM_MANAGED_PREFIXES = [
  'org.springframework:',
  'org.springframework.boot:',
  'com.fasterxml.jackson',
  'ch.qos.logback:',
  'org.slf4j:',
  'org.apache.tomcat.embed:',
  'org.yaml:snakeyaml',
  'org.hibernate.validator:',
  'com.zaxxer:HikariCP',
  'org.apache.commons:commons-lang3',
  'org.projectlombok:lombok',
  'mysql:mysql-connector-java',
  'com.squareup.okhttp3:',
  'org.apache.kafka:',
  'org.springframework.kafka:',
  'org.apache.poi:',
  'io.projectreactor:',
  'io.netty:',
  'org.jetbrains.kotlin:',
  'org.junit:',
  'junit:junit',
  'org.mockito:',
  'org.assertj:'
];

function readPom(root: string): string {
  const file = path.join(root, 'pom.xml');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** 只做一件事：判断是否 Spring Boot 项目，避免和 suggest.ts 形成循环依赖 */
function detectBootVersion(pom: string): string | undefined {
  for (const pattern of [
    /<artifactId>\s*spring-boot-starter-parent\s*<\/artifactId>\s*<version>\s*([^<]+?)\s*<\/version>/,
    /<artifactId>\s*spring-boot-dependencies\s*<\/artifactId>\s*<version>\s*([^<]+?)\s*<\/version>/
  ]) {
    const match = pattern.exec(pom);
    if (match) {
      return match[1].trim();
    }
  }
  return undefined;
}

/** 只解析 pom 里显式声明的依赖，传递依赖不参与“重复实现”判断 */
export function parseDirectDependencies(pom: string): DirectDependency[] {
  const deps: DirectDependency[] = [];
  const text = pom.replace(/<build>[\s\S]*?<\/build>/g, '');
  const blocks = text.match(/<dependency>[\s\S]*?<\/dependency>/g) || [];
  for (const block of blocks) {
    const groupId = /<groupId>\s*([^<]+?)\s*<\/groupId>/.exec(block)?.[1];
    const artifactId = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(block)?.[1];
    if (!groupId || !artifactId) {
      continue;
    }
    const version = /<version>\s*([^<]+?)\s*<\/version>/.exec(block)?.[1];
    const scope = /<scope>\s*([^<]+?)\s*<\/scope>/.exec(block)?.[1];
    deps.push({ groupId: groupId.trim(), artifactId: artifactId.trim(), version, scope });
  }
  return deps;
}

/**
 * 统计 Java 源码里各包前缀的 import 文件数。
 * 只看 import 行，不做 AST，成本低且足够回答“有没有在用”。
 */
export function countImportUsage(
  root: string,
  prefixes: string[],
  options?: { maxFiles?: number }
): { counts: Record<string, number>; scannedFiles: number } {
  const counts: Record<string, number> = {};
  for (const prefix of prefixes) {
    counts[prefix] = 0;
  }
  let scannedFiles = 0;
  const maxFiles = options?.maxFiles ?? 5000;

  const walk = (dir: string): void => {
    if (scannedFiles >= maxFiles) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scannedFiles >= maxFiles) {
        return;
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
        continue;
      }
      if (!entry.name.endsWith('.java')) {
        continue;
      }
      scannedFiles += 1;
      let text = '';
      try {
        text = fs.readFileSync(path.join(dir, entry.name), 'utf8');
      } catch {
        continue;
      }
      for (const prefix of prefixes) {
        const pattern = new RegExp(`^\\s*import\\s+(?:static\\s+)?${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
        if (pattern.test(text)) {
          counts[prefix] += 1;
        }
      }
    }
  };

  for (const dir of [path.join(root, 'src', 'main', 'java'), path.join(root, 'src', 'test', 'java')]) {
    if (fs.existsSync(dir)) {
      walk(dir);
    }
  }
  return { counts, scannedFiles };
}

function hasDependency(deps: DirectDependency[], alternative: CapabilityAlternative): boolean {
  return deps.some(
    (dep) =>
      dep.groupId === alternative.groupId &&
      (alternative.artifactId ? dep.artifactId === alternative.artifactId : true)
  );
}

function usageText(
  present: CapabilityAlternative[],
  counts: Record<string, number>
): { referenced: CapabilityAlternative[]; text: string; files: number } {
  const referenced = present.filter((item) =>
    item.importPrefixes.some((prefix) => counts[prefix] > 0)
  );
  const files = referenced.reduce(
    (sum, item) => sum + item.importPrefixes.reduce((inner, prefix) => inner + counts[prefix], 0),
    0
  );
  const text = referenced.length
    ? referenced
        .map((item) => {
          const count = item.importPrefixes.reduce((sum, prefix) => sum + counts[prefix], 0);
          return `${item.name} ${count} 个文件`;
        })
        .join('、')
    : '';
  return { referenced, text, files };
}

function buildFamilySuggestion(root: string, bootVersion: string, deps: DirectDependency[], family: CapabilityFamily): Suggestion | undefined {
  const declared = family.alternatives.filter((item) => hasDependency(deps, item));
  if (declared.length === 0) {
    return undefined;
  }
  const prefixes = declared.flatMap((item) => item.importPrefixes);
  const usage = countImportUsage(root, prefixes);
  const counts = usage.counts;
  const present = declared.filter(
    (item) =>
      !item.requiresUsage ||
      item.importPrefixes.some((prefix) => usage.counts[prefix] > 0)
  );
  if (present.length < family.triggerCount) {
    return undefined;
  }
  const referenced = usageText(present, counts);
  const unused = present.filter((item) => !referenced.referenced.includes(item));

  const names = present.map((item) => item.name).join('、');
  const refText = referenced.text ? `当前扫描到 ${referenced.text}仍在使用；` : '';
  const unusedText = unused.length ? `${unused.map((item) => item.name).join('、')} 未发现代码引用；` : '';
  const action =
    family.id === 'json'
      ? '建议统一到 Jackson：先把 ObjectMapper/序列化入口收敛，再逐个替换 import，最后移除依赖并复扫。'
      : family.id === 'logging'
        ? '建议统一到 SLF4J + Logback：先换日志门面，再把剩余实现里的配置迁移到 logback-spring.xml，最后移除旧绑定。'
        : '建议先确认项目主链路实际使用哪一套，再把其余调用收敛到同一个客户端；不要在两套之上再包一层。';
  const caution =
    family.id === 'http'
      ? '插件不会自动删依赖；连接池、超时、重试、证书配置存在差异，必须人工确认。'
      : '插件不会自动删依赖；序列化/日志行为差异需要人工确认后再移除。';

  return {
    category: 'duplicate',
    title: `${family.label}：${names} → ${family.canonical}`,
    detail:
      family.intro(names, bootVersion) +
      refText +
      unusedText +
      action +
      caution +
      (usage.scannedFiles >= 5000 ? '（源码扫描已达 5000 文件上限，引用数只多不少）' : ''),
    impact: Math.max(1, referenced.files + present.length),
    impactLabel: '处引用'
  };
}

function buildBomAlignmentSuggestion(bootVersion: string, deps: DirectDependency[]): Suggestion | undefined {
  const pinned = deps.filter(
    (dep) =>
      dep.version &&
      BOM_MANAGED_PREFIXES.some((prefix) =>
        `${dep.groupId}:${dep.artifactId}`.startsWith(prefix) || `${dep.groupId}:`.startsWith(prefix)
      )
  );
  if (pinned.length === 0) {
    return undefined;
  }
  const names = pinned.slice(0, 6).map((dep) => `${dep.artifactId} ${dep.version}`).join('、');
  return {
    category: 'duplicate',
    title: `BOM 版本统一：${pinned.length} 个依赖仍显式锁版本`,
    detail:
      `Spring Boot ${bootVersion} 的父 POM/BOM 已经管理这些依赖的版本，但 pom 仍显式写了 version：${names}` +
      `${pinned.length > 6 ? ` 等 ${pinned.length} 个` : ''}。` +
      '显式版本会绕过 BOM 对齐，容易出现“pom 写的版本”和“实际生效版本”不一致。' +
      '建议逐个删除显式 version，交给 BOM 管理，改完用 mvn dependency:tree 复核；这一步不放进自动升级计划。',
    impact: pinned.length,
    impactLabel: '个依赖'
  };
}

/** 从 pom + import 引用推导依赖治理建议 */
export function buildConsolidationSuggestions(root: string): Suggestion[] {
  const pom = readPom(root);
  const bootVersion = detectBootVersion(pom);
  if (!bootVersion) {
    return [];
  }
  const deps = parseDirectDependencies(pom);
  const suggestions: Suggestion[] = [];
  for (const family of FAMILIES) {
    const suggestion = buildFamilySuggestion(root, bootVersion, deps, family);
    if (suggestion) {
      suggestions.push(suggestion);
    }
  }
  const bom = buildBomAlignmentSuggestion(bootVersion, deps);
  if (bom) {
    suggestions.push(bom);
  }
  return suggestions;
}
