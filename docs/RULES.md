# 安全规则清单与缺口

这份清单是"能力边界"的唯一事实来源：每条规则要么有扫描器在跑并有 fixture 回归，要么明确标成缺口。
新增规则必须先在这里立项、再补 fixture，矩阵转绿才算完成。

## 覆盖口径

- **代码层**（Java 源码 / 字节码）：由 `SpotBugs + FindSecBugs 1.14`（144 个 pattern）承担，`PERMISSIVE_CORS`、`SPRING_CSRF_*` 等由字节码 + Spring 语义检测。
- **源码语义层**（Java AST + 模板）：由 `astgrep` 承担（`@ast-grep/napi` + `@ast-grep/lang-java`），用于「方法链 + 字符串字面量」这类字节码会丢失语义、正则又容易误报的规则；当前 27 条规则（含 Thymeleaf / JSP 未转义输出、FreeMarker / Velocity 模板注入），全部有正例/反例靶场。
- **配置层**（`application*.yml/yaml/properties`、`bootstrap*.yml`、MyBatis Mapper XML）：由内置扫描器 `qcsec` 承担，把配置拍平成「键路径 + 值 + 行号」或按 XML 行号定位，支持跨键组合判断（Druid 面板开启但未设口令这类），不依赖任何外部二进制。当前 36 条配置规则 + 2 条 Mapper 规则，全部实现且有靶场。
- **依赖层**：`Trivy --scanners vuln`，按依赖坐标查漏洞库（CVE），只能回答"这个版本有没有已知漏洞"。
- 覆盖度不是承诺"100%"，而是：清单条目 → 规则 ID → fixture 用例，一一对应，可跑可查；缺口在表里写明。

## 代码层

| 风险 | CWE | 规则 ID | 状态 | 用例 |
| --- | --- | --- | --- | --- |
| CORS 允许任意源（含允许凭证） | 942 | `PERMISSIVE_CORS`（FindSecBugs，Spring `CorsRegistry` 与 `Access-Control-Allow-Origin` 两条路径） | 已覆盖 | `cors-permissive` / `cors-explicit-allowlist` |
| Spring Security 关闭 CSRF | 352 | `SPRING_CSRF_PROTECTION_DISABLED` | 已覆盖 | `csrf-disabled` |
| `@RequestMapping` 未限定 HTTP 方法 | 352 | `SPRING_CSRF_UNRESTRICTED_REQUEST_MAPPING` | 已覆盖 | 待补 |
| Java 代码里硬编码口令 / 密钥 | 259 / 798 | `HARD_CODE_PASSWORD` / `HARD_CODE_KEY` | 已覆盖（仅 Java 常量，**不覆盖 yml**） | 待补 |
| 可预测随机数（令牌、验证码） | 330 | `PREDICTABLE_RANDOM` | 已覆盖 | 待补 |
| 弱哈希（MD5 / SHA-1） | 328 | `WEAK_MESSAGE_DIGEST_MD5` 等 | 已覆盖 | 待补 |
| SQL 拼接注入 | 89 | `SQL_INJECTION_*` 系列 | 已覆盖 | 待补 |
| XXE | 611 | `XXE_*` 系列 | 已覆盖 | 待补 |
| 不安全反序列化 | 502 | `OBJECT_DESERIALIZATION` 等 | 已覆盖 | 待补 |
| 路径穿越 | 22 | `PATH_TRAVERSAL_IN` | 已覆盖 | 待补 |
| SSRF | 918 | `URLCONNECTION_SSRF_FD` 等 | 已覆盖 | 待补 |
| `permitAll()` 打到 actuator / admin 路径 | 284 | `AST_PERMIT_ALL_SENSITIVE_PATH`（astgrep：只看该调用链自己的匹配器参数，或 `anyRequest().permitAll()`） | 已覆盖 | `ast-permit-all-actuator` / `ast-permit-all-hardened` |
| 日志打印口令 / 令牌等敏感字段 | 532 | `AST_LOG_SENSITIVE_FIELD`（astgrep：`log/logger.debug|info|warn|error` 参数匹配敏感字段） | 已覆盖 | `ast-log-sensitive` |
| 文件上传未校验类型与大小 | 434 | `AST_UPLOAD_WITHOUT_VALIDATION`（astgrep：`MultipartFile` 参数所在方法体无 `getSize`/`getContentType`/白名单等校验） | 已覆盖 | `ast-upload-unvalidated` |
| SQL 由字符串拼接后直接执行 | 89 | `AST_SQL_STRING_CONCAT`（astgrep：`executeQuery`/`query`/`update` 等调用的参数里出现「字面量 + 变量」的二元表达式） | 已覆盖 | `ast-sql-string-concat` / `ast-hardened-patterns`（预编译反例） |
| `@CrossOrigin` 通配或裸注解 | 942 | `AST_CROSS_ORIGIN_WILDCARD`（astgrep：`origins="*"`、裸 `@CrossOrigin`、以及带 `allowCredentials=true` 的组合） | 已覆盖 | `ast-crossorigin-wildcard` / `ast-hardened-patterns` |
| SpEL / OGNL 用外部输入构造表达式 | 94 | `AST_SPEL_INJECTION`（astgrep：`parseExpression` / `Ognl.getValue` 的参数不是字面量） | 已覆盖 | `ast-spel-injection` / `ast-hardened-patterns` |
| Runtime.exec / ProcessBuilder 拼接命令 | 78 | `AST_RUNTIME_EXEC_CONCAT`（astgrep：`Runtime.exec` 参数非字面量、`ProcessBuilder` 走 `-c` shell） | 已覆盖 | `ast-runtime-exec` / `ast-hardened-patterns` |

