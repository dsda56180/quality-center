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
  'internal',
  'management',
  'nacos',
  'sentinel',
  'heapdump',
  'threaddump',
  'configprops',
  'prometheus',
  'eureka',
  'jmx'
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

/** 模板文件（Thymeleaf / JSP）单独收集，用于检查未转义输出 */
function collectTemplateFiles(root: string): string[] {
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
      if (/\.(html|htm|jsp)$/i.test(entry.name)) {
        files.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root, 0);
  return files;
}

const lineOf = (node: SgNode): number => node.range().start.line + 1;

/**
 * 匹配器参数里常见「白名单常量」写法：`antMatchers(WHITELIST).permitAll()`。
 * 只按参数文本判断会漏掉这类写法，这里把同文件里同名常量/局部变量的字面量值展开进来：
 *   - 字段常量：全文件查找，`static final String[]` / `String` 都覆盖
 *   - 局部变量：只在调用所在的同一方法体内查找，避免跨方法同名变量干扰
 *   - `@Value("${key:/actuator}")`：取占位里的默认值，覆盖「路径从配置注入」的写法
 * 只展开一层，不做传递推导。
 */
function expandConstantArgs(root: SgNode, argsText: string, context?: SgNode): string {
  const names = new Set(argsText.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const parts = [argsText];
  const fields = root.findAll({ rule: { kind: 'field_declaration' } });
  const locals = context
    ? context.field('body')?.findAll({ rule: { kind: 'local_variable_declaration' } }) ?? []
    : [];
  for (const declaration of fields.concat(locals)) {
    const declarator = declaration.field('declarator');
    const name = declarator?.field('name')?.text();
    if (!name || !names.has(name)) {
      continue;
    }
    const value = declarator?.field('value')?.text() ?? '';
    if (value) {
      parts.push(value);
    }
    // 字段本身走 @Value 注入时，默认值才是运行时的兜底路径
    const text = declaration.text();
    const injected = /@Value\s*\(\s*(?:"\$\{[^:}]+:([^}"]*)\}"|'\$\{[^:}]+:([^'}]*)\}')\s*\)/.exec(text);
    const fallback = injected?.[1] ?? injected?.[2];
    if (fallback) {
      parts.push(`"${fallback}"`);
    }
  }
  return parts.join(' ');
}

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
    matcherArgs = expandConstantArgs(root, matcherArgs, climb(call, ['method_declaration', 'constructor_declaration']));
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

  // `web.ignoring().antMatchers(...)` 直接跳过整个安全过滤器链，后果比 permitAll 更重
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    const name = call.field('name')?.text();
    if (!name || !/^(antMatchers|mvcMatchers|requestMatchers|regexMatchers)$/.test(name)) {
      continue;
    }
    const chain = call.field('object')?.text() ?? '';
    if (!/ignoring\s*\(\s*\)/.test(chain)) {
      continue;
    }
    const args = expandConstantArgs(
      root,
      call.field('arguments')?.text() ?? '',
      climb(call, ['method_declaration', 'constructor_declaration'])
    );
    const hit = SENSITIVE_PATHS.find((item) => new RegExp(`["']\\S*${item}`, 'i').test(args));
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
        `web.ignoring() 让敏感路径（含「${hit}」）完全绕过 Spring Security 过滤器链`,
        'web.ignoring() 只用于静态资源；管理/调试路径应留在过滤器链内并显式要求角色。'
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

/** 规则 4：SQL 由字符串拼接构造后直接执行（预编译占位符之外的写法） */
const SQL_APIS = new Set([
  'executeQuery',
  'executeUpdate',
  'execute',
  'query',
  'queryForList',
  'queryForObject',
  'queryForMap',
  'update'
]);

