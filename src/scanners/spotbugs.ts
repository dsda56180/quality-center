import * as fs from 'fs';
import * as path from 'path';
import { Issue, Severity } from '../model';
import { isMissingCommand, run, tailMessage } from '../exec';
import { mavenMirrorArgs } from '../maven';
import { injectPluginIntoBuild } from '../pomInject';
import { localizeSpotbugs } from '../zh';

/** SpotBugs 4.7.x 是最后一个可在 JDK 8 运行的分析器版本 */
const PLUGIN = 'com.github.spotbugs:spotbugs-maven-plugin:4.7.3.0';
const FINDSECBUGS_VERSION = '1.14.0';
/** 临时 pom 文件名：放在项目根目录，保证 basedir 与 target 路径不变 */
const TEMP_POM = '.qc-spotbugs-pom.xml';

/**
 * FindSecBugs 必须写进 pom 的 `<build><plugins>` 才生效：
 * spotbugs-maven-plugin 的 plugins 参数没有 userProperty，`-Dspotbugs.plugins` 传不进去。
 */
const PLUGIN_BLOCK = `<plugin>
  <groupId>com.github.spotbugs</groupId>
  <artifactId>spotbugs-maven-plugin</artifactId>
  <version>${PLUGIN.split(':')[2]}</version>
  <configuration>
    <effort>Max</effort>
    <threshold>Low</threshold>
    <plugins>
      <plugin>
        <groupId>com.h3xstream.findsecbugs</groupId>
        <artifactId>findsecbugs-plugin</artifactId>
        <version>${FINDSECBUGS_VERSION}</version>
      </plugin>
    </plugins>
  </configuration>
</plugin>`;

export interface SpotbugsResult {
  issues: Issue[];
  error?: string;
  /** 没有编译产物，需要先构建 */
  needsBuild?: boolean;
  reportFile?: string;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

/** SpotBugs 报告里单双引号混用，需要两种都支持 */
function parseAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:-]+)=['"]([^'"]*)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    attrs[m[1]] = decodeEntities(m[2]);
  }
  return attrs;
}

function pickTag(body: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
  return match ? decodeEntities(match[1]).trim() : '';
}

/** SpotBugs priority：1 最高。安全类问题升一级，因为影响面通常更大 */
function toSeverity(category: string, priority: string): Severity {
  const level = Number(priority) || 3;
  const base: Severity = level <= 1 ? 'high' : level === 2 ? 'medium' : 'low';
  if (category === 'SECURITY') {
    return base === 'high' ? 'critical' : base === 'medium' ? 'high' : 'medium';
  }
  return base;
}