## 配置层（由 `qcsec` 承担）

| 风险 | CWE | 规则 ID | 状态 | 用例 |
| --- | --- | --- | --- | --- |
| CORS 在 yml 里配成任意源（`cors.allowed-origins: *` 且允许凭证） | 942 | `SEC_CORS_WILDCARD_WITH_CREDENTIALS` | 已覆盖 | `cors-wildcard-credentials` |
| CORS 允许任意源但不带凭证 | 942 | `SEC_CORS_WILDCARD` | 已覆盖 | `cors-wildcard-credentials` |
| Druid stat-view 使用默认口令 `admin/123456` / 弱口令，或开启但未设口令 | 1392 | `SEC_DRUID_STATVIEW_DEFAULT_PASSWORD` | 已覆盖 | `druid-statview-default` / `druid-statview-hardened` |
| Druid stat-view 绑定 `0.0.0.0` / 对外暴露 | 668 | `SEC_DRUID_STATVIEW_PUBLIC_BIND` | 已覆盖 | `druid-statview-default` |
| Druid 面板开启但未配 `login-username`（账号回落到 admin） | 1392 | `SEC_DRUID_STATVIEW_NO_USERNAME` | 已覆盖 | `druid-statview-no-username` |
| Druid 面板开启 `reset-enable`（可清空监控数据） | 770 | `SEC_DRUID_STATVIEW_RESET_ENABLED` | 已覆盖 | `druid-statview-reset-enable` |
| JDBC URL 打开 `allowMultiQueries=true`（注入可堆叠执行） | 89 | `SEC_JDBC_ALLOW_MULTI_QUERIES` | 已覆盖 | `jdbc-allow-multi-queries` |
| Actuator 全端点暴露（含 `env` / `heapdump`） | 497 | `SEC_ACTUATOR_EXPOSE_ALL` | 已覆盖 | `actuator-expose-all` |
| Swagger / knife4j 在生产环境开放 | 200 | `SEC_SWAGGER_PUBLIC`（springdoc / springfox / knife4j 的 enabled 开关为 true，且未用 `knife4j.production=true` 保护） | 已覆盖 | `swagger-public` / `swagger-hardened` |
| `spring.devtools` 在生产启用 | 489 | `SEC_DEVTOOLS_ENABLED` | 已覆盖 | `config-hardening-mixed` |
| 配置文件里明文口令（非 `${...}` 占位） | 798 | `SEC_PLAINTEXT_PASSWORD_PROPERTY` | 已覆盖 | `config-hardening-mixed`（反例） |
| MyBatis Mapper XML 使用 `${}` 字符串替换 | 89 | `SEC_MYBATIS_DOLLAR_SUBSTITUTION`（qcsec：扫描含 `<mapper>` 的 XML，逐行定位 `${...}`；XML 注释、`${ew.customSqlSegment}` 等 MyBatis-Plus wrapper 片段、以及被 `<if test="x == 'a' or x == 'b'">` 字面量白名单约束的拼接都放行） | 已覆盖 | `mybatis-dollar-substitution` / `mybatis-hash-only` / `mybatis-if-whitelist` / `mybatis-if-user-input` |
| Mapper 使用 `statementType="STATEMENT"` | 89 | `SEC_MYBATIS_STATEMENT_TYPE`（qcsec：退回非预编译 Statement，`#{}` 也失去绑定保护） | 已覆盖 | `mapper-statement-type` |
| MyBatis 注解 SQL 使用 `${}` | 89 | `AST_MYBATIS_ANNOTATION_SQL`（astgrep：`@Select/@Insert/@Update/@Delete` 注解文本含 `${`） | 已覆盖 | `ast-mybatis-annotation-sql` / `ast-safe-patterns-2` |
| 外部输入作为请求地址（SSRF） | 918 | `AST_SSRF_EXTERNAL_URL`（astgrep：`new URL(非字面量)`、`RestTemplate/WebClient` 首个参数非字面量） | 已覆盖 | `ast-ssrf-external-url` / `ast-safe-patterns-2` |
| 响应流直接写入外部输入（反射型 XSS） | 79 | `AST_XSS_RESPONSE_WRITE`（astgrep：`getWriter()` 直连或 `PrintWriter` 变量中转的 `write/print/println/append/printf/format`，参数非字面量且未转义） | 已覆盖 | `ast-xss-response-write` / `ast-xss-writer-variable` / `ast-xss-writer-hardened` |
| 模板层未转义输出（Thymeleaf `th:utext` / JSP `<%= request.getParameter %>`） | 79 | `AST_XSS_TEMPLATE_UNESCAPED`（astgrep：HTML 语法树定位 `th:utext` 动态表达式；JSP 只认请求参数/请求头直出） | 已覆盖 | `ast-xss-template` / `ast-xss-template-hardened` |
| `web.ignoring()` 让管理路径绕过安全过滤器链 | 284 | `AST_PERMIT_ALL_SENSITIVE_PATH`（astgrep：沿 `ignoring()` 整条链判断匹配器参数，含常量展开） | 已覆盖 | `ast-permit-all-ignore` / `ast-permit-all-hardened-2` |
| `permitAll()` 的匹配器参数是白名单常量 | 284 | `AST_PERMIT_ALL_SENSITIVE_PATH`（astgrep：把同文件 `static final String[]`、同方法内局部变量常量、`@Value("${key:/path}")` 的默认值展开后再匹配敏感路径） | 已覆盖 | `ast-permit-all-constant` / `ast-permit-all-value-default` / `ast-permit-all-hardened-2` / `ast-permit-all-value-hardened` |
| Redis 空口令或远端实例没配 password | 306 | `SEC_REDIS_NO_PASSWORD`（dev/test profile 不报） | 已覆盖 | `middleware-config-risk` / `middleware-config-hardened` |
| 中间件默认账号（Nacos `nacos`、RabbitMQ `guest`） | 1392 | `SEC_DEFAULT_CREDENTIAL_USERNAME` | 已覆盖 | `middleware-config-risk` / `middleware-config-hardened` |
| Nacos 关闭鉴权（`nacos.core.auth.enabled=false`） | 306 | `SEC_NACOS_AUTH_DISABLED` | 已覆盖 | `middleware-config-risk` / `middleware-config-hardened` |
| Kafka SASL JAAS 里写死明文口令 | 798 | `SEC_MQ_SASL_PLAINTEXT` | 已覆盖 | `middleware-config-risk` / `middleware-config-hardened` |
| Nacos token secret key 为空或官方示例密钥 | 1392 | `SEC_NACOS_TOKEN_SECRET_KEY`（`nacos.core.auth.*.token.secret.key`，空值、`SecretKey0123456789…`、`nacos/secret/changeme` 都算未更换） | 已覆盖 | `nacos-token-default` / `nacos-token-hardened` |
| Spring Cloud Gateway actuator 端点开启 | 497 | `SEC_ACTUATOR_GATEWAY_EXPOSED`（`/actuator/gateway/routes` 泄露路由，refresh 可触发刷新） | 已覆盖 | `actuator-gateway-exposed` / `actuator-gateway-hardened` |
| JDBC 连接串关闭 TLS（`useSSL=false` / `sslMode=DISABLED`） | 319 | `SEC_DATASOURCE_DISABLED_SSL` | 已覆盖 | `datasource-ssl-disabled` / `datasource-ssl-hardened` |
| Actuator 全暴露且与应用共用端口（管理面未隔离） | 668 | `SEC_MANAGEMENT_PORT_SHARED`（要求 `exposure.include: *` 且未配 `management.server.port`） | 已覆盖 | `management-port-shared` / `management-port-isolated` |
| 上传文件名直接或经局部变量中转拼落盘路径（路径穿越） | 22 | `AST_PATH_TRAVERSAL_UPLOAD`（astgrep：`getOriginalFilename()` 或其同方法局部变量出现在 `new File` / `Files.write` / `transferTo` 等落盘调用里，且未用 `FilenameUtils.getName` / `getFileName` 收敛） | 已覆盖 | `ast-upload-path-traversal` / `ast-upload-path-relay` / `ast-upload-path-hardened` |
| SQL 由字符串拼接/格式化构造后执行 | 89 | `AST_SQL_STRING_CONCAT`（astgrep：`+` 拼接、`String.format` 的 SQL 模板带非字面量参数、`StringBuilder` 逐段或链式 `append`（含直接塞进执行调用）后执行） | 已覆盖 | `ast-sql-string-concat` / `ast-sql-format-building` / `ast-sql-append-chain` / `ast-sql-building-hardened` |
| 关闭 HTTPS / `server.ssl.enabled: false` | 319 | `SEC_SSL_DISABLED` | 已覆盖 | `config-hardening-mixed` |