/** 方法形参 + 由请求取值 API 赋值的局部变量，视为「外部可控」 */
function externalNames(method: SgNode): Set<string> {
  const names = new Set<string>();
  const parameters = method.field('parameters');
  if (parameters) {
    for (const param of parameters.findAll({ rule: { kind: 'formal_parameter' } })) {
      const name = param.field('name')?.text();
      if (name) {
        names.add(name);
      }
    }
  }
  const body = method.field('body');
  if (body) {
    for (const declaration of body.findAll({ rule: { kind: 'local_variable_declaration' } })) {
      const declarator = declaration.field('declarator');
      const name = declarator?.field('name')?.text();
      const value = declarator?.field('value')?.text() ?? '';
      if (name && /getParameter\s*\(|getHeader\s*\(|getAttribute\s*\(|getQueryString|getCookies/.test(value)) {
        names.add(name);
      }
    }
  }
  return names;
}

function checkSqlConcat(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    const name = call.field('name');
    if (!name || !SQL_APIS.has(name.text())) {
      continue;
    }
    const args = call.field('arguments');
    if (!args) {
      continue;
    }
    const concat = args
      .findAll({ rule: { kind: 'binary_expression' } })
      .find((bin) => {
        if (!bin.text().includes('+')) {
          return false;
        }
        // 只把「字符串 + 变量/调用」当成风险；`"a" + "b"` 这种纯字面量拼接不算
        return (
          bin.findAll({ rule: { kind: 'identifier' } }).length > 0 ||
          bin.findAll({ rule: { kind: 'method_invocation' } }).length > 0 ||
          bin.findAll({ rule: { kind: 'field_access' } }).length > 0
        );
      });
    if (concat) {
      issues.push(
        makeIssue(
          file,
          call,
          'AST_SQL_STRING_CONCAT',
          'high',
          'CWE-89',
          `${name.text()}() 的 SQL 由字符串拼接构造，外部输入可直接改写语义（注入）`,
          '改用 PreparedStatement 的 `?` 占位符 + setXxx 绑定参数，或 MyBatis 的 `#{}`；不要用 `+` 或 String.format 拼 SQL。'
        )
      );
    }

    // 链式 builder 直接塞进执行调用：executeQuery(new StringBuilder("...").append(x).toString())
    const builders = args
      .findAll({ rule: { kind: 'object_creation_expression' } })
      .filter((node) => /new\s+(java\.lang\.)?(StringBuilder|StringBuffer)/.test(node.text()));
    if (builders.length > 0) {
      const riskyAppend = args
        .findAll({ rule: { kind: 'method_invocation' } })
        .filter((node) => node.field('name')?.text() === 'append')
        .some((node) => !/^\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)$/.test(node.field('arguments')?.text() ?? ''));
      if (riskyAppend) {
        issues.push(
          makeIssue(
            file,
            call,
            'AST_SQL_STRING_CONCAT',
            'high',
            'CWE-89',
            `${name.text()}() 的 SQL 由 StringBuilder/StringBuffer 链式 append 拼出，拼进来的变量可改写语句语义（注入）`,
            '改用 PreparedStatement 占位符；动态片段（表名/排序）用白名单枚举校验，不要 append 外部输入。'
          )
        );
      }
    }
  }

  // String.format("... where id = %s", id)：格式串里是 SQL、参数来自变量，等价于拼接
  const SQL_KEYWORD = /select|insert\s+into|update\s+\w+\s+set|delete\s+from|order\s+by|where|from\s+\w+/i;
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    const name = call.field('name')?.text();
    if (name !== 'format') {
      continue;
    }
    const receiver = call.field('object')?.text() ?? '';
    if (!/^(String|java\.lang\.String)$/.test(receiver)) {
      continue;
    }
    const args = call.field('arguments');
    if (!args) {
      continue;
    }
    const formatLiteral = args.findAll({ rule: { kind: 'string_literal' } })[0];
    if (!formatLiteral || !SQL_KEYWORD.test(formatLiteral.text())) {
      continue;
    }
    const risky =
      args.findAll({ rule: { kind: 'identifier' } }).length > 0 ||
      args.findAll({ rule: { kind: 'method_invocation' } }).length > 0;
    if (!risky) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        call,
        'AST_SQL_STRING_CONCAT',
        'high',
        'CWE-89',
        'String.format 用来拼装 SQL，占位替换后的语句仍由外部输入参与构造（注入）',
        '改用参数化查询；`String.format` 只适合拼日志与提示，不要拼 SQL。'
      )
    );
  }

  // StringBuilder/StringBuffer 逐段 append，最后把整个对象交给执行调用
  const literalArgs = (text: string): boolean =>
    /^\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*)["']?\s*\)$/.test(text) ||
    /^\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*,\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*(?:,\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*)*\)$/.test(
      text
    );
  for (const method of root.findAll({ rule: { kind: 'method_declaration' } })) {
    const body = method.field('body');
    if (!body) {
      continue;
    }
    const builders: string[] = [];
    for (const declaration of body.findAll({ rule: { kind: 'local_variable_declaration' } })) {
      const type = declaration.field('type')?.text() ?? '';
      const variable = declaration.field('declarator')?.field('name')?.text();
      if (variable && /^(StringBuilder|StringBuffer|java\.lang\.(StringBuilder|StringBuffer))$/.test(type)) {
        builders.push(variable);
      }
    }
    if (builders.length === 0) {
      continue;
    }
    for (const call of body.findAll({ rule: { kind: 'method_invocation' } })) {
      const name = call.field('name')?.text();
      if (!name || !SQL_APIS.has(name)) {
        continue;
      }
      const argsText = call.field('arguments')?.text() ?? '';
      const used = builders.find((item) => new RegExp(`\\b${item}\\b`).test(argsText));
      if (!used) {
        continue;
      }
      const appends = body
        .findAll({ rule: { kind: 'method_invocation' } })
        .filter((item) => {
          if (item.field('name')?.text() !== 'append') {
            return false;
          }
          const receiver = item.field('object')?.text() ?? '';
          // `sb.append(a)` 与链式 `sb.append(a).append(b)` 都要覆盖
          return receiver === used || new RegExp(`^${used}\\b`).test(receiver);
        });
      const risky = appends.some((item) => !literalArgs(item.field('arguments')?.text() ?? ''));
      if (!risky || appends.length === 0) {
        continue;
      }
      issues.push(
        makeIssue(
          file,
          call,
          'AST_SQL_STRING_CONCAT',
          'high',
          'CWE-89',
          `${used} 逐段 append 拼出 SQL 后直接执行，拼接进来的变量会改写语句语义（注入）`,
          '改用 PreparedStatement 占位符；确需动态片段（表名/排序）时用白名单枚举校验，不要 append 外部输入。'
        )
      );
    }
  }

  // SQL 变量中转：`String sql = "... " + name;` 再交给执行调用
  for (const method of root.findAll({ rule: { kind: 'method_declaration' } })) {
    const body = method.field('body');
    if (!body) {
      continue;
    }
    const externals = externalNames(method);
    const tainted: string[] = [];
    for (const declaration of body.findAll({ rule: { kind: 'local_variable_declaration' } })) {
      const declarator = declaration.field('declarator');
      const variable = declarator?.field('name')?.text();
      const value = declarator?.field('value')?.text() ?? '';
      if (!variable || !value) {
        continue;
      }
      const concatWithExternal =
        value.includes('+') && [...externals].some((name) => new RegExp(`\\b${name}\\b`).test(value));
      const riskyFormat = /String\.format\s*\(\s*"[^"]*"\s*,\s*[^"'\s]/.test(value);
      let riskyAppend = false;
      if (/new\s+(java\.lang\.)?(StringBuilder|StringBuffer)/.test(value)) {
        // 只有真的 append 了非字面量才算污点；全字面量的 builder 是安全写法
        riskyAppend = body
          .findAll({ rule: { kind: 'method_invocation' } })
          .filter(
            (item) =>
              item.field('name')?.text() === 'append' &&
              new RegExp(`^${variable}\\b`).test(item.field('object')?.text() ?? '')
          )
          .some(
            (item) =>
              !/^\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)$/.test(item.field('arguments')?.text() ?? '')
          );
      }
      if (concatWithExternal || riskyFormat || riskyAppend) {
        tainted.push(variable);
      }
    }
    if (tainted.length === 0) {
      continue;
    }
    for (const call of body.findAll({ rule: { kind: 'method_invocation' } })) {
      const name = call.field('name')?.text();
      if (!name || !SQL_APIS.has(name)) {
        continue;
      }
      const argsText = call.field('arguments')?.text() ?? '';
      const used = tainted.find((item) => new RegExp(`\\b${item}\\b`).test(argsText));
      if (!used) {
        continue;
      }
      if (issues.some((issue) => issue.line === lineOf(call) && issue.rule === 'AST_SQL_STRING_CONCAT')) {
        continue;
      }
      issues.push(
        makeIssue(
          file,
          call,
          'AST_SQL_STRING_CONCAT',
          'high',
          'CWE-89',
          `SQL 先由变量 ${used} 拼接/格式化后传入 ${name}()，外部输入仍可改写语句语义（注入）`,
          '直接在执行处使用 PreparedStatement 占位符；不要先拼好字符串再执行。'
        )
      );
    }
  }
  return issues;
}

