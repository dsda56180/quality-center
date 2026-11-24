/**
 * 代码层语义规则（AST）：用 ast-grep 的 Java 语法树做结构匹配。
 *
 * 字节码（SpotBugs / FindSecBugs）看的是编译后形态，`permitAll()` 打到 `/actuator/**`
 * 这种「方法链 + 字符串字面量」的语义在字节码里已经散成 ldc + 调用序列，规则很难写；
 * 正则又会在注释、字符串里误报。所以这一层直接解析 Java 源码，按 AST 结构判断：
 *   1. `$A.permitAll()` 所在语句里是否出现敏感路径（或 `anyRequest().permitAll()`）
 *   2. `log/logger.debug|info|warn|error(...)` 的参数里是否带敏感字段
 *   3. `MultipartFile` 参数所在方法体里是否有大小/类型校验
 *
 * 引擎是 @ast-grep/napi（原生 napi 模块，Java 语法由 @ast-grep/lang-java 的 wasm 提供），
 * 按平台打包在扩展的 node_modules 里；平台不匹配时降级为 skipped，不阻塞其它扫描器。
 */
import * as fs from 'fs';
import * as path from 'path';
import { Issue, Severity } from '../model';

interface SgRange {
  start: { line: number; column: number };
}

interface SgNode {
  kind(): string;
  text(): string;
  range(): SgRange;
  field(name: string): SgNode | null;
  parent(): SgNode | null;
  findAll(rule: unknown): SgNode[];
}

interface SgRoot {
  root(): SgNode;
}

interface AstGrep {
  parse(language: string, code: string): SgRoot;
  registerDynamicLanguage(languages: Record<string, unknown>): void;
}

export interface AstscanResult {
  issues: Issue[];
  /** 引擎不可用时的原因（平台不匹配 / 模块缺失） */
  unavailable?: string;
  error?: string;
  files: number;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'out', 'dist', '.idea', '.gradle', 'fixtures']);
const MAX_BYTES = 1_500_000;

/** 敏感管理/调试路径：这些路径一旦 permitAll 就等于把运维面公开 */
const SENSITIVE_PATHS = [
  'actuator',
  'admin',
  'druid',
  'swagger',
  'api-docs',
  'doc.html',
  'h2-console',
  'jolokia',
  'monitor',
  'manage',
  'internal'
];

const SENSITIVE_FIELDS = /password|passwd|pwd|token|secret|credential|idcard|idno|mobile|phone|email|session/i;
const LOG_METHODS = ['trace', 'debug', 'info', 'warn', 'error'];
const LOG_RECEIVERS = /^(log|logger|_log|LOG|LOGGER)$/;

const UPLOAD_GUARD = /getSize\s*\(\)|getContentType|maxFileSize|max-request-size|checkFile|allowedTypes|allowedExtensions|@Size|contentType|MultipartFilter/i;

let engine: AstGrep | undefined;
let engineError: string | undefined;

/** 惰性加载：只有真的要跑 AST 层时才碰原生模块 */
function loadEngine(): AstGrep | undefined {
  if (engine) {
    return engine;
  }
  if (engineError) {
    return undefined;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const napi = require('@ast-grep/napi') as AstGrep;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const javaLang = require('@ast-grep/lang-java') as Record<string, unknown>;
    napi.registerDynamicLanguage({ java: javaLang });
    engine = napi;
    return engine;
  } catch (error) {
    engineError = error instanceof Error ? error.message : String(error);
    return undefined;
  }
}

function collectJavaFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          walk(path.join(dir, entry.name), depth + 1);
        }
        continue;
      }
      if (entry.name.endsWith('.java')) {
        files.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root, 0);
  return files;
}

const lineOf = (node: SgNode): number => node.range().start.line + 1;

/** 向上找到最近的指定类型节点，用于把「调用」升级成整条语句 / 整个方法 */
function climb(node: SgNode, kinds: string[]): SgNode | undefined {
  let current: SgNode | null = node;
  while (current) {
    if (kinds.includes(current.kind())) {
      return current;
    }
    current = current.parent();
  }
  return undefined;
}

function makeIssue(
  file: string,
  node: SgNode,
  rule: string,
  severity: Severity,
  cwe: string,
  message: string,
  advice: string
): Issue {
  return {
    source: 'astgrep',
    severity,
    file,
    line: lineOf(node),
    column: node.range().start.column + 1,
    rule,
    message,
    advice,
    cwe: [cwe]
  };
}