## 0.27.0 新增：高危语义规则

| 风险 | CWE | 规则 ID | 状态 | 用例 |
| --- | --- | --- | --- | --- |
| Zip 解压未校验条目路径（Zip Slip） | 22 | `AST_ZIP_SLIP`（`ZipEntry.getName()` 或其同方法局部变量参与目标路径构造，且未 `normalize()` + 前缀比较） | 已覆盖 | `ast-zip-slip` |
| 重定向目标来自请求参数（开放重定向） | 601 | `AST_OPEN_REDIRECT`（`sendRedirect` / `RedirectView` 目标不是常量且未走白名单映射） | 已覆盖 | `ast-open-redirect` / `ast-misc-safe` |
| XML 解析器未禁用 DOCTYPE（XXE） | 611 | `AST_XXE_UNHARDENED`（`DocumentBuilderFactory/SAXParserFactory/XMLInputFactory/TransformerFactory` 的 `newInstance()` 链上没有 `disallow-doctype-decl` 等加固调用） | 已覆盖 | `ast-xxe-source` / `ast-misc-safe` |
| 用 `Random` 生成令牌/验证码 | 338 | `AST_INSECURE_RANDOM`（`new Random()` / `Math.random()` 结果流入 token/password/nonce 等命名） | 已覆盖 | `ast-insecure-random` / `ast-misc-safe` |
| 解析 JWT 但未验签 | 347 | `AST_JWT_NO_VERIFY`（`parseClaimsJwt`、`setSigningKey` 前置缺失的 `parse`） | 已覆盖 | `ast-jwt-no-verify` / `ast-misc-safe` |
| 口令/令牌用 `==`/`equals` 比较（时序侧信道） | 208 | `AST_TIMING_UNSAFE_COMPARE`（敏感字段名的 `equals`/`==` 比较，未用 `MessageDigest.isEqual`） | 已覆盖 | `ast-timing-compare` / `ast-misc-safe` |
| 会话 Cookie 缺 HttpOnly/Secure | 1004 | `AST_COOKIE_FLAGS_MISSING`（`new Cookie(会话名, 值)` 后没有 `setHttpOnly(true)`/`setSecure(true)`） | 已覆盖 | `ast-cookie-flags` / `ast-misc-safe` |
| 下载/读取路径来自请求参数（任意文件读取） | 22 | `AST_ARBITRARY_FILE_READ`（`FileInputStream`/`Files.read*`/`ResourceUtils` 参数来自请求参数且无 `..` 过滤） | 已覆盖 | `ast-download-traversal` |
| 模板引擎把外部输入当模板源码（SSTI） | 94 | `AST_TEMPLATE_INJECTION`（`TemplateEngine.process(变量)`、Velocity `evaluate`/`getTemplate` 末参非常量、`new Template(name, new StringReader(变量))`；常量字段与字面量放行） | 已覆盖 | `ast-ssti` / `ast-template-engine-source` / `ast-template-engine-safe` / `ast-misc-safe` |
| LDAP 过滤器字符串拼接 | 90 | `AST_LDAP_INJECTION`（接收者/形参为 `DirContext`/`LdapTemplate` 且过滤器参数非字面量） | 已覆盖 | `ast-ldap-injection` |
| JDBC 连接地址由拼接构造 | 74 | `AST_JDBC_URL_INJECTION`（`getConnection` 的 URL 含 `+` 与标识符） | 已覆盖 | `ast-jdbc-url-concat` |
| 日志拼接未过滤的请求参数（日志注入） | 117 | `AST_LOG_INJECTION`（`log.*` 参数里直接拼请求参数，未替换换行符） | 已覆盖 | `ast-log-injection` |
| `System.out` 打印口令等敏感字段 | 532 | `AST_CONSOLE_SENSITIVE_OUTPUT`（`System.out/err` 输出参数含敏感字段名或请求参数） | 已覆盖 | `ast-console-sensitive` |
| 反序列化不可信数据 | 502 | `AST_UNSAFE_DESERIALIZATION`（`ObjectInputStream.readObject`、`XStream.fromXML`、`readValue` 配合默认类型） | 已覆盖 | `ast-deserialization` |
| 上传只校验大小/类型，没有扩展名校验 | 434 | `AST_UPLOAD_EXTENSION_UNCHECKED`（方法内已有 `getSize`/`getContentType` 但没有扩展名白名单） | 已覆盖 | `ast-upload-ext` |