/** 规则 5：@CrossOrigin 通配或未限定来源 */
function checkCrossOrigin(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  const annotations = root
    .findAll({ rule: { kind: 'annotation' } })
    .concat(root.findAll({ rule: { kind: 'marker_annotation' } }));
  for (const ann of annotations) {
    if (!/^@CrossOrigin/i.test(ann.text())) {
      continue;
    }
    const text = ann.text();
    // 裸 @CrossOrigin 的默认就是 origins="*"；只写了 maxAge 之类属性同样回到默认通配
    const bare = /^@CrossOrigin\s*$/.test(text);
    const noOriginAttribute = !/origins\s*=|\bvalue\s*=/.test(text);
    const wildcard = bare || noOriginAttribute || /\*/.test(text);
    const credentials = /allowCredentials\s*=\s*true/i.test(text);
    if (!wildcard && !credentials) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        ann,
        'AST_CROSS_ORIGIN_WILDCARD',
        credentials ? 'high' : 'medium',
        'CWE-942',
        credentials
          ? '@CrossOrigin 允许任意来源且允许携带凭证，任意站点都能带 Cookie 跨域调用该接口'
          : '@CrossOrigin 未限定来源（origins="*"），任意站点都能读取该接口的响应',
        '改成显式域名白名单（origins = "https://a.example.com"）；需要携带凭证时绝不能使用通配来源。'
      )
    );
  }
  return issues;
}

/** 规则 6：SpEL / OGNL 解析外部输入 */
function checkExpressionInjection(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    const name = call.field('name')?.text();
    const receiver = call.field('object')?.text() ?? '';
    const spel =
      name === 'parseExpression' ||
      (name === 'getValue' && /ognl|Ognl/.test(receiver));
    if (!spel) {
      continue;
    }
    const args = call.field('arguments')?.text() ?? '';
    // 只放行纯字面量表达式；变量、拼接、String.format 都视为外部可控
    const literalOnly = /^\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)$/.test(args);
    if (literalOnly) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        call,
        'AST_SPEL_INJECTION',
        'high',
        'CWE-94',
        `${name}() 的参数不是字面量，外部输入可直接执行 SpEL/OGNL 表达式`,
        '不要用外部输入构造表达式；确需动态求值就改成固定表达式 + 变量（EvaluationContext），或使用白名单模板。'
      )
    );
  }
  return issues;
}

/** 规则 7：Runtime.exec / ProcessBuilder 拼接外部输入 */
function checkCommandExec(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    const name = call.field('name')?.text();
    if (name !== 'exec') {
      continue;
    }
    const receiver = call.field('object')?.text() ?? '';
    if (!/runtime|Runtime/i.test(receiver)) {
      continue;
    }
    const args = call.field('arguments');
    if (!args) {
      continue;
    }
    const isLiteralOnly = /^\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)$/.test(args.text());
    if (isLiteralOnly) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        call,
        'AST_RUNTIME_EXEC_CONCAT',
        'high',
        'CWE-78',
        'Runtime.exec 的命令由变量或拼接构造，外部可控时可直接执行任意命令',
        '改成固定命令 + 参数数组，或用 ProcessBuilder 传参列表；不要拼接 shell 字符串，必要时严格白名单校验。'
      )
    );
  }
  for (const creation of root.findAll({ rule: { kind: 'object_creation_expression' } })) {
    const text = creation.text();
    if (!/new\s+ProcessBuilder/.test(text)) {
      continue;
    }
    if (!/"-c"|'-c'/.test(text)) {
      // 不是 shell 包装时，命令/参数里有非字面量同样是命令注入面
      const args = creation.field('arguments')?.text() ?? '';
      const allLiteral = /^\(\s*(?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')(?:\s*,\s*)?)+\)$/.test(args);
      if (args.trim() === '()' || allLiteral) {
        continue;
      }
      issues.push(
        makeIssue(
          file,
          creation,
          'AST_RUNTIME_EXEC_CONCAT',
          'high',
          'CWE-78',
          'ProcessBuilder 的命令或参数里有变量，外部可控时可改写要执行的程序或参数',
          '命令与参数全部用常量，用户只能选择白名单分支；需要传值就作为独立参数并做格式校验。'
        )
      );
      continue;
    }
    issues.push(
      makeIssue(
        file,
        creation,
        'AST_RUNTIME_EXEC_CONCAT',
        'high',
        'CWE-78',
        'ProcessBuilder 以 `-c` 走 shell 执行拼接命令，参数会被 shell 解释',
        '去掉 shell 包装，直接传命令与参数数组，并对参数做白名单校验。'
      )
    );
  }
  return issues;
}

/** 规则 8：MyBatis 注解 SQL 里使用 ${} 字符串替换 */
function checkMybatisAnnotationSql(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const ann of root.findAll({ rule: { kind: 'annotation' } })) {
    const text = ann.text();
    if (!/^@(Select|Insert|Update|Delete)\s*\(/.test(text)) {
      continue;
    }
    if (!text.includes('${')) {
      continue;
    }
    const expression = /\$\{([^}]*)\}/.exec(text)?.[1]?.trim() ?? '';
    issues.push(
      makeIssue(
        file,
        ann,
        'AST_MYBATIS_ANNOTATION_SQL',
        'high',
        'CWE-89',
        `注解 SQL 使用了 \${${expression}} 字符串替换，参数会被原样拼进 SQL`,
        '改成 `#{}` 占位符；动态字段用 Provider + 白名单校验，不要把外部值直接拼进 SQL。'
      )
    );
  }
  return issues;
}