/** 检查是否有可分析的字节码，避免在未构建的项目上白跑一次 Maven */
function hasClasses(dir: string): boolean {
  const stack: { path: string; depth: number }[] = [{ path: dir, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.class')) {
        return true;
      }
      if (entry.isDirectory() && current.depth < 8) {
        stack.push({ path: path.join(current.path, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return false;
}

function resolveSourceFile(root: string, srcDirs: string[], sourcepath: string): string | undefined {
  if (!sourcepath) {
    return undefined;
  }
  const candidates = path.isAbsolute(sourcepath)
    ? [sourcepath]
    : [...srcDirs.map((dir) => path.join(dir, sourcepath)), path.join(root, 'src', 'main', 'java', sourcepath)];
  return candidates.find((file) => fs.existsSync(file));
}

export async function scanSpotbugs(
  root: string,
  mvn = 'mvn'
): Promise<SpotbugsResult> {
  const classesDir = path.join(root, 'target', 'classes');
  if (!fs.existsSync(classesDir) || !hasClasses(classesDir)) {
    return { issues: [], needsBuild: true };
  }

  const reportFile = path.join(root, 'target', 'spotbugsXml.xml');
  try {
    if (fs.existsSync(reportFile)) {
      fs.unlinkSync(reportFile);
    }
  } catch {
    // 删除失败不影响后续执行，插件会覆盖写入
  }

  // 把 FindSecBugs 注入一份临时 pom：项目自己配了就不动，非 Maven 项目只能跑核心规则
  const pomFile = path.join(root, 'pom.xml');
  const tempPom = path.join(root, TEMP_POM);
  let pomArgs: string[] = [];
  let injectError: string | undefined;

  if (fs.existsSync(pomFile)) {
    const pomText = fs.readFileSync(pomFile, 'utf8');
    if (/findsecbugs/i.test(pomText)) {
      // 用户已自行配置 FindSecBugs，直接用原 pom
    } else {
      const injected = injectPluginIntoBuild(pomText, PLUGIN_BLOCK);
      if (injected.injected) {
        fs.writeFileSync(tempPom, injected.text, 'utf8');
        pomArgs = ['-f', TEMP_POM];
      } else {
        injectError = `FindSecBugs 注入失败（${injected.reason ?? '未知原因'}），本次只运行 SpotBugs 核心规则`;
      }
    }
  } else {
    injectError = '项目没有 pom.xml，无法注入 FindSecBugs，本次只运行 SpotBugs 核心规则';
  }

  let result;
  try {
    result = await run(
      mvn,
      [
        '-B',
        '-q',
        ...mavenMirrorArgs(),
        ...pomArgs,
        `${PLUGIN}:spotbugs`,
        '-Dspotbugs.effort=Max',
        '-Dspotbugs.threshold=Low',
        '-Dspotbugs.failOnError=false',
        '-Dspotbugs.consoleOutput=false',
        '-Dspotbugs.xmlOutput=true'
      ],
      root,
      240_000,
      { MAVEN_OPTS: '-Dfile.encoding=UTF-8' }
    );
  } finally {
    if (fs.existsSync(tempPom)) {
      try {
        fs.unlinkSync(tempPom);
      } catch {
        // 删除失败不影响扫描结果
      }
    }
  }

  if (!fs.existsSync(reportFile)) {
    const raw = `${result.stderr}\n${result.stdout}`;
    if (isMissingCommand(raw)) {
      return {
        issues: [],
        error: '找不到 mvn 命令，无法启动 SpotBugs。请先安装 Maven 并确保它在 PATH 中，或在设置里配置 qualityCenter.maven.path。'
      };
    }
    const detail = tailMessage(raw, 5);
    const timeout = result.code === 124 ? '（执行超时）' : '';
    return {
      issues: [],
      error: detail
        ? `SpotBugs 未生成报告（退出码 ${result.code}${timeout}）：\n${detail}`
        : `SpotBugs 未生成报告（退出码 ${result.code}${timeout}）。` +
          '常见原因：Maven 拉不到 spotbugs-maven-plugin（网络/镜像问题）、pom 中已有插件版本与之冲突。' +
          `可在项目根目录执行 mvn ${PLUGIN}:spotbugs 复现并查看完整日志。`
    };
  }

  const xml = fs.readFileSync(reportFile, 'utf8');
  const srcDirs = Array.from(xml.matchAll(/<SrcDir>([^<]*)<\/SrcDir>/g)).map((m) => decodeEntities(m[1]));
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const bugRe = /<BugInstance\b([^>]*)>([\s\S]*?)<\/BugInstance>/g;
  let bugMatch: RegExpExecArray | null;

  while ((bugMatch = bugRe.exec(xml)) !== null) {
    const attrs = parseAttributes(bugMatch[1]);
    const body = bugMatch[2];
    const type = attrs.type || 'SpotBugs';
    const category = attrs.category || '';
    const longMessage = pickTag(body, 'LongMessage');
    const shortMessage = pickTag(body, 'ShortMessage');

    // 一个 BugInstance 可能带多个 SourceLine：类声明范围、方法范围、精确行。
    // 优先取 primary='true' 的精确行，避免跳到类声明处。
    const sourceLines = Array.from(body.matchAll(/<SourceLine\b[^>]*sourcepath=['"]([^'"]+)['"][^>]*>/g));
    const primary = sourceLines.find((item) => /primary=['"]true['"]/.test(item[0]));
    const precise = sourceLines.filter((item) => /start=['"]\d+['"]/.test(item[0]));
    const picked = primary ?? precise[precise.length - 1] ?? sourceLines[0];
    const sourcepath = picked ? decodeEntities(picked[1]) : '';
    const startMatch = picked ? /start=['"](\d+)['"]/.exec(picked[0]) : null;
    const line = startMatch ? Number(startMatch[1]) : 1;

    const key = `${type}|${sourcepath}|${line}|${longMessage || shortMessage}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    issues.push(
      localizeSpotbugs({
        source: 'spotbugs',
        severity: toSeverity(category, attrs.priority || '3'),
        file: resolveSourceFile(root, srcDirs, sourcepath),
        line,
        column: 1,
        rule: type,
        message: longMessage || shortMessage || type,
        title: shortMessage || type,
        category,
        cwe: attrs.cweid ? [`CWE-${attrs.cweid}`] : []
      })
    );
  }

  // 注入失败且没有告警时，说明结果可能因规则缺失而不完整，需要让调用方知道
  return injectError && issues.length === 0
    ? { issues, reportFile, error: injectError }
    : { issues, reportFile };
}
