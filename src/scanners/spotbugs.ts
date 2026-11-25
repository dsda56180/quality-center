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
    <outputDirectory>\${qc.spotbugs.output}</outputDirectory>
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

/** 从 Maven 输出里挑出真正的原因：去掉噪音、折叠重复前缀，优先「Failed to execute goal」那一段 */
function mavenFailureDetail(raw: string): string {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) {
      continue;
    }
    // JVM 启动横幅、下载进度、构建分段线、帮助链接都不构成失败原因
    if (/^(Picked up\b|Downloading|Downloaded|Progress|\s*---|BUILD |Total time)/i.test(text)) {
      continue;
    }
    if (/cwiki\.apache\.org|\[Help \d\]/.test(text)) {
      continue;
    }
    const normalized = text.replace(/^(\[ERROR\]\s*)+/, '[ERROR] ').replace(/^(\[WARNING\]\s*)+/, '[WARNING] ');
    if (/^\[(ERROR|WARNING)\]\s*$/.test(normalized)) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    cleaned.push(normalized);
  }
  const goal = cleaned.findIndex((line) => /Failed to execute goal/i.test(line));
  if (goal >= 0) {
    const picked = [cleaned[goal]];
    for (let i = goal + 1; i < cleaned.length && picked.length < 4; i++) {
      const line = cleaned[i];
      // 帮助链接与「重跑加 -e」都是模板话术，不是原因本身
      if (/^-+$|Help \d|Re-run Maven|For more information/.test(line)) {
        break;
      }
      picked.push(line);
    }
    return picked.join('\n');
  }
  // 没有 goal 行时，优先找带「真实原因」关键词的那一行（POM 解析、依赖解析、文件创建失败）
  const cause = cleaned.findIndex((line) =>
    /Cannot create file|FileResourceCreation|拒绝访问|Permission denied|Could not resolve|Non-resolvable|Non-parseable|Unrecognised tag|FATAL|not found|Unknown |Invalid |ModelParse|ProjectBuilding/i.test(
      line
    )
  );
  if (cause >= 0) {
    return cleaned.slice(cause, cause + 2).join('\n');
  }
  const errors = cleaned.filter((line) => /^\[ERROR\]/.test(line));
  return (errors.length > 0 ? errors.slice(0, 3) : cleaned.slice(-4)).join('\n');
}