/** 规则 9：外部输入直接作为请求地址（SSRF） */
function checkSsrf(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  const literalOnly = (text: string): boolean =>
    /^\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)$/.test(text);

  for (const creation of root.findAll({ rule: { kind: 'object_creation_expression' } })) {
    const text = creation.text();
    if (!/new\s+(java\.net\.)?URL\s*\(/.test(text)) {
      continue;
    }
    const args = creation.field('arguments')?.text() ?? '';
    if (literalOnly(args)) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        creation,
        'AST_SSRF_EXTERNAL_URL',
        'high',
        'CWE-918',
        'URL 地址不是字面量，外部输入可让服务去访问任意内网地址（SSRF）',
        '对目标域名做白名单校验并禁止内网网段；用 HttpClient 显式超时与重定向限制。'
      )
    );
  }

  const REST_NAMES = ['getForObject', 'getForEntity', 'postForObject', 'postForEntity', 'patchForObject', 'exchange'];
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    const name = call.field('name')?.text();
    if (!name || !REST_NAMES.includes(name)) {
      continue;
    }
    const receiver = call.field('object')?.text() ?? '';
    if (!/restTemplate|RestTemplate|webClient|WebClient/i.test(receiver)) {
      continue;
    }
    const args = call.field('arguments')?.text() ?? '';
    if (literalOnly(args) || args.trim() === '()') {
      continue;
    }
    // 第一个参数是 URL：字节级判断「开头是不是字面量」，字面量开头即视为固定地址
    if (/^\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*,/.test(args)) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        call,
        'AST_SSRF_EXTERNAL_URL',
        'high',
        'CWE-918',
        'HTTP 客户端的请求地址来自变量，外部输入可触发 SSRF 访问内网或云元数据',
        '目标地址用常量或白名单映射，禁止直接把用户传入的 URL 交给 RestTemplate/WebClient。'
      )
    );
  }

  // WebClient 链式写法：webClient.get().uri(var)
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    if (call.field('name')?.text() !== 'uri') {
      continue;
    }
    const receiver = call.field('object')?.text() ?? '';
    if (!/webClient|WebClient|\.get\(\)|\.post\(\)|\.retrieve|\.exchange/i.test(receiver)) {
      continue;
    }
    const args = call.field('arguments')?.text() ?? '';
    if (literalOnly(args)) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        call,
        'AST_SSRF_EXTERNAL_URL',
        'high',
        'CWE-918',
        'WebClient 的 uri() 参数不是字面量，外部输入可让请求落到任意地址（SSRF）',
        'uri 只接收常量或用 `UriComponentsBuilder` 从白名单枚举拼装，禁止直接传用户输入。'
      )
    );
  }
  return issues;
}

/** 规则 10：把外部输入直接写进响应（反射型 XSS），含 PrintWriter 变量中转 */
const XSS_WRITE_METHODS = ['write', 'print', 'println', 'append', 'printf', 'format'];
/** 已有转义/净化处理的不报，避免把正确写法当成漏洞 */
const ESCAPE_GUARD = /escapeHtml|htmlEscape|escapeXml|StringEscapeUtils|HtmlUtils|Encode\.forHtml|sanitize|OWASP|HtmlEscapers/i;

/** 方法体里由 `response.getWriter()` 赋值的局部 PrintWriter 变量 */
function writerVarsOf(method: SgNode): Set<string> {
  const vars = new Set<string>();
  const body = method.field('body');
  if (!body) {
    return vars;
  }
  for (const declaration of body.findAll({ rule: { kind: 'local_variable_declaration' } })) {
    const declarator = declaration.field('declarator');
    const name = declarator?.field('name')?.text();
    const value = declarator?.field('value')?.text() ?? '';
    if (name && /getWriter\s*\(\)/.test(value)) {
      vars.add(name);
    }
  }
  return vars;
}

function checkXssWriter(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  const cache = new Map<string, Set<string>>();
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    const name = call.field('name')?.text();
    if (!name || !XSS_WRITE_METHODS.includes(name)) {
      continue;
    }
    const receiver = call.field('object')?.text() ?? '';
    if (/getOutputStream\s*\(\)/.test(receiver)) {
      continue;
    }
    let isWriter = /getWriter\s*\(\)/.test(receiver);
    if (!isWriter) {
      const method = climb(call, ['method_declaration', 'constructor_declaration']);
      if (!method) {
        continue;
      }
      const key = `${method.range().start.line}:${method.range().start.column}`;
      let vars = cache.get(key);
      if (!vars) {
        vars = writerVarsOf(method);
        cache.set(key, vars);
      }
      isWriter = vars.has(receiver);
    }
    if (!isWriter) {
      continue;
    }
    const args = call.field('arguments')?.text() ?? '';
    if (/^\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)$/.test(args)) {
      continue;
    }
    if (ESCAPE_GUARD.test(args)) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        call,
        'AST_XSS_RESPONSE_WRITE',
        'medium',
        'CWE-79',
        '响应输出流写入了非字面量内容，外部输入未转义时可造成反射型 XSS',
        '改用模板引擎（默认转义）或先做 HTML 实体编码；设置 `Content-Type: text/html; charset=UTF-8` 不能替代转义。'
      )
    );
  }
  return issues;
}