## 0.27.0 新增：配置层规则

| 风险 | CWE | 规则 ID | 状态 | 用例 |
| --- | --- | --- | --- | --- |
| Druid `filters` 注册 `config`（暴露连接串/会话配置） | 200 | `SEC_DRUID_FILTERS_CONFIG` | 已覆盖 | `config-druid-filters` |
| Druid 面板 `allow` 留空（不限制来源） | 668 | `SEC_DRUID_STATVIEW_ALLOW_EMPTY`（yml 空值叶子也能识别） | 已覆盖 | `config-druid-filters` |
| Nacos 集群身份标识仍是示例 `nacos` | 1392 | `SEC_NACOS_DEFAULT_IDENTITY` | 已覆盖 | `config-nacos-identity` |
| Spring Security 内置账号默认 `user` / 固定口令 | 1392 | `SEC_SPRING_SECURITY_DEFAULT_USER` | 已覆盖 | `config-security-default-user` |
| 健康检查 `show-details/show-components: always` | 497 | `SEC_HEALTH_SHOW_DETAILS` | 已覆盖 | `config-actuator-details` |
| Actuator `base-path` 改成根路径 | 668 | `SEC_MANAGEMENT_BASE_PATH_ROOT`（需同时配了 exposure，避免默认配置误报） | 已覆盖 | `config-actuator-details` |
| 错误响应回传堆栈/异常消息 | 209 | `SEC_ERROR_STACKTRACE`（`always` 记中危，`on_param` 与 `include-message` 记低危；dev profile 豁免） | 已覆盖 | `config-error-stacktrace` |
| SQL/ORM 日志开到 DEBUG/TRACE | 532 | `SEC_SQL_LOG_DEBUG`（dev profile 豁免） | 已覆盖 | `config-logging-debug` |
| 根日志级别 DEBUG/TRACE | 532 | `SEC_ROOT_LOG_DEBUG`（dev profile 豁免） | 已覆盖 | `config-logging-debug` |
| 默认激活 dev/local/test profile | 489 | `SEC_PROFILE_DEV_ACTIVE`（dev profile 文件内豁免） | 已覆盖 | `config-profile-dev` |
| 会话 Cookie 关闭 HttpOnly / Secure | 1004 | `SEC_COOKIE_FLAGS_WEAK`（仅显式 `false` 才报） | 已覆盖 | `config-session-cookie` |
| 会话超时 ≥ 8 小时 | 613 | `SEC_SESSION_TIMEOUT_LONG`（支持 `30m`/`8h`/`1d`/`86400s` 写法） | 已覆盖 | `config-session-cookie` |
| 静态资源目录映射本地文件系统 | 22 | `SEC_STATIC_LOCATIONS_FILE`（`static-locations` 含 `file:`） | 已覆盖 | `config-session-cookie` |
| MySQL `allowPublicKeyRetrieval=true` + 明文链路 | 319 | `SEC_MYSQL_PUBLIC_KEY_RETRIEVAL`（必须同时 `useSSL=false`/`sslMode=DISABLED` 才报） | 已覆盖 | `config-mysql-public-key` |
| springdoc 把 Actuator 纳入文档 | 497 | `SEC_SPRINGDOC_ACTUATOR` | 已覆盖 | `config-actuator-details` |
| Knife4j 显式关闭 Basic 认证 | 306 | `SEC_KNIFE4J_NO_AUTH` | 已覆盖 | `config-knife4j-no-auth` |

