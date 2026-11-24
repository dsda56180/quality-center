/**
 * 配置层与框架语义扫描（qcsec）。
 *
 * 前面四个扫描器都不看 `application.yml`：Checkstyle 管源码风格，Gitleaks 找密钥形态的字符串，
 * Trivy 只按依赖坐标查 CVE，SpotBugs 看字节码。而 Druid 默认口令、`allowMultiQueries`、
 * Actuator 全暴露这类问题全在配置文件里，且往往是「多个键组合才构成风险」，
 * 单行有漏洞库也查不到——所以这里自己做一层：把 yml / properties 拍平成
 * 「键路径 + 值 + 行号」，再用规则匹配路径与组合条件。
 *
 * 纯 Node 实现，无外部二进制；yml 用缩进栈解析键路径，足够覆盖 Spring Boot 的写法。
 */
import * as fs from 'fs';
import * as path from 'path';
import { Issue, Severity } from '../model';

export interface QcsecResult {
  issues: Issue[];
  error?: string;
  /** 实际解析的配置文件数，便于在面板/CLI 说明覆盖范围 */
  files: number;
}

interface Entry {
  key: string;
  value: string;
  line: number;
}

interface IssueDraft {
  line: number;
  severity: Severity;
  message: string;
  advice: string;
}

interface RuleDef {
  id: string;
  cwe: string;
  match: (index: Index) => IssueDraft[];
}

const WEAK_PASSWORDS = new Set(['123456', 'admin', 'druid', 'password', '12345678', 'root', '000000', 'druid123']);

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'out', 'dist', '.idea', '.gradle', 'fixtures']);

const stripQuotes = (text: string): string => {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  // 去掉未加引号的行尾注释
  const comment = trimmed.indexOf(' #');
  return comment >= 0 ? trimmed.slice(0, comment).trim() : trimmed;
};

/** yml：按缩进栈还原键路径，列表元素记作 `key[]` */
function flattenYaml(text: string): Entry[] {
  const entries: Entry[] = [];
  const stack: { indent: number; key: string }[] = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---') || trimmed === '-') {
      return;
    }
    const indent = raw.length - raw.trimStart().length;

    const listItem = /^-+\s*(.*)$/.exec(trimmed);
    if (listItem) {
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      const key = [...stack.map((item) => item.key), '[]'].join('.');
      entries.push({ key, value: stripQuotes(listItem[1]), line: lineNo });
      return;
    }

    const pair = /^([^:#][^:]*?):\s*(.*)$/.exec(trimmed);
    if (!pair) {
      return;
    }
    const name = pair[1].trim();
    const value = stripQuotes(pair[2]);
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const full = [...stack.map((item) => item.key), name].join('.');
    if (value === '') {
      stack.push({ indent, key: name });
    } else {
      entries.push({ key: full, value, line: lineNo });
    }
  });

  return entries;
}

/** properties：键就是完整路径，按首个 `=` 或 `:` 切分 */
function flattenProperties(text: string): Entry[] {
  const entries: Entry[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) {
      return;
    }
    const sep = trimmed.indexOf('=') >= 0 ? trimmed.indexOf('=') : trimmed.indexOf(':');
    if (sep <= 0) {
      return;
    }
    entries.push({
      key: trimmed.slice(0, sep).trim(),
      value: trimmed.slice(sep + 1).trim(),
      line: index + 1
    });
  });
  return entries;
}

/** 单文件内的键索引，规则只需要「按后缀找键」和「读全部键」 */
class Index {
  constructor(readonly entries: Entry[]) {}

  all(): Entry[] {
    return this.entries;
  }

  /** 按键路径结尾匹配，`/login-password$/` 可跨不同前缀的命名习惯 */
  byKeySuffix(pattern: RegExp): Entry[] {
    return this.entries.filter((entry) => pattern.test(entry.key));
  }

  /** 列表元素（例如 `include[]`）也参与匹配 */
  values(pattern: RegExp): Entry[] {
    return this.entries.filter((entry) => pattern.test(entry.key));
  }

  hasTrue(pattern: RegExp): boolean {
    return this.values(pattern).some((entry) => entry.value.toLowerCase() === 'true');
  }
}

const ACTUATOR_SENSITIVE = ['env', 'heapdump', 'threaddump', 'jolokia', 'shutdown', 'configprops', 'restart'];

