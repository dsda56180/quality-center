import * as fs from 'fs';
import * as path from 'path';
import { Issue, Severity } from '../model';
import { run } from '../exec';

export interface CheckstyleResult {
  issues: Issue[];
  error?: string;
}

const PLUGIN = 'org.apache.maven.plugins:maven-checkstyle-plugin:3.1.2:checkstyle';

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

function parseAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    attrs[m[1]] = decodeEntities(m[2]);
  }
  return attrs;
}

function toSeverity(severity: string): Severity {
  switch ((severity || '').toLowerCase()) {
    case 'error':
      return 'high';
    case 'warning':
      return 'medium';
    case 'info':
      return 'low';
    default:
      return 'medium';
  }
}

function ruleName(source: string): string {
  if (!source) {
    return 'Checkstyle';
  }
  const last = source.split('.').pop() || source;
  return last.replace(/Check$/, '');
}

/**
 * 按规则类型映射真实风险等级。
 * checkstyle 配置里的 error/warning 只代表规则严格程度，不代表风险高低，
 * 因此对常见规则给出语义化等级，未收录的规则回退到配置映射。
 */
const RULE_SEVERITY: Record<string, Severity> = {
  // 卫生类
  UnusedImports: 'low',
  RedundantImport: 'low',
  ModifierOrder: 'low',
  EmptyStatement: 'low',
  OneTopLevelClass: 'low',
  // 可读性/健壮性
  SimplifyBooleanExpression: 'medium',
  DefaultComesLast: 'medium',
  // 真实缺陷
  StringLiteralEquality: 'medium',
  EqualsHashCode: 'high',
  IllegalImport: 'high'
};

/**
 * 解析规则文件：显式配置 > 项目内常见位置 > 扩展内置默认规则。
 * 内置兜底保证没有任何配置的 Java 项目也能立即出结果，不会因缺规则文件被跳过。
 */
export function resolveConfig(root: string, configured: string, bundled: string): string | undefined {
  const candidates = configured
    ? [path.isAbsolute(configured) ? configured : path.join(root, configured)]
    : [
        path.join(root, '.githooks', 'checkstyle-config.xml'),
        path.join(root, 'checkstyle.xml'),
        path.join(root, 'config', 'checkstyle', 'checkstyle.xml'),
        path.join(root, 'src', 'main', 'resources', 'checkstyle.xml')
      ];
  const found = candidates.find((file) => fs.existsSync(file));
  if (found) {
    return found;
  }
  return fs.existsSync(bundled) ? bundled : undefined;
}

export async function scanCheckstyle(
  root: string,
  configPath: string,
  outputFile: string
): Promise<CheckstyleResult> {
  try {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    if (fs.existsSync(outputFile)) {
      fs.unlinkSync(outputFile);
    }
  } catch {
    // 输出目录不可写时交给下方报错处理
  }

  const result = await run(
    'mvn',
    [
      '-B',
      '-q',
      PLUGIN,
      `-Dcheckstyle.config.location=${configPath}`,
      `-Dcheckstyle.output.file=${outputFile}`,
      '-Dcheckstyle.consoleOutput=false',
      '-Dcheckstyle.includeTestSourceDirectory=false',
      '-Dcheckstyle.violationSeverity=warning'
    ],
    root,
    300_000,
    { MAVEN_OPTS: '-Dfile.encoding=UTF-8' }
  );

  if (!fs.existsSync(outputFile)) {
    const detail = (result.stderr || result.stdout).split(/\r?\n/).filter(Boolean).slice(-5).join('\n');
    return { issues: [], error: detail || `Checkstyle 未生成报告（退出码 ${result.code}）` };
  }

  const xml = fs.readFileSync(outputFile, 'utf8');
  const issues: Issue[] = [];
  const fileRe = /<file\s+name="([^"]*)">([\s\S]*?)<\/file>/g;
  let fileMatch: RegExpExecArray | null;

  while ((fileMatch = fileRe.exec(xml)) !== null) {
    const fileName = decodeEntities(fileMatch[1]);
    const body = fileMatch[2];
    const errorRe = /<error\s+([^>]*?)\/>/g;
    let errorMatch: RegExpExecArray | null;
    while ((errorMatch = errorRe.exec(body)) !== null) {
      const attrs = parseAttributes(errorMatch[1]);
      const rule = ruleName(attrs.source);
      issues.push({
        source: 'checkstyle',
        severity: RULE_SEVERITY[rule] ?? toSeverity(attrs.severity),
        file: path.isAbsolute(fileName) ? fileName : path.join(root, fileName),
        line: Number(attrs.line) || 1,
        column: Number(attrs.column) || 1,
        rule,
        message: (attrs.message || '').trim()
      });
    }
  }

  return { issues };
}