## 工程质量能力（0.27.0）

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 单规则开关 | `qualityCenter.rules.mute` / `--mute` | 支持规则 id、前缀通配 `SEC_DRUID_*`、来源名 `trivy`；被静音条数记入 `summary.mutedByRule`，不进入面板与报告 |
| SARIF 导出 | `--sarif [路径]` / 自动写 `.quality-center/report.sarif` | SARIF 2.1.0，可直接上传 GitHub code scanning |
| CI 注解 | `--gha` | 输出 `::error/::warning file=…,line=…,title=规则::消息`，PR 里直接落到代码行 |
| 同文件聚合 | `qualityCenter.aggregate` / `--aggregate` | 同规则同文件 ≥3 处合并（仅 medium 及以下，高危逐条） |
| 基线忽略 | 面板「忽略」/ `baseline.json` | 已有能力，与静音互补：基线按单条指纹，静音按规则 |
| 扫描缓存 | 面板扫描器级缓存 + `.quality-center/scan-cache.json` | 源码/依赖清单/配置未变时跳过重扫 |
| Mapper 片段归属 | `SEC_MYBATIS_DOLLAR_SUBSTITUTION` 消息 | `${}` 落在 `<sql id>` 片段时标注「被 `<select id=…>` 引用」，并按 ORDER BY/LIMIT 位置降到中危 |