const RULES: RuleDef[] = [
  {
    id: 'SEC_JDBC_ALLOW_MULTI_QUERIES',
    cwe: 'CWE-89',
    match: (index) =>
      index
        .all()
        .filter((entry) => /url$/i.test(entry.key) && /allowMultiQueries\s*=\s*true/i.test(entry.value))
        .map((entry) => ({
          line: entry.line,
          severity: 'high' as Severity,
          message: 'JDBC 连接串开启了 allowMultiQueries=true，SQL 注入可从「读数据」升级为「堆叠执行任意语句」',
          advice: '移除 allowMultiQueries；确需批量执行时改用批处理接口，并保证所有 SQL 都是参数化的。'
        }))
  },
  {
    id: 'SEC_DRUID_STATVIEW_DEFAULT_PASSWORD',
    cwe: 'CWE-1392',
    match: (index) => {
      const drafts: IssueDraft[] = [];
      const password = index.byKeySuffix(/stat-view-servlet\.login-password$/)[0];
      const enabled = index.byKeySuffix(/stat-view-servlet\.enabled$/)[0];
      const username = index.byKeySuffix(/stat-view-servlet\.login-username$/)[0];

      if (password && WEAK_PASSWORDS.has(password.value.toLowerCase())) {
        drafts.push({
          line: password.line,
          severity: 'high',
          message: `Druid 监控面板使用默认/弱口令「${password.value}」，面板一旦可访问即可直接进入并查看 SQL 与数据源信息`,
          advice: '改成强口令并外部化（`login-password: ${DRUID_PASSWORD}` 配合环境变量或配置中心），同时开启面板访问控制。'
        });
      } else if (!password && enabled && /true/i.test(enabled.value)) {
        drafts.push({
          line: enabled.line,
          severity: 'high',
          message: 'Druid 监控面板已开启但未配置 login-password，将回落到内置默认口令 admin/123456',
          advice: '显式配置 login-username / login-password（从环境变量注入），或关闭 stat-view-servlet。'
        });
      }
      if (username && username.value === 'admin' && !drafts.some((draft) => draft.line === username.line)) {
        drafts.push({
          line: username.line,
          severity: 'medium',
          message: 'Druid 面板用户名仍为默认 admin，配合弱口令时风险显著放大',
          advice: '改用非默认用户名，并把账号口令一并外部化。'
        });
      }
      return drafts;
    }
  },
  {
    id: 'SEC_DRUID_STATVIEW_PUBLIC_BIND',
    cwe: 'CWE-668',
    match: (index) =>
      index
        .byKeySuffix(/stat-view-servlet\.allow$/)
        .filter((entry) => /0\.0\.0\.0|\*/.test(entry.value))
        .map((entry) => ({
          line: entry.line,
          severity: 'high' as Severity,
          message: `Druid 面板允许来源被设为「${entry.value}」，等于对全网开放监控面板`,
          advice: '改成 127.0.0.1 或内网网段白名单；需要远程访问时走跳板机/VPN，不要直接暴露。'
        }))
  },
  {
    id: 'SEC_ACTUATOR_EXPOSE_ALL',
    cwe: 'CWE-497',
    match: (index) => {
      const drafts: IssueDraft[] = [];
      const include = index.byKeySuffix(/management\.endpoints\.web\.exposure\.include/);
      for (const entry of include) {
        const exposed = entry.value
          .split(',')
          .map((item) => item.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
        const hit = entry.value.trim() === '*' || exposed.some((item) => ACTUATOR_SENSITIVE.includes(item));
        if (hit) {
          drafts.push({
            line: entry.line,
            severity: 'high',
            message: `Actuator 端点暴露范围包含「${entry.value}」，env / heapdump 之类端点会直接泄露配置、环境变量甚至内存快照`,
            advice: '只暴露 health、info 等必要端点；管理端点加认证并绑定内网，生产环境禁止 heapdump/env。'
          });
        }
      }
      for (const name of ACTUATOR_SENSITIVE) {
        const enabled = index.byKeySuffix(new RegExp(`management\\.endpoint\\.${name}\\.enabled$`));
        for (const entry of enabled.filter((item) => item.value.toLowerCase() === 'true')) {
          drafts.push({
            line: entry.line,
            severity: 'high',
            message: `Actuator 的 ${name} 端点被显式开启，属于高敏感管理端点`,
            advice: '生产环境保持关闭；确需排障时临时开启并限制来源与访问凭证。'
          });
        }
      }
      return drafts;
    }
  },
  {
    id: 'SEC_CORS_WILDCARD_WITH_CREDENTIALS',
    cwe: 'CWE-942',
    match: (index) => {
      const origins = index.byKeySuffix(/cors[\w.-]*allowed-?origins?$/);
      const wildcard = origins.filter((entry) => entry.value.trim() === '*' || entry.value.includes('*'));
      if (wildcard.length === 0 || !index.hasTrue(/cors[\w.-]*allow-?credentials$/)) {
        return [];
      }
      return wildcard.map((entry) => ({
        line: entry.line,
        severity: 'high' as Severity,
        message: 'CORS 允许任意源并且允许携带凭证，任意站点都能带着用户 Cookie 发起跨域请求',
        advice: '把允许源改成显式白名单；确实需要通配时关闭 allow-credentials，并只放行必要的请求头与方法。'
      }));
    }
  },
  {
    id: 'SEC_CORS_WILDCARD',
    cwe: 'CWE-942',
    match: (index) => {
      const origins = index.byKeySuffix(/cors[\w.-]*allowed-?origins?$/);
      if (index.hasTrue(/cors[\w.-]*allow-?credentials$/)) {
        return [];
      }
      return origins
        .filter((entry) => entry.value.trim() === '*')
        .map((entry) => ({
          line: entry.line,
          severity: 'medium' as Severity,
          message: 'CORS 允许任意源，任何站点都能读取该服务的响应内容',
          advice: '改为显式域名白名单；如确属公开 API，确认接口不返回用户私有数据。'
        }));
    }
  },
  {
    id: 'SEC_PLAINTEXT_PASSWORD_PROPERTY',
    cwe: 'CWE-798',
    match: (index) =>
      index
        .all()
        .filter((entry) => /(^|\.)password$/.test(entry.key))
        .filter((entry) => !/stat-view-servlet/.test(entry.key))
        .filter((entry) => {
          const value = entry.value.trim();
          return value !== '' && !value.startsWith('${') && !value.startsWith('#{') && !/^\*+$/.test(value);
        })
        .map((entry) => ({
          line: entry.line,
          severity: 'high' as Severity,
          message: '配置文件里直接写了明文口令，随代码仓库一起分发后等同于口令泄露',
          advice: '改成 `${ENV_NAME}` 占位并从环境变量/配置中心/密钥管理服务注入。'
        }))
  },
  {
    id: 'SEC_DEVTOOLS_ENABLED',
    cwe: 'CWE-489',
    match: (index) => {
      const keys = index.byKeySuffix(/spring\.devtools\.(restart\.enabled|add-properties|remote\.restart\.enabled)$/);
      return keys
        .filter((entry) => entry.value.toLowerCase() === 'true')
        .map((entry) => ({
          line: entry.line,
          severity: 'medium' as Severity,
          message: 'spring.devtools 在生产配置里是开启的，可能带来远程重启与环境属性注入',
          advice: '把 devtools 依赖设为 developmentOnly 或 provided，并在生产 profile 中关闭 restart/remote.restart。'
        }));
    }
  },
  {
    id: 'SEC_SSL_DISABLED',
    cwe: 'CWE-319',
    match: (index) =>
      index
        .byKeySuffix(/server\.ssl\.enabled$/)
        .filter((entry) => entry.value.toLowerCase() === 'false')
        .map((entry) => ({
          line: entry.line,
          severity: 'medium' as Severity,
          message: '显式关闭了 server.ssl.enabled，服务将以明文 HTTP 暴露',
          advice: '在网关或应用层启用 TLS；确属内网调试，请限定在 dev profile 并确保不外发。'
        }))
  }
];

function collectConfigFiles(root: string): string[] {
  const files: string[] = [];
  const pattern = /^(application|bootstrap)[\w.-]*\.(ya?ml|properties)$/i;

  const walk = (dir: string, depth: number): void => {
    if (depth > 6) {
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
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name), depth + 1);
        }
        continue;
      }
      if (pattern.test(entry.name)) {
        files.push(path.join(dir, entry.name));
      }
    }
  };

  walk(root, 0);
  return files.sort();
}

export async function scanQcsec(root: string): Promise<QcsecResult> {
  const files = collectConfigFiles(root);
  const issues: Issue[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const entries = file.toLowerCase().endsWith('.properties')
      ? flattenProperties(text)
      : flattenYaml(text);
    if (entries.length === 0) {
      continue;
    }
    const index = new Index(entries);
    for (const rule of RULES) {
      let drafts: IssueDraft[];
      try {
        drafts = rule.match(index);
      } catch {
        continue;
      }
      for (const draft of drafts) {
        issues.push({
          source: 'qcsec',
          severity: draft.severity,
          file,
          line: draft.line,
          column: 1,
          rule: rule.id,
          message: draft.message,
          advice: draft.advice,
          cwe: [rule.cwe]
        });
      }
    }
  }

  return { issues, files: files.length };
}

/** 供文档/CLI 展示的规则清单 */
export const QCSEC_RULES = RULES.map((rule) => ({ id: rule.id, cwe: rule.cwe }));