/** 规则 11：Thymeleaf `th:utext` 与 JSP 脚本直接输出未转义内容 */
function checkThymeleafUtext(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const attrName of root.findAll({ rule: { kind: 'attribute_name' } })) {
    if (attrName.text().toLowerCase() !== 'th:utext') {
      continue;
    }
    const attribute = attrName.parent();
    const valueText = attribute?.text() ?? '';
    // th:utext 本身就是「不转义」；只关心真的渲染了动态内容的情况
    if (!/\$\{|\*\{/.test(valueText) || ESCAPE_GUARD.test(valueText)) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        attrName,
        'AST_XSS_TEMPLATE_UNESCAPED',
        'medium',
        'CWE-79',
        'Thymeleaf 使用 th:utext 渲染动态内容，模板不会做 HTML 转义，内容可控时可注入脚本',
        '改用 th:text（默认转义）；确需富文本时先用 OWASP Sanitizer 白名单净化，再交给 th:utext。'
      )
    );
  }
  return issues;
}

/** JSP 里 `<%= %>` 直接输出请求参数（占位正则版，只认明确的外部输入 API） */
function checkJspOutput(file: string, text: string): Issue[] {
  const issues: Issue[] = [];
  const masked = text.replace(/<%--[\s\S]*?--%>/g, (block) => block.replace(/[^\n]/g, ' '));
  const regex = /<%=\s*([\s\S]*?)%>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(masked)) !== null) {
    const expression = match[1].trim();
    if (!/getParameter|getHeader|getAttribute|request\./i.test(expression)) {
      continue;
    }
    if (ESCAPE_GUARD.test(expression)) {
      continue;
    }
    const line = masked.slice(0, match.index).split('\n').length;
    issues.push({
      source: 'astgrep',
      severity: 'medium',
      file,
      line,
      column: 1,
      rule: 'AST_XSS_TEMPLATE_UNESCAPED',
      message: 'JSP 脚本直接输出了请求参数或请求头，未经转义会造成反射型 XSS',
      advice: '改用 JSTL `<c:out>` 或先 `HtmlUtils.htmlEscape(...)` 再输出，不要直接写 `<%= %>`。',
      cwe: ['CWE-79']
    });
  }
  return issues;
}

/** 规则 12：上传文件名直接或经局部变量中转参与构造落盘路径（路径穿越） */
const PATH_GUARD = /FilenameUtils\.(getName|getBaseName)|Paths\.get[\s\S]*\.getFileName|getFileName\s*\(\)|UUID\.randomUUID|sanitizeFileName|normalize\s*\(/i;

/** 同方法内由 `getOriginalFilename()` 直接赋值的局部变量（且未被收敛处理覆盖） */
function taintedUploadNames(method: SgNode): string[] {
  const body = method.field('body');
  if (!body) {
    return [];
  }
  const names: string[] = [];
  for (const declaration of body.findAll({ rule: { kind: 'local_variable_declaration' } })) {
    const declarator = declaration.field('declarator');
    const name = declarator?.field('name')?.text();
    const value = declarator?.field('value')?.text() ?? '';
    if (name && /getOriginalFilename\s*\(/.test(value) && !PATH_GUARD.test(value)) {
      names.push(name);
    }
  }
  // 后续被重新赋值为收敛处理过的值（如 name = FilenameUtils.getName(name)）则移除
  for (const assignment of body.findAll({ rule: { kind: 'assignment_expression' } })) {
    if (!PATH_GUARD.test(assignment.text())) {
      continue;
    }
    const left = assignment.field('left')?.text() ?? '';
    const index = names.indexOf(left);
    if (index >= 0) {
      names.splice(index, 1);
    }
  }
  return names;
}

function checkUploadPathTraversal(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  const candidates: SgNode[] = [];
  for (const creation of root.findAll({ rule: { kind: 'object_creation_expression' } })) {
    if (/new\s+(java\.io\.)?(File|FileOutputStream|FileWriter|Paths?)\s*\(/.test(creation.text())) {
      candidates.push(creation);
    }
  }
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    const name = call.field('name')?.text();
    const receiver = call.field('object')?.text() ?? '';
    if (!name) {
      continue;
    }
    if (/^(write|writeString|copy|createFile|newOutputStream)$/.test(name) && /Files|Paths/.test(receiver)) {
      candidates.push(call);
    } else if (name === 'transferTo') {
      candidates.push(call);
    }
  }
  const seen = new Set<string>();
  for (const node of candidates) {
    const text = node.text();
    if (PATH_GUARD.test(text)) {
      continue;
    }
    let detail: string | undefined;
    if (/getOriginalFilename\s*\(/.test(text)) {
      detail = '上传文件的原始文件名（getOriginalFilename）直接用于构造落盘路径';
    } else {
      const method = climb(node, ['method_declaration', 'constructor_declaration']);
      const tainted = method ? taintedUploadNames(method) : [];
      const hit = tainted.find((item) => new RegExp(`\\b${item}\\b`).test(text));
      if (hit) {
        detail = `上传文件名经局部变量 ${hit} 中转后用于构造落盘路径`;
      }
    }
    if (!detail) {
      continue;
    }
    const key = `${node.range().start.line}:${node.range().start.column}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    issues.push(
      makeIssue(
        file,
        node,
        'AST_PATH_TRAVERSAL_UPLOAD',
        'high',
        'CWE-22',
        `${detail}，可用 \`../\` 写到任意目录甚至覆盖文件`,
        '只取文件名部分（`FilenameUtils.getName` / `Path.getFileName`）并做允许字符白名单，落盘目录用服务端固定路径 + 随机文件名。'
      )
    );
  }
  return issues;
}

/** 规则 13：Zip Slip（压缩包条目名直接拼落盘路径） */
function checkZipSlip(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const creation of root.findAll({ rule: { kind: 'object_creation_expression' } })) {
    const text = creation.text();
    if (!/new\s+(java\.io\.)?(File|FileOutputStream|FileWriter)\s*\(/.test(text)) {
      continue;
    }
    if (!/\.getName\s*\(\)/.test(text) || !/entry|zip|ze|Zip/i.test(text) || PATH_GUARD.test(text)) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        creation,
        'AST_ZIP_SLIP',
        'high',
        'CWE-22',
        '压缩包条目名直接参与构造落盘路径，可用 `../` 条目写到任意目录（Zip Slip）',
        '只取条目名并做白名单校验，落盘前用规范化后的绝对路径确认仍在目标目录内。'
      )
    );
  }
  return issues;
}

