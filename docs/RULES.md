# 安全规则清单与缺口

这份清单是"能力边界"的唯一事实来源：每条规则要么有扫描器在跑并有 fixture 回归，要么明确标成缺口。
新增规则必须先在这里立项、再补 fixture，矩阵转绿才算完成。

## 覆盖口径

- **代码层**（Java 源码 / 字节码）：由 `SpotBugs + FindSecBugs 1.14`（144 个 pattern）承担，`PERMISSIVE_CORS`、`SPRING_CSRF_*` 等由字节码 + Spring 语义检测。
- **源码语义层**（Java AST + 模板）：由 `astgrep` 承担（`@ast-grep/napi` + `@ast-grep/lang-java`），用于「方法链 + 字符串字面量」这类字节码会丢失语义、正则又容易误报的规则；当前 12 条规则（含 Thymeleaf / JSP 未转义输出），全部有正例/反例靶场。
- **配置层**（`application*.yml/yaml/properties`、`bootstrap*.yml`、MyBatis Mapper XML）：由内置扫描器 `qcsec` 承担，把配置拍平成「键路径 + 值 + 行号」或按 XML 行号定位，支持跨键组合判断（Druid 面板开启但未设口令这类），不依赖任何外部二进制。当前 18 条配置规则 + 2 条 Mapper 规则，全部实现且有靶场。
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
| 上传文件名直接拼落盘路径（路径穿越） | 22 | `AST_PATH_TRAVERSAL_UPLOAD`（astgrep：`getOriginalFilename()` 出现在 `new File` / `Files.write` / `transferTo` 等落盘调用里，且未用 `FilenameUtils.getName` / `getFileName` 收敛） | 已覆盖 | `ast-upload-path-traversal` / `ast-upload-path-hardened` |
| SQL 由字符串拼接/格式化构造后执行 | 89 | `AST_SQL_STRING_CONCAT`（astgrep：`+` 拼接、`String.format` 的 SQL 模板带非字面量参数、`StringBuilder` 逐段 append 后直接执行） | 已覆盖 | `ast-sql-string-concat` / `ast-sql-format-building` / `ast-sql-building-hardened` |
| 关闭 HTTPS / `server.ssl.enabled: false` | 319 | `SEC_SSL_DISABLED` | 已覆盖 | `config-hardening-mixed` |

## 接线现状与局限

FindSecBugs 必须写进 pom 的 `<build><plugins>` 才生效（`spotbugs-maven-plugin` 的 `plugins` 参数没有 userProperty，`-Dspotbugs.plugins` 传不进去）。插件现在的做法：

1. 项目 pom 里已经出现 `findsecbugs` → 尊重用户配置，直接用原 pom；
2. 否则复制一份到项目根 `.qc-spotbugs-pom.xml`，注入 FindSecBugs 1.14 后 `mvn -f` 运行，结束后删除；
3. 注入失败（没 pom.xml / 不是 Maven 工程）→ 只跑 SpotBugs 核心规则，并把原因作为"扫描异常"上报，不静默降级。

已知局限：

- **多模块工程**：只注入根 pom，SpotBugs 在子模块上运行时不会带上 FindSecBugs（后续计划改用 SpotBugs 独立发行版 + `-pluginList` 解决）。
- 需要 `target/classes`（或先执行构建），否则 SpotBugs 直接跳过。
- 配置层由 `qcsec` 覆盖，但它只解析配置文本、不做运行期验证：`${ENV}` 占位视为已外部化（`ENC(...)`、`{cipher}`、`sm:/vault:` 等密钥托管写法同样放行），不会跟进到实际生效值；profile 差异按文件计，不会合并 `application-*.yml` 的覆盖关系；`dev/local/test/it` profile 里的 Swagger、devtools 与「Redis 空口令」按正常用法忽略；Swagger 规则只认显式 enabled 开关，依赖引入但未显式配置时不会报；MyBatis 只认 XML 与注解里的 `${}`、`statementType="STATEMENT"`，白名单豁免要求 `<if test>` 里对同一表达式做字面量 `==`/`eq` 比较且不与其他变量比较，写成 `x > 'a'` 之类范围判断仍会报。
- 语义层由 `astgrep` 覆盖，局限是：只解析 Java 源码（不处理 Kotlin / Groovy / 编译产物）；不解析 Spring 继承与 `@Configuration` 装配关系，`/actuator` 这类路径靠字面量匹配；`anyRequest()` / 匹配器判断只看同一条方法链，常量只展开一层（字段常量全文件、局部变量限同方法、`@Value` 只取默认值），跨类常量、配置中心实际取值、`@ConfigurationProperties` 绑定会漏报；`MultipartFile` 校验只看方法体内关键字，跨方法封装的校验会判为缺失；SQL 拼接覆盖 `+` 拼进执行调用、`String.format` 的 SQL 模板带变量参数、同一方法内 `StringBuilder/StringBuffer` append 后整体交给执行调用，但 `String sql = ... + x` 再执行的变量中转、跨方法的 builder、以及先 `append` 再 `replace` 的写法会漏报；路径穿越只认 `getOriginalFilename()` 直接出现在落盘调用里的写法，先存进变量再传递的会漏报；`@CrossOrigin` 只认注解本身，不合并全局 CORS 配置；SSRF 与命令执行只放行字面量参数，常量中转会报（可用 `baseline` 忽略）；XSS 覆盖 `getWriter()` 直连与同方法内 `PrintWriter` 变量中转，跨方法传递的输出流不在范围；模板层只认 Thymeleaf `th:utext` 与 JSP 里 `<%= %>` 直出请求参数，FreeMarker/Velocity 与自定义标签不在范围。以上都可用 `baseline` 忽略。
