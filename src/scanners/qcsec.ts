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
      // `key:` 后面既可能是嵌套映射，也可能是「值为空」的叶子（例如 `allow:`）。
      // 只有下一行缩进更深才算嵌套，否则按空值叶子记录——否则「allow 留空 = 放开全部来源」这类写法永远查不到。
      let nested = false;
      for (let next = index + 1; next < lines.length; next++) {
        const rawNext = lines[next];
        const trimmedNext = rawNext.trim();
        if (!trimmedNext || trimmedNext.startsWith('#') || trimmedNext === '---') {
          continue;
        }
        nested = rawNext.length - rawNext.trimStart().length > indent;
        break;
      }
      if (nested) {
        stack.push({ indent, key: name });
      } else {
        entries.push({ key: full, value: '', line: lineNo });
      }
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

const ACTUATOR_SENSITIVE = ['env', 'heapdump', 'threaddump', 'jolokia', 'shutdown', 'configprops', 'restart', 'gateway'];

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
    id: 'SEC_DRUID_STATVIEW_NO_USERNAME',
    cwe: 'CWE-1392',
    match: (index) => {
      const enabled = index.byKeySuffix(/stat-view-servlet\.enabled$/)[0];
      const username = index.byKeySuffix(/stat-view-servlet\.login-username$/)[0];
      if (!enabled || enabled.value.toLowerCase() !== 'true' || username) {
        return [];
      }
      return [
        {
          line: enabled.line,
          severity: 'medium' as Severity,
          message: 'Druid 面板已开启但未配置 login-username，账号会回落到内置默认的 admin',
          advice: '显式配置 `login-username`（从环境变量注入）并配合强口令；面板只用内网访问。'
        }
      ];
    }
  },
  {
    id: 'SEC_DRUID_STATVIEW_RESET_ENABLED',
    cwe: 'CWE-770',
    match: (index) =>
      index
        .byKeySuffix(/stat-view-servlet\.reset-enable$/)
        .filter((entry) => entry.value.toLowerCase() === 'true')
        .map((entry) => ({
          line: entry.line,
          severity: 'medium' as Severity,
          message: 'Druid 面板开启了 reset-enable，可被用来重置统计数据/清空监控数据，干扰排障与审计',
          advice: '生产环境设置 `reset-enable: false`；确需重置时由运维在受控入口操作。'
        }))
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
        // gateway 端点有独立规则（SEC_ACTUATOR_GATEWAY_EXPOSED），这里不重复报
        if (name === 'gateway') {
          continue;
        }
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
        // Spring Security 内置账号有专门的规则（含 username 组合判断），避免同一行报两次
        .filter((entry) => !/^spring\.security\.user\./.test(entry.key))
        .filter((entry) => {
          const value = entry.value.trim();
          return (
            value !== '' &&
            !value.startsWith('${') &&
            !value.startsWith('#{') &&
            // 常见加密/密钥托管写法，本身就是「已外部化」的等价形态
            !/^ENC\(/.test(value) &&
            !/^\{cipher\}/.test(value) &&
            !/^(sm|vault|sops|aws|kms):/i.test(value) &&
            !/^\*+$/.test(value)
          );
        })
        .map((entry) => ({
          line: entry.line,
          severity: 'high' as Severity,
          message: '配置文件里直接写了明文口令，随代码仓库一起分发后等同于口令泄露',
          advice: '改成 `${ENV_NAME}` 占位并从环境变量/配置中心/密钥管理服务注入。'
        }))
  },
  {
    id: 'SEC_SWAGGER_PUBLIC',
    cwe: 'CWE-200',
    match: (index) => {
      const drafts: IssueDraft[] = [];
      const toggles = [
        ...index.byKeySuffix(/springdoc\.(api-docs|swagger-ui)\.enabled$/),
        ...index.byKeySuffix(/springfox\.documentation\.enabled$/),
        ...index.byKeySuffix(/knife4j\.enable$/)
      ];
      const knife4jProd = index.byKeySuffix(/knife4j\.production$/)[0];
      for (const entry of toggles) {
        if (entry.value.toLowerCase() !== 'true') {
          continue;
        }
        if (/knife4j\.enable$/.test(entry.key) && knife4jProd && knife4jProd.value.toLowerCase() === 'true') {
          // knife4j.production=true 就是「生产环境关闭」，属于正确写法
          continue;
        }
        drafts.push({
          line: entry.line,
          severity: 'medium',
          message: '接口文档（Swagger / Knife4j）被显式开启且没有生产开关保护，接口清单与在线调试入口会对外公开',
          advice: '生产 profile 关闭文档（`springdoc.api-docs.enabled=false` / `knife4j.production=true`），保留时至少加认证与内网限制。'
        });
      }
      return drafts;
    }
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
  },
  {
    id: 'SEC_REDIS_NO_PASSWORD',
    cwe: 'CWE-306',
    match: (index) => {
      const drafts: IssueDraft[] = [];
      const passwords = index.byKeySuffix(/redis\.password$/);
      for (const entry of passwords) {
        if (entry.value.trim() === '') {
          drafts.push({
            line: entry.line,
            severity: 'medium',
            message: 'Redis 未配置口令（password 为空），能连上端口的客户端可直接读写全部数据',
            advice: '设置强口令并外部化（`spring.data.redis.password: ${REDIS_PASSWORD}` 或 `spring.redis.password`），同时只监听内网并开启 ACL。'
          });
        }
      }
      if (passwords.length === 0) {
        const host = index.byKeySuffix(/redis\.host$/)[0];
        if (host && !/localhost|127\.0\.0\.1|::1/i.test(host.value)) {
          drafts.push({
            line: host.line,
            severity: 'medium',
            message: `Redis 指向了非本机地址（${host.value}）但完全没有配置 password，未鉴权的 Redis 是常见横向移动入口`,
            advice: '为 Redis 设置 requirepass/ACL 并外部化口令；生产实例不要暴露在可被任意主机访问的网络段。'
          });
        }
      }
      return drafts;
    }
  },
  {
    id: 'SEC_DEFAULT_CREDENTIAL_USERNAME',
    cwe: 'CWE-1392',
    match: (index) => {
      const defaults = new Set(['nacos', 'guest']);
      return index
        .all()
        .filter((entry) => /(^|\.)(username|user)$/i.test(entry.key))
        .filter((entry) => !/stat-view-servlet/.test(entry.key))
        .filter((entry) => defaults.has(entry.value.trim().toLowerCase()))
        .map((entry) => ({
          line: entry.line,
          severity: 'medium' as Severity,
          message: `中间件仍在用默认账号「${entry.value.trim()}」`,
          advice: '改成业务专用账号并外部化账号口令；Nacos 需同时开启 `nacos.core.auth.enabled=true`，RabbitMQ 不要用 guest 远程登录。'
        }));
    }
  },
  {
    id: 'SEC_NACOS_AUTH_DISABLED',
    cwe: 'CWE-306',
    match: (index) =>
      index
        .byKeySuffix(/nacos\.core\.auth\.enabled$/)
        .filter((entry) => entry.value.toLowerCase() === 'false')
        .map((entry) => ({
          line: entry.line,
          severity: 'high' as Severity,
          message: 'Nacos 显式关闭了鉴权（nacos.core.auth.enabled=false），任何能访问 8848 的客户端都能改配置、注册服务',
          advice: '开启 `nacos.core.auth.enabled=true` 并配置 token/身份密钥；对外只暴露必要端口，管理面走内网。'
        }))
  },
  {
    id: 'SEC_MQ_SASL_PLAINTEXT',
    cwe: 'CWE-798',
    match: (index) =>
      index
        .byKeySuffix(/sasl\.jaas\.config$/)
        .filter((entry) => {
          const match = /password\s*=\s*(['"])([^'"]*)\1/i.exec(entry.value);
          if (!match) {
            return false;
          }
          const secret = match[2];
          return !/\$\{|^ENC\(|^(sm|vault|sops|aws|kms):/i.test(secret);
        })
        .map((entry) => ({
          line: entry.line,
          severity: 'high' as Severity,
          message: 'Kafka SASL JAAS 配置里直接写了明文口令，随配置下发即等同于账号泄露',
          advice: '把 JAAS 口令改成 `${KAFKA_SASL_PASSWORD}` 等占位，或使用 Kerberos/SCRAM 凭证文件并从环境变量注入。'
        }))
  },
  {
    id: 'SEC_NACOS_TOKEN_SECRET_KEY',
    cwe: 'CWE-1392',
    match: (index) =>
      index
        .byKeySuffix(/token\.secret\.key$/)
        .filter((entry) => {
          const value = entry.value.trim().replace(/^["']|["']$/g, '');
          if (value === '' || /^SecretKey0123456789/.test(value)) {
            // 空值与 Nacos 官方文档里的示例密钥都属于「没换过」
            return true;
          }
          if (/^\$\{|^ENC\(|^(sm|vault|sops|aws|kms):/i.test(value)) {
            return false;
          }
          return /^(nacos|secret|changeme|default)$/i.test(value);
        })
        .map((entry) => ({
          line: entry.line,
          severity: 'high' as Severity,
          message: 'Nacos 的 token secret key 仍是空值或示例/弱密钥，攻击者可自行签发合法 token 冒充任意用户',
          advice: '生成随机密钥（`openssl rand -base64 48`）后外部化注入，例如 `nacos.core.auth.plugin.nacos.token.secret.key: ${NACOS_TOKEN_SECRET}`，并同步到所有节点。'
        }))
  },
  {
    id: 'SEC_DATASOURCE_DISABLED_SSL',
    cwe: 'CWE-319',
    match: (index) =>
      index
        .all()
        .filter((entry) => /(^|\.)url$/i.test(entry.key) && /jdbc:/i.test(entry.value))
        .filter((entry) => /useSSL\s*=\s*false|sslMode\s*=\s*DISABLED|sslmode\s*=\s*disable/i.test(entry.value))
        .map((entry) => ({
          line: entry.line,
          severity: 'medium' as Severity,
          message: 'JDBC 连接串显式关闭了 TLS（useSSL=false / sslMode=DISABLED），数据库账号与业务数据在链路上明文传输',
          advice: '打开 `useSSL=true&requireSSL=true`（或 `sslMode=VERIFY_CA`），并在数据库侧配置证书；内网也建议启用。'
        }))
  },
  {
    id: 'SEC_MANAGEMENT_PORT_SHARED',
    cwe: 'CWE-668',
    match: (index) => {
      const exposure = index.byKeySuffix(/management\.endpoints\.web\.exposure\.include$/);
      const fullyOpen = exposure.some((entry) => entry.value.trim() === '*');
      if (!fullyOpen || index.byKeySuffix(/management\.server\.port$/).length > 0) {
        return [];
      }
      return exposure.map((entry) => ({
        line: entry.line,
        severity: 'medium' as Severity,
        message: 'Actuator 全端点暴露且与应用共用同一端口，管理面没有做端口隔离，业务入口被攻破即等于管理面暴露',
        advice: '设置 `management.server.port`（或独立管理网卡）把管理端点隔离，并在网关层只对内网放行该端口。'
      }));
    }
  },
  {
    id: 'SEC_ACTUATOR_GATEWAY_EXPOSED',
    cwe: 'CWE-497',
    match: (index) =>
      index
        .byKeySuffix(/management\.endpoint\.gateway\.enabled$/)
        .filter((entry) => entry.value.toLowerCase() === 'true')
        .map((entry) => ({
          line: entry.line,
          severity: 'medium' as Severity,
          message: 'Spring Cloud Gateway 的 actuator 端点被显式开启，`/actuator/gateway/routes` 会泄露全部路由，POST refresh 还能触发路由刷新',
          advice: '生产环境关闭 `management.endpoint.gateway.enabled`；确需排障时限制到内网并加认证。'
        }))
  },
  {
    id: 'SEC_DRUID_FILTERS_CONFIG',
    cwe: 'CWE-200',
    match: (index) => {
      const drafts: IssueDraft[] = [];
      for (const entry of index.byKeySuffix(/druid[\w.-]*\.filters$/)) {
        const filters = entry.value
          .split(',')
          .map((item) => item.trim().toLowerCase().replace(/^["']|["']$/g, ''));
        if (!filters.includes('config')) {
          continue;
        }
        drafts.push({
          line: entry.line,
          severity: 'medium',
          message: 'Druid 的 filters 里注册了 config 过滤器，`/druid/*/config*` 这类页面会展示 JDBC 连接串、会话与 Web 资源等运行期配置',
          advice: '生产环境从 filters 中移除 config（只保留 stat/wall 等必要项），确需查看时通过受控入口临时开启。'
        });
      }
      return drafts;
    }
  },
  {
    id: 'SEC_DRUID_STATVIEW_ALLOW_EMPTY',
    cwe: 'CWE-668',
    match: (index) =>
      index
        .byKeySuffix(/stat-view-servlet\.allow$/)
        .filter((entry) => entry.value.trim() === '' || /^["']{2}$/.test(entry.value.trim()))
        .map((entry) => ({
          line: entry.line,
          severity: 'high' as Severity,
          message: 'Druid 面板的 allow 被留空，等于不限制来源 IP，任何能访问该端口的客户端都能打开监控面板',
          advice: '显式配置内网白名单（如 `allow: 127.0.0.1,10.0.0.0/8`）；需要远程访问时走跳板机/VPN。'
        }))
  },
  {
    id: 'SEC_NACOS_DEFAULT_IDENTITY',
    cwe: 'CWE-1392',
    match: (index) => {
      const drafts: IssueDraft[] = [];
      const identities = index.byKeySuffix(/nacos\.core\.auth\.(default\.identity|server\.identity)\.value$/);
      for (const entry of identities) {
        const value = entry.value.trim().replace(/^["']|["']$/g, '');
        if (value !== '' && value.toLowerCase() !== 'nacos') {
          continue;
        }
        drafts.push({
          line: entry.line,
          severity: 'medium',
          message: `Nacos 集群身份标识仍是空值或示例值「${value || '空'}」，源码里的示例配置被直接复制上线时，节点间身份校验形同虚设`,
          advice: '把 `nacos.core.auth.server.identity.key/value` 改成随机且非公开的值并外部化注入，所有节点保持一致。'
        });
      }
      return drafts;
    }
  },
  {
    id: 'SEC_SPRING_SECURITY_DEFAULT_USER',
    cwe: 'CWE-1392',
    match: (index) => {
      const drafts: IssueDraft[] = [];
      const names = index.byKeySuffix(/^spring\.security\.user\.name$/);
      for (const entry of names) {
        if (entry.value.trim() !== 'user') {
          continue;
        }
        drafts.push({
          line: entry.line,
          severity: 'medium',
          message: 'Spring Security 的 `spring.security.user.name` 仍是默认 user，等同一个全员皆知的内置账号',
          advice: '仅用于本地调试；生产改接数据库/LDAP 认证并移除 `spring.security.user` 配置。'
        });
      }
      const passwords = index.byKeySuffix(/^spring\.security\.user\.password$/);
      for (const entry of passwords) {
        const value = entry.value.trim();
        if (/\$\{|^ENC\(|^(sm|vault|sops|aws|kms):/i.test(value)) {
          continue;
        }
        const weak = value === '' || WEAK_PASSWORDS.has(value.toLowerCase());
        drafts.push({
          line: entry.line,
          severity: weak ? 'high' : 'medium',
          message: `Spring Security 内置账号使用了${weak ? '空口令/弱口令' : '固定口令'}，且该账号不受业务鉴权体系管理`,
          advice: '移除 `spring.security.user.password` 硬编码；生产用外部认证源，临时账号也要从环境变量注入并限时使用。'
        });
      }
      return drafts;
    }
  },
  {
    id: 'SEC_HEALTH_SHOW_DETAILS',
    cwe: 'CWE-497',
    match: (index) =>
      index
        .byKeySuffix(/management\.endpoint\.health\.(show-details|show-components)$/)
        .filter((entry) => entry.value.toLowerCase() === 'always')
        .map((entry) => ({
          line: entry.line,
          severity: 'medium' as Severity,
          message: '健康检查端点被设为 always 展示细节，会对外泄露数据库/Redis/磁盘等组件状态与错误原因',
          advice: '改成 `when-authorized`（配合认证）或 never；需要排障时由运维在受控入口开启。'
        }))
  },
  {
    id: 'SEC_MANAGEMENT_BASE_PATH_ROOT',
    cwe: 'CWE-668',
    match: (index) => {
      const basePath = index.byKeySuffix(/management\.endpoints\.web\.base-path$/)[0];
      const exposure = index.byKeySuffix(/management\.endpoints\.web\.exposure\.include$/);
      if (!basePath || basePath.value.trim() !== '/' || exposure.length === 0) {
        return [];
      }
      return [
        {
          line: basePath.line,
          severity: 'low' as Severity,
          message: 'Actuator 的 base-path 被改成根路径 `/`，管理端点与业务路径混在同一命名空间，容易被网关规则/鉴权白名单顺带放行',
          advice: '保留默认 `/actuator` 或换成不易猜的前缀，并在网关层对管理前缀单独做访问控制。'
        }
      ];
    }
  },
  {
    id: 'SEC_ERROR_STACKTRACE',
    cwe: 'CWE-209',
    match: (index) => {
      const drafts: IssueDraft[] = [];
      for (const entry of index.byKeySuffix(/server\.error\.include-stacktrace$/)) {
        const value = entry.value.toLowerCase();
        if (value !== 'always' && value !== 'on_param') {
          continue;
        }
        drafts.push({
          line: entry.line,
          severity: value === 'always' ? 'medium' : 'low',
          message: `错误响应里包含堆栈（include-stacktrace=${value}），异常会暴露类名、框架版本与内部调用链`,
          advice: '生产环境设为 never；需要定位问题时看服务端日志，不要回传给调用方。'
        });
      }
      for (const entry of index.byKeySuffix(/server\.error\.include-(message|binding-errors)$/)) {
        if (entry.value.toLowerCase() !== 'always') {
          continue;
        }
        drafts.push({
          line: entry.line,
          severity: 'low',
          message: '错误响应里回传了异常消息/校验细节，可能泄露表名、字段名等内部信息',
          advice: '生产环境改为 never，对外只返回统一错误码与追踪 ID。'
        });
      }
      return drafts;
    }
  },
  {
    id: 'SEC_SQL_LOG_DEBUG',
    cwe: 'CWE-532',
    match: (index) =>
      index
        .byKeySuffix(/logging\.level\.[\w.$]*$/i)
        .filter((entry) => /(sql|mybatis|jdbc|hibernate|ibatis|datasource)/i.test(entry.key))
        .filter((entry) => /^(debug|trace)$/i.test(entry.value.trim()))
        .map((entry) => ({
          line: entry.line,
          severity: 'low' as Severity,
          message: `SQL/ORM 日志级别被开到 ${entry.value.trim().toUpperCase()}，完整 SQL 与参数会落盘，口令、手机号等敏感字段随日志扩散`,
          advice: '生产用 INFO；确需排查时临时开启并把日志采集范围收紧，避免参数明文入日志。'
        }))
  },
  {
    id: 'SEC_ROOT_LOG_DEBUG',
    cwe: 'CWE-532',
    match: (index) =>
      index
        .byKeySuffix(/logging\.level\.root$/i)
        .filter((entry) => /^(debug|trace)$/i.test(entry.value.trim()))
        .map((entry) => ({
          line: entry.line,
          severity: 'low' as Severity,
          message: `根日志级别被设为 ${entry.value.trim().toUpperCase()}，全量 DEBUG 日志会放大磁盘与采集成本，并让内部细节更容易外泄`,
          advice: '生产环境根日志保持 INFO/WARN，按包名精细化开启需要的调试级别。'
        }))
  },
  {
    id: 'SEC_PROFILE_DEV_ACTIVE',
    cwe: 'CWE-489',
    match: (index) => {
      const drafts: IssueDraft[] = [];
      for (const entry of index.byKeySuffix(/spring\.profiles\.(active|include)$/)) {
        const profiles = entry.value
          .split(',')
          .map((item) => item.trim().toLowerCase().replace(/^["']|["']$/g, ''));
        if (!profiles.some((item) => /^(dev|local|test|debug)$/.test(item))) {
          continue;
        }
        drafts.push({
          line: entry.line,
          severity: 'low',
          message: `默认激活了开发 profile（${entry.value}），发布包若未显式覆盖会把开发期配置（文档、调试端点、测试账号）带上生产`,
          advice: '默认 profile 保持生产口径，开发配置放进 `application-dev.yml` 由启动参数显式指定。'
        });
      }
      return drafts;
    }
  },
  {
    id: 'SEC_COOKIE_FLAGS_WEAK',
    cwe: 'CWE-1004',
    match: (index) => {
      const drafts: IssueDraft[] = [];
      for (const entry of index.byKeySuffix(/server\.servlet\.session\.cookie\.http-only$/)) {
        if (entry.value.toLowerCase() !== 'false') {
          continue;
        }
        drafts.push({
          line: entry.line,
          severity: 'medium',
          message: '会话 Cookie 关闭了 HttpOnly，任意 XSS 都能直接读取会话标识',
          advice: '保持（或显式设置）`server.servlet.session.cookie.http-only: true`。'
        });
      }
      for (const entry of index.byKeySuffix(/server\.servlet\.session\.cookie\.secure$/)) {
        if (entry.value.toLowerCase() !== 'false') {
          continue;
        }
        drafts.push({
          line: entry.line,
          severity: 'medium',
          message: '会话 Cookie 关闭了 Secure，会话标识会随明文 HTTP 请求一起发出',
          advice: 'HTTPS 部署下保持 `secure: true`；本地调试再临时关闭。'
        });
      }
      return drafts;
    }
  },
  {
    id: 'SEC_SESSION_TIMEOUT_LONG',
    cwe: 'CWE-613',
    match: (index) => {
      const drafts: IssueDraft[] = [];
      const keys = [...index.byKeySuffix(/server\.servlet\.session\.timeout$/), ...index.byKeySuffix(/spring\.session\.timeout$/)];
      for (const entry of keys) {
        const hours = durationHours(entry.value);
        if (hours === null || hours < 8) {
          continue;
        }
        drafts.push({
          line: entry.line,
          severity: 'low' as Severity,
          message: `会话超时被设为 ${entry.value}（约 ${Math.round(hours)} 小时），会话标识泄露后的可用窗口过长`,
          advice: '普通业务会话建议 30m–2h；确实需要长时间登录时改用滑动续期 + 定期重新鉴权。'
        });
      }
      return drafts;
    }
  },
  {
    id: 'SEC_STATIC_LOCATIONS_FILE',
    cwe: 'CWE-22',
    match: (index) => {
      const drafts: IssueDraft[] = [];
      for (const entry of index.byKeySuffix(/(spring\.web\.resources|spring\.resources)\.static-locations(\.\[\])?$/)) {
        if (!/file:/i.test(entry.value)) {
          continue;
        }
        drafts.push({
          line: entry.line,
          severity: 'medium',
          message: `静态资源目录映射到了本地文件系统（${entry.value}），上传目录一旦被映射即可被直接下载，配合路径穿越可读取任意文件`,
          advice: '静态资源用 classpath；必须映射外部目录时与上传目录隔离，并对访问路径做规范化与扩展名白名单校验。'
        });
      }
      return drafts;
    }
  },
  {
    id: 'SEC_MYSQL_PUBLIC_KEY_RETRIEVAL',
    cwe: 'CWE-319',
    match: (index) =>
      index
        .all()
        .filter((entry) => /(^|\.)url$/i.test(entry.key) && /jdbc:mysql/i.test(entry.value))
        .filter((entry) => /allowPublicKeyRetrieval\s*=\s*true/i.test(entry.value))
        .filter((entry) => /useSSL\s*=\s*false|sslMode\s*=\s*DISABLED/i.test(entry.value))
        .map((entry) => ({
          line: entry.line,
          severity: 'medium' as Severity,
          message: 'MySQL 连接串同时开了 allowPublicKeyRetrieval=true 与明文链路（useSSL=false），中间人可替换公钥后拿到数据库凭据',
          advice: '启用 TLS（`sslMode=VERIFY_CA`）后就不需要 allowPublicKeyRetrieval；确实保留时至少保证链路加密。'
        }))
  },
  {
    id: 'SEC_SPRINGDOC_ACTUATOR',
    cwe: 'CWE-497',
    match: (index) =>
      index
        .byKeySuffix(/springdoc\.show-actuator$/)
        .filter((entry) => entry.value.toLowerCase() === 'true')
        .map((entry) => ({
          line: entry.line,
          severity: 'low' as Severity,
          message: 'springdoc 把 Actuator 端点也纳入了接口文档，管理端点的路径与参数会被公开',
          advice: '关闭 `springdoc.show-actuator`；文档本身也应在生产 profile 下禁用。'
        }))
  },
  {
    id: 'SEC_KNIFE4J_NO_AUTH',
    cwe: 'CWE-306',
    match: (index) => {
      const drafts: IssueDraft[] = [];
      for (const entry of index.byKeySuffix(/knife4j\.basic\.enable$/)) {
        if (entry.value.toLowerCase() !== 'false') {
          continue;
        }
        drafts.push({
          line: entry.line,
          severity: 'medium',
          message: 'Knife4j 的 Basic 认证被显式关闭，文档页与在线调试接口对任何能访问端口的人开放',
          advice: '开启 `knife4j.basic.enable: true` 并配置账号口令（外部化），或仅在受控内网开放文档。'
        });
      }
      return drafts;
    }
  }
];

/** dev/local/test profile 里属于正常调试用法，不按生产问题报 */
const DEV_EXEMPT_RULES = new Set([
  'SEC_SWAGGER_PUBLIC',
  'SEC_DEVTOOLS_ENABLED',
  'SEC_REDIS_NO_PASSWORD',
  // 下面几条在 application-dev.yml 里属于正常调试用法
  'SEC_SQL_LOG_DEBUG',
  'SEC_ROOT_LOG_DEBUG',
  'SEC_PROFILE_DEV_ACTIVE',
  'SEC_ERROR_STACKTRACE'
]);

/** 时长解析：Spring Boot 支持 30m / 8h / 86400s / 1d / 600000ms，返回小时数 */
function durationHours(value: string): number | null {
  const matched = /^(\d+)(ms|s|m|h|d)?$/i.exec(value.trim());
  if (!matched) {
    return null;
  }
  const amount = Number(matched[1]);
  switch ((matched[2] ?? 's').toLowerCase()) {
    case 'ms':
      return amount / 3_600_000;
    case 's':
      return amount / 3_600;
    case 'm':
      return amount / 60;
    case 'd':
      return amount * 24;
    default:
      return amount;
  }
}

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

/** MyBatis Mapper XML 单独收集：只看真正含 `<mapper>` 的 XML，避免把 pom / spring 配置算进来 */
function collectMapperFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) {
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
      if (entry.name.endsWith('.xml')) {
        files.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root, 0);
  return files.sort();
}

/**
 * MyBatis `${}` 是字符串替换而不是预编译占位符：`${name}` 会被原样拼进 SQL。
 * 这里按行定位，先抹掉 XML 注释（保持换行数量）免得注释里的示例被误报。
 */
function scanMapperDollar(file: string, text: string): Issue[] {
  if (!/<mapper[\s>]/.test(text)) {
    return [];
  }
  const masked = text.replace(/<!--[\s\S]*?-->/g, (block) => block.replace(/[^\n]/g, ' '));
  const issues: Issue[] = [];
  const fragments = collectSqlFragments(masked);
  const fragmentRefs = collectFragmentReferences(masked);
  const regex = /\$\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(masked)) !== null) {
    const expression = match[1].trim();
    // MyBatis-Plus 的 wrapper 片段由框架按类型安全方式生成，属于已知安全写法
    if (/^(ew\.(customSqlSegment|sqlSegment)|ew\.paramNameValuePairs|_parameter)/.test(expression)) {
      continue;
    }
    // `<if test="orderBy == 'id' or orderBy == 'name'">` 这类「白名单枚举」保护下的拼接不算注入
    if (isWhitelistGuarded(masked, match.index, expression)) {
      continue;
    }
    const line = masked.slice(0, match.index).split('\n').length;
    const context = dollarContext(masked, match.index);
    // 片段内的 `${}` 要能追到真正引用它的 statement，否则只报「片段里有一处」很难定位
    const fragment = fragments.find((item) => match!.index >= item.start && match!.index <= item.end);
    const referencedBy = fragment ? fragmentRefs.get(fragment.id) ?? [] : [];
    const locationNote = fragment
      ? `（位于 <sql id="${fragment.id}"> 片段${referencedBy.length > 0 ? `，被 ${referencedBy.map((id) => `<${id}>`).join('、')} 引用` : '，未被引用'}）`
      : '';
    issues.push({
      source: 'qcsec',
      severity: context.severity,
      file,
      line,
      column: 1,
      rule: 'SEC_MYBATIS_DOLLAR_SUBSTITUTION',
      message: `Mapper 里使用了 \${${expression}} 字符串替换，参数会被原样拼进 SQL，可被注入改写${context.note}${locationNote}`,
      advice: '改成 `#{}` 预编译占位符；确需动态表名/排序字段时用白名单枚举校验，不要直接接收外部值。',
      cwe: ['CWE-89']
    });
  }
  return issues;
}

/** `<sql id="x">...</sql>` 片段区间，用于把 `${}` 归到具体片段 */
function collectSqlFragments(text: string): { id: string; start: number; end: number }[] {
  const fragments: { id: string; start: number; end: number }[] = [];
  const regex = /<sql\b[^>]*\bid\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>[\s\S]*?<\/sql>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    fragments.push({ id: match[1] ?? match[2] ?? '', start: match.index, end: match.index + match[0].length });
  }
  return fragments;
}

/** refid → 引用它的 statement id 列表（statement 用最近的前置标签判断，mapper 内语句不嵌套） */
function collectFragmentReferences(text: string): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  const statements: { id: string; start: number }[] = [];
  const statementRegex = /<(select|insert|update|delete|resultMap)\b[^>]*\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let statement: RegExpExecArray | null;
  while ((statement = statementRegex.exec(text)) !== null) {
    statements.push({ id: statement[2] ?? statement[3] ?? '', start: statement.index });
  }
  const includeRegex = /<include\b[^>]*\brefid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let include: RegExpExecArray | null;
  while ((include = includeRegex.exec(text)) !== null) {
    const refid = include[1] ?? include[2] ?? '';
    const owner = [...statements].reverse().find((item) => item.start <= include!.index);
    if (!owner) {
      continue;
    }
    const list = refs.get(refid) ?? [];
    if (!list.includes(owner.id)) {
      list.push(owner.id);
    }
    refs.set(refid, list);
  }
  return refs;
}

/** 按 `${}` 出现位置分级：排序/分页字段多为「已加白名单」的写法，降一级但仍提示 */
function dollarContext(text: string, position: number): { severity: Severity; note: string } {
  const before = text.slice(Math.max(0, position - 100), position);
  if (/order\s+by\s+[^,;()]{0,20}$/i.test(before)) {
    return { severity: 'medium', note: '（用于 ORDER BY 动态排序字段）' };
  }
  if (/(limit|offset)\s+[^,;()]{0,20}$/i.test(before)) {
    return { severity: 'medium', note: '（用于 LIMIT/OFFSET 动态分页参数）' };
  }
  return { severity: 'high', note: '' };
}

/**
 * 判断 `${expr}` 是否被外层 `<if test="...">` 用字面量白名单保护：
 * 只认「同一表达式与字符串字面量做 == / eq 比较，且没有和其他变量比较」的写法。
 */
function isWhitelistGuarded(text: string, position: number, expression: string): boolean {
  const openRegex = /<if\b[^>]*\btest\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
  let lastOpen: RegExpExecArray | null = null;
  let current: RegExpExecArray | null;
  while ((current = openRegex.exec(text)) !== null && current.index < position) {
    lastOpen = current;
  }
  if (!lastOpen) {
    return false;
  }
  // 已经闭合的 <if> 不算包住当前片段
  if (/<\/if>/i.test(text.slice(lastOpen.index, position))) {
    return false;
  }
  const test = (lastOpen[1] ?? lastOpen[2] ?? '').trim();
  if (!test || test.includes('${')) {
    return false;
  }
  const escaped = expression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const literalCompare = (test.match(new RegExp(`${escaped}\\s*(==|eq)\\s*(?:'[^']*'|"[^"]*")`, 'g')) ?? [])
    .length;
  if (literalCompare === 0) {
    return false;
  }
  // 与变量比较、参与拼接或作为方法调用参数时，白名单不成立
  const risky =
    new RegExp(`${escaped}\\s*(?:\\+|\\()`).test(test) ||
    new RegExp(`${escaped}\\s*(?:==|eq|!=|ne)\\s*[A-Za-z_$]`).test(test) ||
    new RegExp(`[A-Za-z_$][\\w$]*\\s*(?:==|eq|!=|ne)\\s*${escaped}`).test(test);
  return !risky;
}

/** `statementType="STATEMENT"` 会退回非预编译 Statement，`#{}` 也失去参数绑定保护 */
function scanMapperStatementType(file: string, text: string): Issue[] {
  if (!/<mapper[\s>]/.test(text)) {
    return [];
  }
  const issues: Issue[] = [];
  const masked = text.replace(/<!--[\s\S]*?-->/g, (block) => block.replace(/[^\n]/g, ' '));
  const regex = /statementType\s*=\s*["']STATEMENT["']/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(masked)) !== null) {
    const line = masked.slice(0, match.index).split('\n').length;
    issues.push({
      source: 'qcsec',
      severity: 'medium',
      file,
      line,
      column: 1,
      rule: 'SEC_MYBATIS_STATEMENT_TYPE',
      message: '语句使用 statementType="STATEMENT"，MyBatis 会退回普通 Statement，参数绑定保护失效',
      advice: '改用默认的 PREPARED 模式；确需 STATEMENT（例如动态 DDL）时把 SQL 收敛到常量并做白名单校验。',
      cwe: ['CWE-89']
    });
  }
  return issues;
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
    // dev/test profile 里开文档与 devtools 属于正常用法，避免把这些当生产问题误报
    const isDevProfile = /-(dev|local|test|it|integration)\.(ya?ml|properties)$/i.test(file);
    for (const rule of RULES) {
      if (isDevProfile && DEV_EXEMPT_RULES.has(rule.id)) {
        continue;
      }
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

  // MyBatis Mapper XML：`${}` 是字符串替换，和 yml 一样属于「资源层配置」，同一类结果归到此处
  const mappers = collectMapperFiles(root);
  for (const mapper of mappers) {
    try {
      const stat = fs.statSync(mapper);
      if (stat.size > 2_000_000) {
        continue;
      }
      const text = fs.readFileSync(mapper, 'utf8');
      issues.push(...scanMapperDollar(mapper, text));
      issues.push(...scanMapperStatementType(mapper, text));
    } catch {
      continue;
    }
  }

  return { issues, files: files.length + mappers.length };
}

/** 供文档/CLI 展示的规则清单 */
export const QCSEC_RULES = RULES.map((rule) => ({ id: rule.id, cwe: rule.cwe }));