/** 规则 14：开放重定向 */
function checkOpenRedirect(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    const name = call.field('name')?.text();
    if (!name || !/^(sendRedirect|redirect)$/.test(name)) {
      continue;
    }
    const args = call.field('arguments')?.text() ?? '';
    if (/^\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)$/.test(args)) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        call,
        'AST_OPEN_REDIRECT',
        'medium',
        'CWE-601',
        '重定向目标来自变量，可被构造成任意外部地址，用于钓鱼或窃取跳转参数',
        '只允许相对路径或白名单域名，禁止直接使用请求参数作为跳转目标。'
      )
    );
  }
  return issues;
}

/** 规则 15：XML 解析器未禁用 DOCTYPE（XXE） */
function checkXxe(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    if (call.field('name')?.text() !== 'newInstance') {
      continue;
    }
    const receiver = call.field('object')?.text() ?? '';
    if (!/DocumentBuilderFactory|SAXParserFactory|XMLInputFactory|TransformerFactory/i.test(receiver)) {
      continue;
    }
    const method = climb(call, ['method_declaration', 'constructor_declaration']);
    const scope = method?.field('body')?.text() ?? '';
    if (/disallow-doctype-decl|setFeature|setProperty|SUPPORT_DTD|external-general-entities|ACCESS_EXTERNAL_DTD/i.test(scope)) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        call,
        'AST_XXE_UNHARDENED',
        'high',
        'CWE-611',
        `${receiver} 创建后没有禁用 DOCTYPE / 外部实体，可被用来读取本地文件或发起内网请求（XXE）`,
        '设置 `setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)`，并关闭外部实体与外部 DTD。'
      )
    );
  }
  return issues;
}

/** 规则 16：用非密码学随机数生成安全相关值 */
function checkInsecureRandom(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  const SENSITIVE = /token|passw|secret|salt|otp|nonce|reset|csrf|session|key/i;
  const consider = (node: SgNode, name: string): void => {
    const method = climb(node, ['method_declaration', 'constructor_declaration']);
    const declaration = climb(node, ['variable_declarator', 'assignment_expression']);
    const context = `${name} ${declaration?.text() ?? ''} ${method?.field('name')?.text() ?? ''}`;
    if (!SENSITIVE.test(context)) {
      return;
    }
    issues.push(
      makeIssue(
        file,
        node,
        'AST_INSECURE_RANDOM',
        'medium',
        'CWE-338',
        '安全场景（令牌/口令/盐）使用了可预测的随机源，输出可被枚举或重放',
        '改用 `SecureRandom`（或 `UUID.randomUUID()` 生成不可预测标识）。'
      )
    );
  };
  for (const creation of root.findAll({ rule: { kind: 'object_creation_expression' } })) {
    if (/new\s+(java\.util\.)?Random\s*\(\s*\)/.test(creation.text())) {
      consider(creation, creation.text());
    }
  }
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    if (call.field('name')?.text() === 'random' && /^(Math|StrictMath)$/.test(call.field('object')?.text() ?? '')) {
      consider(call, call.text());
    }
  }
  return issues;
}

/** 规则 17：JWT 解析未校验签名 */
function checkJwtNoVerify(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    const name = call.field('name')?.text();
    if (!name || !/^(parseClaimsJws|parseClaimsJwt|parse)$/.test(name)) {
      continue;
    }
    const receiver = call.field('object')?.text() ?? '';
    if (!/Jwts|jjwt/i.test(receiver)) {
      continue;
    }
    // 签名密钥必须出现在同一条调用链里
    if (/setSigningKey|signatureAlgorithm|verifyWith|setSigningKeyResolver/i.test(receiver)) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        call,
        'AST_JWT_NO_VERIFY',
        'high',
        'CWE-347',
        'JWT 解析链里没有设置签名密钥（或未校验算法），攻击者可伪造任意身份的 token',
        '解析前设置固定算法与签名密钥（`Jwts.parser().verifyWith(key).build()`），禁止信任 token 里的 alg。'
      )
    );
  }
  return issues;
}

/** 规则 18：用 equals 比较口令/签名（非恒定时间） */
function checkTimingCompare(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    if (call.field('name')?.text() !== 'equals') {
      continue;
    }
    const receiver = call.field('object')?.text() ?? '';
    if (!/password|passwd|pwd|token|secret|signature|hash|digest/i.test(receiver)) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        call,
        'AST_TIMING_UNSAFE_COMPARE',
        'medium',
        'CWE-208',
        '口令/签名用 equals 比较，比较耗时随前缀匹配长度变化，可被用来逐字节猜解（时序攻击）',
        '改用 `MessageDigest.isEqual(a, b)` 做恒定时间比较。'
      )
    );
  }
  return issues;
}