/** 报告写不进去（目录不可写/被占用/路径过长）时，改用临时目录再试一次 */
function isOutputWriteFailure(detail: string): boolean {
  return /FileResourceCreation|Cannot create file|Permission denied|Access is denied|拒绝访问|无法创建/i.test(
    detail
  );
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
  const targetDir = path.join(root, 'target');
  const fallbackDir = path.join(root, '.quality-center', 'spotbugs-out');
  const cleanupReport = (file: string): void => {
    try {
      // 只删普通文件：同名目录说明上一次写入异常，删不掉就交给下面的写失败重试
      if (fs.statSync(file).isFile()) {
        fs.unlinkSync(file);
      }
    } catch {
      // 不存在或不可删都不影响后续执行
    }
  };
  const hasReport = (file: string): boolean => {
    try {
      const stat = fs.statSync(file);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  };
  cleanupReport(reportFile);
  cleanupReport(path.join(fallbackDir, 'spotbugsXml.xml'));

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

  const mavenArgs = (outputDir: string): string[] => [
    '-B',
    '-q',
    ...mavenMirrorArgs(),
    ...pomArgs,
    `${PLUGIN}:spotbugs`,
    `-Dqc.spotbugs.output=${outputDir}`,
    '-Dspotbugs.effort=Max',
    '-Dspotbugs.threshold=Low',
    '-Dspotbugs.failOnError=false',
    '-Dspotbugs.consoleOutput=false',
    '-Dspotbugs.xmlOutput=true'
  ];

  let result;
  let actualReport = reportFile;
  try {
    result = await run(mvn, mavenArgs(targetDir), root, 240_000, {
      MAVEN_OPTS: '-Dfile.encoding=UTF-8'
    });
    if (!hasReport(actualReport)) {
      const detail = mavenFailureDetail(`${result.stderr}\n${result.stdout}`);
      if (isOutputWriteFailure(detail) || fs.existsSync(actualReport)) {
        // 目标路径上是个目录/占位文件（上次异常写入留下的）：先挪开再原路重跑
        try {
          if (fs.existsSync(actualReport) && !hasReport(actualReport)) {
            fs.renameSync(actualReport, `${actualReport}.bak-${Date.now()}`);
            result = await run(mvn, mavenArgs(targetDir), root, 240_000, {
              MAVEN_OPTS: '-Dfile.encoding=UTF-8'
            });
          }
        } catch {
          // 挪不动就走下面的临时目录方案
        }
      }
      if (!hasReport(actualReport) && isOutputWriteFailure(detail)) {
        // target 写不进去（只读盘、被杀软/编辑器占用、路径过长）：把报告改写到插件自己的目录再跑一次
        try {
          fs.mkdirSync(fallbackDir, { recursive: true });
          result = await run(mvn, mavenArgs(fallbackDir), root, 240_000, {
            MAVEN_OPTS: '-Dfile.encoding=UTF-8'
          });
          const fallbackReport = path.join(fallbackDir, 'spotbugsXml.xml');
          if (hasReport(fallbackReport)) {
            actualReport = fallbackReport;
          }
        } catch {
          // 重试失败就回到原始报错，错误信息里已经带上完整日志位置
        }
      }
    }
  } finally {
    if (fs.existsSync(tempPom)) {
      try {
        fs.unlinkSync(tempPom);
      } catch {
        // 删除失败不影响扫描结果
      }
    }
  }

  if (!hasReport(actualReport)) {
    const raw = `${result.stderr}\n${result.stdout}`;
    if (isMissingCommand(raw)) {
      return {
        issues: [],
        error: '找不到 mvn 命令，无法启动 SpotBugs。请先安装 Maven 并确保它在 PATH 中，或在设置里配置 qualityCenter.maven.path。'
      };
    }
    const detail = mavenFailureDetail(raw) || tailMessage(raw, 5);
    const timeout = result.code === 124 ? '（执行超时）' : '';
    // 完整日志落盘：面板只放结论，细节留在文件里可追溯
    let logPath = '';
    try {
      const logDir = path.join(root, '.quality-center', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      logPath = path.join(logDir, 'spotbugs.log');
      fs.writeFileSync(logPath, raw, 'utf8');
    } catch {
      logPath = '';
    }
    const writeHint = isOutputWriteFailure(detail)
      ? '\n报告目录不可写（target 只读、被杀软/编辑器占用或路径过长）。已自动改用 .quality-center/spotbugs-out 重试；仍失败时请关闭占用程序，或在项目根执行 `mvn com.github.spotbugs:spotbugs-maven-plugin:4.7.3.0:spotbugs -e` 复查。'
      : '';
    return {
      issues: [],
      error:
        (detail
          ? `SpotBugs 未生成报告（退出码 ${result.code}${timeout}）：\n${detail}`
          : `SpotBugs 未生成报告（退出码 ${result.code}${timeout}）。` +
            '常见原因：Maven 拉不到 spotbugs-maven-plugin（网络/镜像问题）、pom 中已有插件版本与之冲突。') +
        writeHint +
        (logPath ? `\n完整日志：${logPath}` : '')
    };
  }

  const xml = fs.readFileSync(actualReport, 'utf8');  const srcDirs = Array.from(xml.matchAll(/<SrcDir>([^<]*)<\/SrcDir>/g)).map((m) => decodeEntities(m[1]));
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
    ? { issues, reportFile: actualReport, error: injectError }
    : { issues, reportFile: actualReport };
}
