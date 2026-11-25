import * as fs from 'fs';
import * as path from 'path';
import { Suggestion } from './model';

/**
 * 依赖收敛建议：版本升级解决“漏洞”，这里解决“同一种能力被多个库重复实现”。
 *
 * 只产出建议，不自动删依赖。原因是删库几乎一定伴随代码迁移，
 * 必须让 AI/人先看引用面，再决定替换顺序。
 */

interface DirectDependency {
  groupId: string;
  artifactId: string;
  version?: string;
  scope?: string;
}

interface JsonAlternative {
  name: string;
  groupId: string;
  artifactId?: string;
  importPrefixes: string[];
}

/** Spring Boot 自带 Jackson；以下 JSON 实现同时出现时视为重复能力 */
const JSON_ALTERNATIVES: JsonAlternative[] = [
  { name: 'fastjson', groupId: 'com.alibaba', artifactId: 'fastjson', importPrefixes: ['com.alibaba.fastjson'] },
  { name: 'fastjson2', groupId: 'com.alibaba.fastjson2', artifactId: 'fastjson2', importPrefixes: ['com.alibaba.fastjson2'] },
  { name: 'Gson', groupId: 'com.google.code.gson', artifactId: 'gson', importPrefixes: ['com.google.gson'] },
  { name: 'Jackson 1.x', groupId: 'org.codehaus.jackson', importPrefixes: ['org.codehaus.jackson'] },
  { name: 'json-lib', groupId: 'net.sf.json-lib', importPrefixes: ['net.sf.json'] },
  { name: 'org.json', groupId: 'org.json', artifactId: 'json', importPrefixes: ['org.json'] }
];

const SKIP_DIRS = new Set(['target', 'build', 'out', 'node_modules', '.git', '.idea', '.quality-center']);

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
  const blocks = pom.match(/<dependency>[\s\S]*?<\/dependency>/g) || [];
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

function hasDependency(deps: DirectDependency[], alternative: JsonAlternative): boolean {
  return deps.some(
    (dep) =>
      dep.groupId === alternative.groupId &&
      (alternative.artifactId ? dep.artifactId === alternative.artifactId : true)
  );
}

/** 从 pom + import 引用推导依赖收敛建议 */
export function buildConsolidationSuggestions(root: string): Suggestion[] {
  const pom = readPom(root);
  const bootVersion = detectBootVersion(pom);
  if (!bootVersion) {
    return [];
  }
  const deps = parseDirectDependencies(pom);
  const present = JSON_ALTERNATIVES.filter((item) => hasDependency(deps, item));
  if (present.length === 0) {
    return [];
  }

  const prefixes = present.flatMap((item) => item.importPrefixes);
  const usage = countImportUsage(root, prefixes);
  const referenced = present.filter((item) =>
    item.importPrefixes.some((prefix) => usage.counts[prefix] > 0)
  );
  const unused = present.filter((item) => !referenced.includes(item));

  const names = present.map((item) => item.name).join('、');
  const refText = referenced.length
    ? referenced
        .map((item) => {
          const files = item.importPrefixes.reduce((sum, prefix) => sum + usage.counts[prefix], 0);
          return `${item.name} ${files} 个文件`;
        })
        .join('、')
    : '';
  const unusedText = unused.length ? `${unused.map((item) => item.name).join('、')} 未发现代码引用` : '';

  return [
    {
      category: 'duplicate',
      title: `JSON 实现收敛：${names} → Spring Boot 自带 Jackson`,
      detail:
        `Spring Boot ${bootVersion} 已自带 Jackson，项目又直接引入了 ${names}，属于同一能力重复实现。` +
        (refText ? `当前扫描到 ${refText}仍在使用；` : '') +
        (unusedText ? `${unusedText}；` : '') +
        '建议统一到 Jackson：先把 ObjectMapper/序列化入口收敛，再逐个替换 import，最后移除依赖并复扫。' +
        '插件不会自动删依赖；有自定义序列化行为差异时先人工确认。',
      impact: Math.max(1, referenced.reduce(
        (sum, item) => sum + item.importPrefixes.reduce((inner, prefix) => inner + usage.counts[prefix], 0),
        0
      ) + present.length)
    }
  ];
}