/** 规则 19：会话类 Cookie 未设置 HttpOnly / Secure */
function checkCookieFlags(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const creation of root.findAll({ rule: { kind: 'object_creation_expression' } })) {
    const text = creation.text();
    if (!/new\s+(javax\.servlet\.http\.)?Cookie\s*\(/.test(text)) {
      continue;
    }
    if (!/JSESSIONID|session|token|auth|jwt/i.test(text)) {
      continue;
    }
    const method = climb(creation, ['method_declaration', 'constructor_declaration']);
    const scope = method?.field('body')?.text() ?? '';
    if (/setHttpOnly\s*\(\s*true/.test(scope) && /setSecure\s*\(\s*true/.test(scope)) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        creation,
        'AST_COOKIE_FLAGS_MISSING',
        'medium',
        'CWE-1004',
        '会话类 Cookie 没有同时设置 HttpOnly 与 Secure，脚本可读取、明文链路可被截获',
        '对会话 Cookie 调用 `setHttpOnly(true)` 与 `setSecure(true)`，并设置 SameSite。'
      )
    );
  }
  return issues;
}

/** 规则 20：文件读取/下载路径来自变量（任意文件读取） */
function checkFileReadTraversal(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const creation of root.findAll({ rule: { kind: 'object_creation_expression' } })) {
    const text = creation.text();
    if (!/new\s+(java\.io\.)?(FileInputStream|FileReader)\s*\(/.test(text) || PATH_GUARD.test(text)) {
      continue;
    }
    const args = creation.field('arguments')?.text() ?? '';
    if (/^\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)$/.test(args)) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        creation,
        'AST_ARBITRARY_FILE_READ',
        'high',
        'CWE-22',
        '文件读取路径来自变量且未做收敛，可被构造成 `../../etc/passwd` 读取任意文件',
        '路径用服务端固定目录 + 白名单文件名，读取前校验规范化后的路径仍在允许目录内。'
      )
    );
  }
  return issues;
}

/** 规则 21：模板引擎以外部输入作模板（SSTI） */
function checkSsti(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    const name = call.field('name')?.text();
    const receiver = call.field('object')?.text() ?? '';
    if (name !== 'process' || !/templateEngine|TemplateEngine|engine/i.test(receiver)) {
      continue;
    }
    const args = call.field('arguments')?.text() ?? '';
    if (/^\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*,/.test(args)) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        call,
        'AST_TEMPLATE_INJECTION',
        'high',
        'CWE-94',
        '模板名/模板内容来自变量，攻击者可注入模板语法执行任意代码（SSTI）',
        '模板名只能用常量或白名单枚举，禁止把用户输入交给模板引擎解析。'
      )
    );
  }
  return issues;
}

/** 规则 22：LDAP 查询由字符串拼接构造 */
function checkLdapInjection(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    if (call.field('name')?.text() !== 'search') {
      continue;
    }
    const receiver = call.field('object')?.text() ?? '';
    const method = climb(call, ['method_declaration', 'constructor_declaration']);
    const paramTypes = method?.field('parameters')?.text() ?? '';
    if (!/DirContext|LdapContext|ldapTemplate|LdapTemplate/i.test(receiver) && !/DirContext|LdapContext|LdapTemplate/i.test(paramTypes)) {
      continue;
    }
    const args = call.field('arguments');
    if (!args) {
      continue;
    }
    const concat = args
      .findAll({ rule: { kind: 'binary_expression' } })
      .some((bin) => bin.text().includes('+') && bin.findAll({ rule: { kind: 'identifier' } }).length > 0);
    if (!concat) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        call,
        'AST_LDAP_INJECTION',
        'high',
        'CWE-90',
        'LDAP 查询过滤器由字符串拼接构造，可注入 `)(uid=*` 绕过认证或枚举条目',
        '用占位符/转义 API（`*`、`(`、`)` 等元字符全部转义），不要拼接外部输入。'
      )
    );
  }
  return issues;
}

/** 规则 23：JDBC 连接地址由拼接构造 */
function checkJdbcUrlConcat(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    if (call.field('name')?.text() !== 'getConnection') {
      continue;
    }
    if (!/DriverManager|DataSource/i.test(call.field('object')?.text() ?? '')) {
      continue;
    }
    const args = call.field('arguments')?.text() ?? '';
    if (!/[A-Za-z_$][\w$]*\s*\+|\+\s*[A-Za-z_$][\w$]*|\+\s*[A-Za-z_$][\w$]*\s*\(/.test(args)) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        call,
        'AST_JDBC_URL_INJECTION',
        'medium',
        'CWE-74',
        'JDBC 连接地址由字符串拼接构造，外部输入可改写目标库或追加危险参数',
        '连接地址与参数全部来自配置常量，不要拼接请求参数。'
      )
    );
  }
  return issues;
}

/** 规则 24：日志参数直接来自请求且未过滤换行（日志注入） */
function checkLogInjection(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    const name = call.field('name')?.text();
    if (!name || !LOG_METHODS.includes(name)) {
      continue;
    }
    if (!LOG_RECEIVERS.test(call.field('object')?.text() ?? '')) {
      continue;
    }
    const args = call.field('arguments')?.text() ?? '';
    if (!/getParameter\s*\(|getHeader\s*\(|getQueryString/.test(args)) {
      continue;
    }
    if (/replace\s*\(\s*"\\r|replaceAll\s*\(\s*"[\\r\\n]/i.test(args)) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        call,
        'AST_LOG_INJECTION',
        'low',
        'CWE-117',
        '日志直接拼接请求参数且未过滤换行，可伪造日志行掩盖攻击痕迹',
        '输出前把 CR/LF 与控制字符替换掉，或只记录白名单字段。'
      )
    );
  }
  return issues;
}