/** 规则 1：permitAll 打到敏感路径，或 anyRequest 全放行 */
function checkPermitAll(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const call of root.findAll({ rule: { pattern: '$A.permitAll()' } })) {
    if (call.kind() !== 'method_invocation') {
      continue;
    }
    // 只看这条调用链自己的匹配器参数，不能拿整条表达式语句判断：
    // 多行链式写法里 `.antMatchers("/actuator/**").hasRole(...)` 也在同一语句内，按整句匹配会误报
    let receiver: SgNode | null = call.field('object');
    let matcherArgs: string | undefined;
    let anyRequest = false;
    while (receiver && receiver.kind() === 'method_invocation') {
      const name = receiver.field('name')?.text();
      if (name === 'anyRequest') {
        anyRequest = true;
      }
      if (
        name &&
        /^(antMatchers|mvcMatchers|requestMatchers|regexMatchers|antMatcher)$/.test(name)
      ) {
        matcherArgs = receiver.field('arguments')?.text() ?? '';
        break;
      }
      receiver = receiver.field('object');
    }

    if (anyRequest) {
      issues.push(
        makeIssue(
          file,
          call,
          'AST_PERMIT_ALL_SENSITIVE_PATH',
          'high',
          'CWE-284',
          'anyRequest().permitAll() 对全部请求放行，等于关闭了鉴权',
          '改成按路径白名单放行；除登录、健康检查外不要对 anyRequest 使用 permitAll。'
        )
      );
      continue;
    }
    if (!matcherArgs) {
      continue;
    }
    const hit = SENSITIVE_PATHS.find((name) => new RegExp(`["']\\S*${name}`, 'i').test(matcherArgs!));
    if (!hit) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        call,
        'AST_PERMIT_ALL_SENSITIVE_PATH',
        'high',
        'CWE-284',
        `permitAll() 覆盖了敏感路径（含「${hit}」），管理/调试端点会绕过鉴权`,
        '把该路径改为 hasRole/hasAuthority 或显式 IP 白名单；运维端点应走独立的管理端口与认证。'
      )
    );
  }
  return issues;
}

/** 规则 2：日志里打印口令、令牌等敏感字段 */
function checkSensitiveLog(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    const name = call.field('name');
    const receiver = call.field('object');
    if (!name || !LOG_METHODS.includes(name.text())) {
      continue;
    }
    if (!receiver || !LOG_RECEIVERS.test(receiver.text())) {
      continue;
    }
    const args = call.field('arguments');
    if (!args) {
      continue;
    }
    const argText = args.text();
    if (!SENSITIVE_FIELDS.test(argText)) {
      continue;
    }
    const field = SENSITIVE_FIELDS.exec(argText)?.[0] ?? '敏感字段';
    issues.push(
      makeIssue(
        file,
        call,
        'AST_LOG_SENSITIVE_FIELD',
        'medium',
        'CWE-532',
        `日志语句输出了疑似敏感字段（${field}），日志落地后等同于泄露`,
        '改为只记录标识（用户 ID、脱敏后的尾号），或对参数做脱敏/掩码后再输出。'
      )
    );
  }
  return issues;
}

/** 规则 3：上传参数所在方法没有大小/类型校验 */
function checkUploadValidation(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const param of root.findAll({ rule: { kind: 'formal_parameter' } })) {
    if (!/MultipartFile/.test(param.text())) {
      continue;
    }
    const method = climb(param, ['method_declaration', 'constructor_declaration']);
    if (!method) {
      continue;
    }
    const body = method.field('body');
    const bodyText = body ? body.text() : '';
    if (UPLOAD_GUARD.test(bodyText)) {
      continue;
    }
    const methodName = method.field('name')?.text() ?? '(未知方法)';
    issues.push(
      makeIssue(
        file,
        param,
        'AST_UPLOAD_WITHOUT_VALIDATION',
        'medium',
        'CWE-434',
        `方法 ${methodName} 接收 MultipartFile 但没有任何大小/类型校验，可被上传超大或可执行文件`,
        '在入口处校验 getSize() 上限、扩展名与 Content-Type 白名单，并限制上传目录不可执行。'
      )
    );
  }
  return issues;
}

export async function scanAstgrep(root: string): Promise<AstscanResult> {
  const ast = loadEngine();
  if (!ast) {
    return {
      issues: [],
      unavailable:
        `AST 引擎不可用（@ast-grep/napi 无法在当前平台加载）：${engineError ?? '未知原因'}`,
      files: 0
    };
  }

  const files = collectJavaFiles(root);
  const issues: Issue[] = [];
  let parsed = 0;

  for (const file of files) {
    let text: string;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_BYTES) {
        continue;
      }
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let tree: SgRoot;
    try {
      tree = ast.parse('java', text);
    } catch {
      continue;
    }
    parsed += 1;
    const treeRoot = tree.root();
    issues.push(...checkPermitAll(file, treeRoot));
    issues.push(...checkSensitiveLog(file, treeRoot));
    issues.push(...checkUploadValidation(file, treeRoot));
  }

  return { issues, files: parsed };
}