## 接线现状与局限

FindSecBugs 必须写进 pom 的 `<build><plugins>` 才生效（`spotbugs-maven-plugin` 的 `plugins` 参数没有 userProperty，`-Dspotbugs.plugins` 传不进去）。插件现在的做法：

1. 项目 pom 里已经出现 `findsecbugs` → 尊重用户配置，直接用原 pom；
2. 否则复制一份到项目根 `.qc-spotbugs-pom.xml`，注入 FindSecBugs 1.14 后 `mvn -f` 运行，结束后删除；
3. 注入失败（没 pom.xml / 不是 Maven 工程）→ 只跑 SpotBugs 核心规则，并把原因作为"扫描异常"上报，不静默降级。

已知局限：

- **多模块工程**：只注入根 pom，SpotBugs 在子模块上运行时不会带上 FindSecBugs（后续计划改用 SpotBugs 独立发行版 + `-pluginList` 解决）。
- 需要 `target/classes`（或先执行构建），否则 SpotBugs 直接跳过。
- 配置层由 `qcsec` 覆盖，但它只解析配置文本、不做运行期验证：`${ENV}` 占位视为已外部化（`ENC(...)`、`{cipher}`、`sm:/vault:` 等密钥托管写法同样放行），不会跟进到实际生效值；profile 差异按文件计，不会合并 `application-*.yml` 的覆盖关系；`dev/local/test/it` profile 里的 Swagger、devtools、「Redis 空口令」按正常用法忽略，0.27.0 新增的 SQL 日志、根日志、错误堆栈与 `spring.profiles.active` 也在 dev profile 文件内豁免（避免「开发配置报生产问题」的误报）。Swagger 规则只认显式 enabled 开关，依赖引入但未显式配置时不会报；MyBatis 只认 XML 与注解里的 `${}`、`statementType="STATEMENT"`，白名单豁免要求 `<if test>` 里对同一表达式做字面量 `==`/`eq` 比较且不与其他变量比较，写成 `x > 'a'` 之类范围判断仍会报。
- 语义层由 `astgrep` 覆盖，局限是：只解析 Java 源码（不处理 Kotlin / Groovy / 编译产物）；不解析 Spring 继承与 `@Configuration` 装配关系，`/actuator` 这类路径靠字面量匹配；`anyRequest()` / 匹配器判断只看同一条方法链，常量只展开一层（字段常量全文件、局部变量限同方法、`@Value` 只取默认值），跨类常量、配置中心实际取值、`@ConfigurationProperties` 绑定会漏报；`MultipartFile` 校验只看方法体内关键字，跨方法封装的校验会判为缺失；SQL 拼接覆盖 `+` 拼进执行调用、`String.format` 的 SQL 模板带变量参数、同一方法内 `StringBuilder/StringBuffer` 逐段或链式 append（含直接塞进执行调用）后整体交给执行调用，但同方法内的 `String sql = ... + x` 变量中转与 `StringBuilder` 链式 append 已覆盖，跨方法的 builder、先 `append` 再 `replace`、跨方法拼接仍会漏报；路径穿越覆盖 `getOriginalFilename()` 直接出现在落盘调用、以及同方法内局部变量中转的写法，跨方法/字段中转和先做字符串替换再落盘的会漏报；`@CrossOrigin` 只认注解本身，不合并全局 CORS 配置；SSRF 与命令执行只放行字面量参数，常量中转会报（可用 `baseline` 忽略）；XSS 覆盖 `getWriter()` 直连与同方法内 `PrintWriter` 变量中转，跨方法传递的输出流不在范围；模板层覆盖 Thymeleaf `th:utext`、JSP `<%= %>` 直出请求参数，以及 FreeMarker/Velocity 的源码级注入（`evaluate`/`getTemplate` 末参非常量、`new Template(name, new StringReader(变量))`）；自定义标签、`spring.freemarker` 的模板目录配置、以及把用户数据当模型传入的正常用法不在范围（后者本就不该报）。0.27.0 的高危规则靠「方法名 + 接收者/类型 + 实参形状」判定，自研封装（包装过的日志门面、自研模板引擎、抽象后的 LDAP 工具类）可能漏报；为了避免误报，Cookie、SqlSession、上传扩展名等规则只在「明确具备前置特征」时才报（例如先有 `new Cookie(会话名, …)`、先有大小/类型校验），宁可少报也不硬报。以上都可用 `baseline` 忽略。