/** 规则 25：System.out 输出敏感字段 */
function checkSystemOutSensitive(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    const name = call.field('name')?.text();
    if (!name || !/^(println|print|printf)$/.test(name)) {
      continue;
    }
    if (!/^System\.(out|err)$/.test(call.field('object')?.text() ?? '')) {
      continue;
    }
    const args = call.field('arguments')?.text() ?? '';
    if (!SENSITIVE_FIELDS.test(args)) {
      continue;
    }
    issues.push(
      makeIssue(
        file,
        call,
        'AST_CONSOLE_SENSITIVE_OUTPUT',
        'low',
        'CWE-532',
        '标准输出/错误流打印了敏感字段，容器与 CI 日志会长期留存',
        '改用日志框架并脱敏，或直接删除调试输出。'
      )
    );
  }
  return issues;
}

/** 规则 26：不安全反序列化入口 */
function checkUnsafeDeserialization(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const creation of root.findAll({ rule: { kind: 'object_creation_expression' } })) {
    if (/new\s+(java\.io\.)?ObjectInputStream\s*\(/.test(creation.text())) {
      issues.push(
        makeIssue(
          file,
          creation,
          'AST_UNSAFE_DESERIALIZATION',
          'high',
          'CWE-502',
          'ObjectInputStream 反序列化不可信数据，可被构造 gadget 链执行任意代码',
          '改用 JSON 等数据格式并做类型白名单；确需 Java 序列化时启用 `ObjectInputFilter`。'
        )
      );
    }
    if (/new\s+com\.thoughtworks\.xstream\.XStream\s*\(/i.test(creation.text())) {
      issues.push(
        makeIssue(
          file,
          creation,
          'AST_UNSAFE_DESERIALIZATION',
          'high',
          'CWE-502',
          'XStream 默认允许任意类型反序列化，可被构造 gadget 链执行任意代码',
          '配置 `allowTypes`/`allowTypesByWildcard` 白名单并开启安全框架，不要直接解析外部 XML。'
        )
      );
    }
  }
  for (const call of root.findAll({ rule: { kind: 'method_invocation' } })) {
    const name = call.field('name')?.text();
    if ((name === 'enableDefaultTyping' || name === 'activateDefaultTyping') && /mapper|objectMapper/i.test(call.field('object')?.text() ?? '')) {
      issues.push(
        makeIssue(
          file,
          call,
          'AST_UNSAFE_DESERIALIZATION',
          'high',
          'CWE-502',
          'Jackson 开启了默认类型信息（default typing），反序列化外部 JSON 可触发任意类型实例化',
          '不要开启 default typing；确需多态就使用 `@JsonTypeInfo` + 显式子类白名单。'
        )
      );
    }
  }
  return issues;
}

/** 规则 27：上传只校验大小/类型，完全没有扩展名校验 */
function checkUploadExtension(file: string, root: SgNode): Issue[] {
  const issues: Issue[] = [];
  for (const param of root.findAll({ rule: { kind: 'formal_parameter' } })) {
    if (!/MultipartFile/.test(param.text())) {
      continue;
    }
    const method = climb(param, ['method_declaration', 'constructor_declaration']);
    const body = method?.field('body')?.text() ?? '';
    if (/getExtension|FilenameUtils|endsWith\s*\(\s*"\.|allowedExtensions|ALLOWED_EXT/i.test(body)) {
      continue;
    }
    if (!UPLOAD_GUARD.test(body)) {
      // 连大小/类型校验都没有的，交给 AST_UPLOAD_WITHOUT_VALIDATION
      continue;
    }
    issues.push(
      makeIssue(
        file,
        param,
        'AST_UPLOAD_EXTENSION_UNCHECKED',
        'medium',
        'CWE-434',
        '上传方法只做了大小/类型校验，没有校验文件扩展名，可上传可执行脚本',
        '增加扩展名白名单（如 jpg/png/pdf），并按扩展名决定落盘目录与 Content-Type。'
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
    issues.push(...checkSqlConcat(file, treeRoot));
    issues.push(...checkCrossOrigin(file, treeRoot));
    issues.push(...checkExpressionInjection(file, treeRoot));
    issues.push(...checkCommandExec(file, treeRoot));
    issues.push(...checkMybatisAnnotationSql(file, treeRoot));
    issues.push(...checkSsrf(file, treeRoot));
    issues.push(...checkXssWriter(file, treeRoot));
    issues.push(...checkUploadPathTraversal(file, treeRoot));
    issues.push(...checkZipSlip(file, treeRoot));
    issues.push(...checkOpenRedirect(file, treeRoot));
    issues.push(...checkXxe(file, treeRoot));
    issues.push(...checkInsecureRandom(file, treeRoot));
    issues.push(...checkJwtNoVerify(file, treeRoot));
    issues.push(...checkTimingCompare(file, treeRoot));
    issues.push(...checkCookieFlags(file, treeRoot));
    issues.push(...checkFileReadTraversal(file, treeRoot));
    issues.push(...checkSsti(file, treeRoot));
    issues.push(...checkLdapInjection(file, treeRoot));
    issues.push(...checkJdbcUrlConcat(file, treeRoot));
    issues.push(...checkLogInjection(file, treeRoot));
    issues.push(...checkSystemOutSensitive(file, treeRoot));
    issues.push(...checkUnsafeDeserialization(file, treeRoot));
    issues.push(...checkUploadExtension(file, treeRoot));
  }

  // 模板层：Thymeleaf 的 th:utext 与 JSP 脚本输出，同样属于「源码可控 + 不转义」
  let templateParsed = 0;
  for (const file of collectTemplateFiles(root)) {
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
    if (/\.jsp$/i.test(file)) {
      issues.push(...checkJspOutput(file, text));
      templateParsed += 1;
      continue;
    }
    try {
      const tree = ast.parse('Html', text);
      issues.push(...checkThymeleafUtext(file, tree.root()));
      templateParsed += 1;
    } catch {
      continue;
    }
  }

  return { issues, files: parsed + templateParsed };
}
