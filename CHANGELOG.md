# Changelog

## 0.27.21

- 重开 / 重载 IDE 后优先从 `.quality-center/issues.json` 恢复上一次扫描结果与升级向导，仓库内事实源优先于扩展 storage 缓存
- 修复扩展刚激活时 `storageUri` / 工作区尚未就绪却把 `cacheLoaded` 提前置真的问题，缓存不会再“一次没读到就永久放弃”

## 0.27.20

- 确认框改为「执行动作 / 稍后 / 取消」，在 Trae 的模态实现下只出现一个取消按钮；回滚同样改为「回滚 / 先不回滚」

## 0.27.19

- 修复 Windows 路径大小写导致扫描缓存被判定为“另一个项目”的问题：重载窗口后直接恢复上一次 719 条结果和向导，不再显示“尚未扫描”、也不必重扫 70 秒

## 0.27.18

- 确认弹窗只保留一个「取消」（VS Code 模态框自带的那个），不再出现两个取消按钮
- 失败后的「查看日志」直接打开 `.quality-center/build.log`，不再跳到混有 IDE 导入日志的输出通道

## 0.27.17

**面板终于和 CLI/AI 走同一条升级主线：先看“下一步”，再只升级当前组。**

- 侧边栏新增“升级向导”卡：直接消费 `qc next` 的 `state / title / progress / groups / blockers / warnings`，面板不再自己算一套进度
- 主按钮改为 **只升级「当前组」**：一次只落 framework → family → independent → cross-line 中的一组，组后自动跑策略门禁
- 成功后提示“继续下一组 / 打开交接”；失败 **保留现场**（不再静默回滚），弹窗给 `原因 / 影响 / 建议`，可选“回滚到计划前 / 查看日志 / 复制给 AI”
- 新增“生成升级计划”“跑构建门禁”“查看失败原因”“打开交接”四个面板动作；构建改用 `buildProject`，与 CLI/MCP 共用 `buildGate` 与 `build-result.json`
- 向导顶部显示分组进度（已完成 / 进行中 / 未开始）与属性覆盖告警（如 `okhttp.version`），点开就能看到“为什么现在不能开下一组”
- 向导按钮改为逐按钮直接绑定并加大命中区域，避免侧边栏窄宽度下点不中

## 0.27.15

**把“下一步做什么”收敛成唯一状态机，并给每个新会话留一页交接。**

- 新增 `qc next` / MCP `quality_next`：把扫描、计划、步骤、构建结果收敛成 `state / action / command / why / blockers / warnings`，同时刷新 `.quality-center/handoff.md`；面板、CLI、AI 不再各推一套流程
- 新增 `.quality-center/handoff.md`：做到哪、下一步命令、已落盘步骤、阻塞与硬性规则，新 Agent 读一页即可接上
- 新增 `qc explain` / MCP `quality_explain`：把构建失败翻译成「原因 / 影响 / 建议」，覆盖属性覆盖 BOM（`Non-resolvable import POM`）、坐标不存在、依赖解析失败、编译错误（文件/行号）、依赖收敛冲突
- 新增 `.quality-center/build-result.json`：每次构建都写（成功也写），`next` 不再靠 `build.log` 的时间猜“这次构建是不是针对当前 pom”
- `build` 真正读取策略：`buildGate`（compile/package/test）与 `mavenArgs` 驱动实际命令；失败输出直接给翻译后的三段结论
- 框架组落盘前预检项目属性覆盖：`okhttp.version`、`kotlin.version`、`mysql.version` 等会提前告警，避免“升完框架才发现 BOM 解析失败”
- 修正边界：还没落任何一组时，基线构建失败只告警，不误报成“上一组失败”
- Skill / agentPrompt / README / manifest 的入口统一为 `qc next`，构建失败先 `qc explain`
- 自检扩到 **96 通过 / 0 失败**（新增状态机、交接文件、属性预检、失败翻译、构建失败/通过后的下一步断言）

## 0.26.0

**把两条已有规则的数据流补上，再加两条配置组合。**

- `AST_PATH_TRAVERSAL_UPLOAD` 支持同方法内局部变量中转：`String name = file.getOriginalFilename(); new File(dir, name)` 现在会报；如果同名变量被 `FilenameUtils.getName(...)` 重新赋值则放行
- `AST_SQL_STRING_CONCAT` 覆盖链式 `append`：`sb.append("... ").append(orderBy)` 以及直接把 `new StringBuilder("...").append(name).toString()` 塞进 `executeQuery` 的写法
- 新增 `SEC_DATASOURCE_DISABLED_SSL`：JDBC 连接串显式 `useSSL=false` / `sslMode=DISABLED` / `sslmode=disable`
- 新增 `SEC_MANAGEMENT_PORT_SHARED`：`exposure.include: '*'` 且没配 `management.server.port`，管理面与业务共用端口
- 反例靶场同步扩充：`ast-upload-path-hardened` 增加“变量 + FilenameUtils 收敛”的写法，`ast-sql-building-hardened` 增加“链式 append 全字面量”的写法，`management-port-isolated` 锁定独立端口不告警
- 靶场新增 6 个用例，矩阵扩到 **57 个用例，PASS 57 / GAP 0 / FAIL 0**
- 文档：`docs/RULES.md` 补 2 行、更新可变信息流局限，README/配置项说明同步为 20 条配置 + 2 条 Mapper + 12 条 AST

## 0.25.0

**继续把「能检出来但不误报」的边界往外推：Druid 面板组合、上传路径穿越、SQL 的 format/append 写法。**

- 新增 `SEC_DRUID_STATVIEW_NO_USERNAME`：`stat-view-servlet.enabled=true` 但没配 `login-username`，账号会回落到内置 admin
- 新增 `SEC_DRUID_STATVIEW_RESET_ENABLED`：`stat-view-servlet.reset-enable=true`，可被用来重置/清空监控数据
- 新增 `AST_PATH_TRAVERSAL_UPLOAD`：`getOriginalFilename()` 直接出现在 `new File` / `Files.write` / `transferTo` 等落盘调用里；用 `FilenameUtils.getName` / `Path.getFileName` / `UUID.randomUUID` 收敛的不报
- `AST_SQL_STRING_CONCAT` 扩展两种常见写法：
  - `String.format("select ... %s", name)`：SQL 模板字面量 + 非字面量参数
  - 同方法内 `StringBuilder/StringBuffer` 逐段 `append` 后把整体交给执行调用；只有全字面量 append 的不报
- 靶场新增 6 个用例（3 正例 + 3 个误报回归集合），矩阵扩到 **51 个用例，PASS 51 / GAP 0 / FAIL 0**
- 文档：`docs/RULES.md` 补 3 行并更新局限（builder 跨方法/先 append 再 replace 会漏报、路径穿越先存变量会漏报），README/配置项说明同步为 18 条配置 + 2 条 Mapper + 12 条 AST

## 0.24.0

**补齐「路径从配置注入」的判定，并把 Nacos 密钥与 Gateway 端点纳入配置层。**

- `AST_PERMIT_ALL_SENSITIVE_PATH` 的常量展开再扩展：
  - 局部变量只在调用所在的同一方法体内查找，避免跨方法同名变量干扰（原来全文件查找）
  - 新增 `@Value("${key:/actuator}")` 默认值解析：匹配器参数写成 `basePath + "/**"` 时，也按默认值判断是否命中敏感路径
- 新增 `SEC_NACOS_TOKEN_SECRET_KEY`：`nacos.core.auth.*.token.secret.key` 为空、`SecretKey0123456789…` 官方示例值、或 `nacos/secret/changeme` 类弱值时告警（这是能伪造任意用户 token 的常见配置疏漏）
- 新增 `SEC_ACTUATOR_GATEWAY_EXPOSED`：`management.endpoint.gateway.enabled=true`，`/actuator/gateway/routes` 会泄露全部路由、refresh 可触发刷新
- `SEC_ACTUATOR_EXPOSE_ALL` 把 `gateway` 纳入敏感端点集合，但把单端点告警让给上面的专用规则，避免同一配置报两条
- 靶场新增 6 个用例（3 正例 + 3 个误报回归集合），矩阵扩到 **45 个用例，PASS 45 / GAP 0 / FAIL 0**
- 顺手清掉了 `fixtures/cases/*` 里由扫描过程生成的 `.quality-center` 目录，保证靶场可重复
- 文档：`docs/RULES.md` 补 2 行、更新常量展开的局限说明，README/配置项说明同步为 16 条配置 + 2 条 Mapper + 11 条 AST

## 0.23.0

**按「覆盖做全做深 + 不失准」继续补齐：Spring Security 常量白名单与 `web.ignoring()`、PrintWriter 变量中转、模板层未转义输出、MyBatis `<if>` 白名单上下文、Redis／Nacos／RabbitMQ／Kafka 配置风险。**

- `AST_PERMIT_ALL_SENSITIVE_PATH` 扩展：
  - 匹配器参数是 `static final String[]` 或局部常量时，先把同文件常量字面量展开再判断，`antMatchers(WHITELIST).permitAll()` 不再漏检
  - 新增 `web.ignoring().antMatchers(...)` 判定——它绕过整个过滤器链，按高危报
  - 敏感路径清单补 `/management`、`/nacos`、`/sentinel`、`/heapdump`、`/threaddump`、`/configprops`、`/prometheus`、`/eureka`、`/jmx`
- `AST_XSS_RESPONSE_WRITE` 扩展：
  - 覆盖同方法内 `PrintWriter out = resp.getWriter()` 的变量中转（`write/print/println/append/printf/format`）
  - 已有 `HtmlUtils.htmlEscape` / `StringEscapeUtils` / `Encode.forHtml` / `sanitize` 等转义处理的写法不再报
- 新增 `AST_XSS_TEMPLATE_UNESCAPED`：Thymeleaf `th:utext` 渲染动态表达式、JSP `<%= %>` 直出请求参数/请求头；`th:text`、`escapeXml`、JSTL `c:out` 的写法不报
- `SEC_MYBATIS_DOLLAR_SUBSTITUTION` 上下文判断：
  - `<if test="x == 'a' or x == 'b'">` 这类字面量白名单约束下的 `${x}` 放行；只判空（`x != null`）或与其他变量比较仍报
  - MyBatis-Plus 的 `${ew.customSqlSegment}` / `${ew.sqlSegment}` / `${ew.paramNameValuePairs...}` 放行
- 新增 4 条中间件配置规则：`SEC_REDIS_NO_PASSWORD`（空口令或远端实例未配 password，dev/test profile 豁免）、`SEC_DEFAULT_CREDENTIAL_USERNAME`（Nacos `nacos`、RabbitMQ `guest`）、`SEC_NACOS_AUTH_DISABLED`（`nacos.core.auth.enabled=false`）、`SEC_MQ_SASL_PLAINTEXT`（Kafka SASL JAAS 明文口令）
- 靶场新增 11 个用例（6 正例 + 5 个误报回归集合），矩阵扩到 **39 个用例，PASS 39 / GAP 0 / FAIL 0**
- 文档：`docs/RULES.md` 补 8 行并更新局限（常量只展开同文件一层、模板只认 Thymeleaf/JSP、白名单豁免要求字面量 `==`/`eq`），README/配置项说明同步为 14 条配置 + 2 条 Mapper + 11 条 AST

## 0.22.0

**能力继续做深：注解 SQL、`statementType=STATEMENT`、SSRF、反射型 XSS 四条新规则，同时专门做了一轮误报治理。**

- 新增 `AST_MYBATIS_ANNOTATION_SQL`：`@Select/@Insert/@Update/@Delete` 注解文本里出现 `${` 即报（与 Mapper XML 规则对齐，注解写法不再漏检）
- 新增 `SEC_MYBATIS_STATEMENT_TYPE`：`statementType="STATEMENT"` 会让 MyBatis 退回普通 Statement，`#{}` 也失去绑定保护
- 新增 `AST_SSRF_EXTERNAL_URL`：`new URL(非字面量)`、`RestTemplate / WebClient` 的首个参数非字面量（`getForObject` / `getForEntity` / `postForObject` / `postForEntity` / `patchForObject` / `exchange`）
- 新增 `AST_XSS_RESPONSE_WRITE`：`response.getWriter().write/print/println` 参数非字面量
- 误报治理（每条都加进靶场锁住）：
  - `@CrossOrigin` 补上「只写 `maxAge` 等属性、未写 origins/value」的情况——Spring 默认仍是通配，此前会漏报；显式白名单数组仍不报
  - 明文口令规则放行 `ENC(...)`、`{cipher}`、`sm:`/`vault:`/`sops:`/`aws:`/`kms:` 等密钥托管写法
  - `dev/local/test/it` profile 里的 Swagger 与 devtools 开关按正常用法忽略，避免把本地配置当生产问题
  - SSRF 与命令执行只放行纯字面量参数；`RestTemplate` 首个参数以字面量开头（固定地址 + 变量 path）不报
- 靶场新增 6 个用例（4 正例 + `ast-safe-patterns-2`、`config-false-positive-guards` 两个误报回归集合），矩阵扩到 **28 个用例，PASS 28 / GAP 0 / FAIL 0**
- 文档：`docs/RULES.md` 补 4 行并更新局限（dev profile 豁免、密钥托管放行、XSS 仅覆盖 `getWriter()`、常量中转会报可用 baseline 忽略），README/配置项说明同步为 10 条配置 + 2 条 Mapper + 10 条 AST

## 0.21.0

**补齐配置层最后两块空白：Swagger 文档开放与 MyBatis `${}` 注入。**

- 新增 `SEC_SWAGGER_PUBLIC`：`springdoc.api-docs.enabled` / `springdoc.swagger-ui.enabled` / `springfox.documentation.enabled` / `knife4j.enable` 显式为 `true` 时报中危；`knife4j.production: true` 视为「生产关闭」的正确写法，不报
- 新增 `SEC_MYBATIS_DOLLAR_SUBSTITUTION`：扫描含 `<mapper>` 的 XML，逐行定位 `${...}` 并给出表达式原文；先抹掉 XML 注释（保留换行，行号不漂移），注释里的示例写法不会误报；`#{}` 预编译写法不报
- 这两条归到 `qcsec`（配置与资源层），不新增扫描器：面板「配置安全」Tab、`report.md`、`summary`、CLI/MCP 都直接生效
- 靶场新增 4 个用例：`swagger-public`、`swagger-hardened`（production + springdoc 关闭的反例）、`mybatis-dollar-substitution`（含注释干扰项）、`mybatis-hash-only`（纯 `#{}` 反例），矩阵扩到 **22 个用例，PASS 22 / GAP 0 / FAIL 0**
- `docs/RULES.md`：配置层 9 条 + Mapper 1 条全部标为已覆盖，`docs/RULES.md` 与 README 的「缺口」段清空，改为写明新局限（Swagger 只认显式开关、MyBatis 只认 XML 里的 `${}`，`@Select` 注解与 `statementType="STATEMENT"` 不在范围内）

## 0.20.0

**AST 语义规则从 3 条扩到 7 条，代码层常见注入面基本覆盖。**

- 新增 `AST_SQL_STRING_CONCAT`：`executeQuery` / `executeUpdate` / `execute` / `query` / `queryForList` / `update` 等调用的参数里出现「字面量 + 变量/调用」的二元表达式。只看 AST 上的 `binary_expression` 是否含 `identifier` / `method_invocation` / `field_access`，`"a" + "b"` 纯字面量拼接不报；`PreparedStatement` + `?` 占位符的反例不误报
- 新增 `AST_CROSS_ORIGIN_WILDCARD`：`@CrossOrigin(origins = "*")`、裸 `@CrossOrigin`（默认就是通配）、以及 `allowCredentials = true` 的组合（后者直接升为高危）
- 新增 `AST_SPEL_INJECTION`：`parseExpression` / `Ognl.getValue` 的参数不是字面量即报（变量、拼接、String.format 都算外部可控）
- 新增 `AST_RUNTIME_EXEC_CONCAT`：`Runtime.exec` 的参数非字面量、`new ProcessBuilder(..., "-c", ...)` 走 shell
- 每条规则都配正反例：新增 `ast-sql-string-concat`、`ast-crossorigin-wildcard`、`ast-spel-injection`、`ast-runtime-exec` 与反例集合 `ast-hardened-patterns`（预编译 SQL + 显式来源 + 字面量表达式 + 固定命令，四类均不得告警），矩阵扩到 **18 个用例，PASS 18 / GAP 0 / FAIL 0**
- 文档同步：`docs/RULES.md` 代码层补 4 行并写明新局限（SQL 只覆盖拼接结果直接进执行调用、变量中转会漏报；`@CrossOrigin` 不合并全局 CORS 配置），README 与配置项说明改为 7 条规则口径

## 0.19.0

**新增第六类扫描：AST 语义规则（`astgrep`），代码层不再只有字节码视角。**

- 接入 `@ast-grep/napi`（原生 napi）+ `@ast-grep/lang-java`（tree-sitter Java wasm），直接解析 Java 语法树，不依赖 Maven、不需要先编译
- 实现 3 条起步规则：
  - `AST_PERMIT_ALL_SENSITIVE_PATH`：`permitAll()` 覆盖 `/actuator`、`/admin`、`/druid`、`/swagger`、`/doc.html`、`/h2-console`、`/jolokia` 等敏感路径，或出现 `anyRequest().permitAll()`。判断只取**该调用链自己的**匹配器参数（`antMatchers` / `requestMatchers` 等），多行链式写法里 `.antMatchers("/x").hasRole(...)` 不会被同一语句里的敏感路径带偏（这条在第一版里误报过，已加反例用例锁住）
  - `AST_LOG_SENSITIVE_FIELD`：`log/logger.debug|info|warn|error(...)` 的参数里出现 password / token / secret / idcard / mobile 等敏感字段
  - `AST_UPLOAD_WITHOUT_VALIDATION`：`MultipartFile` 参数所在方法体内没有 `getSize()`、`getContentType`、扩展名白名单、`@Size` 等校验
- 引擎按平台打包：`scripts/fetch-astgrep.mjs` 把 Windows x64/arm64、macOS x64/arm64、Linux x64/arm64 六个平台的 napi 二进制补齐进 vsix（约 13.6 MB），用户侧无需额外下载；平台不匹配时该层以「已跳过」说明原因，其余扫描器不受影响
- 打包链路修正：此前 `vsce package --no-dependencies` 会把 `node_modules` 整个排除，导致装出来的扩展加载不到 AST 引擎；改为 `npm run package`（先补平台二进制再打包），GitHub Actions 同步改用该命令，`.vscodeignore` 增加 `!node_modules/@ast-grep/**` 并排除 `idea-plugin/`、`tools/`、`.quality-center/` 等无关目录
- `IssueSource` 扩为六值，面板新增「语义规则」Tab 与开关（面板内设置、快速模式均包含），新增配置项 `qualityCenter.astgrep.enabled`；`report.md` 分组、`summary` 计数、CLI `--only astgrep`、MCP `quality_scan` 枚举全部同步
- 规则靶场扩到 13 个用例（新增 permitAll 正例/反例、日志敏感字段、上传缺少校验），`npm run rules:matrix` = **PASS 13 / GAP 0 / FAIL 0**；`docs/RULES.md` 把代码层这 3 条从缺口改为已覆盖，并写明 AST 层局限（只解析 Java 源码、不解 Spring 装配、常量拼接路径会漏报）
- 文档：README 六类口径 + AST 章节与打包说明，`skills/` 三个 Skill 与 `manifest.json` 同步六类并补 `--only astgrep` 用法

## 0.18.0

**这是一个跨大版本的更新：从四类扫描扩到五类，新增插件内置的配置层安全扫描器 `qcsec`。**

- 新增第五类扫描器 **`qcsec`（配置安全）**：直接解析 `application*.yml / yaml / properties` 与 `bootstrap*.yml`，不依赖任何外部二进制，纯 Node 文本解析
- 实现 9 条配置层规则：
  - `SEC_DRUID_STATVIEW_DEFAULT_PASSWORD`：Druid 面板默认/弱口令（`admin` / `123456` 等），以及「面板已开启但没配口令」会回落默认口令的组合判断
  - `SEC_DRUID_STATVIEW_PUBLIC_BIND`：`stat-view-servlet.allow` 配成 `0.0.0.0` 或 `*`，等于把监控面板对全网开放
  - `SEC_JDBC_ALLOW_MULTI_QUERIES`：JDBC URL 打开 `allowMultiQueries=true`，SQL 注入可升级为堆叠执行
  - `SEC_ACTUATOR_EXPOSE_ALL`：`management.endpoints.web.exposure.include: "*"`，或单独开启 `env` / `heapdump` / `threaddump` / `jolokia` / `shutdown` / `configprops` / `restart`
  - `SEC_CORS_WILDCARD_WITH_CREDENTIALS` / `SEC_CORS_WILDCARD`：CORS 通配源，带不带凭证分别给高危与中危
  - `SEC_PLAINTEXT_PASSWORD_PROPERTY`：配置里直接写明文口令（`${ENV}` 占位视为已外部化）
  - `SEC_DEVTOOLS_ENABLED`、`SEC_SSL_DISABLED`
- 规则支持**跨键组合**判断：yml 拍平成「键路径 + 值 + 行号」后，能看出「面板 enabled 但没有 login-password」这类单行匹配发现不了的问题；yml 与 properties 两种写法都覆盖
- `IssueSource` 扩为五值（`checkstyle` / `gitleaks` / `trivy` / `spotbugs` / `qcsec`），并同步接入面板 Tab 与筛选、面板内设置与快速模式、`.vscode/settings.json` 的 `qualityCenter.qcsec.enabled`、`report.md` 分组、`AgentSafe`/`AgentPayload` 的 `summary`、CLI `--only`、MCP `quality_scan` 的枚举
- 规则靶场扩到 9 个用例：新增 `cors-wildcard-credentials`、`config-hardening-mixed`（devtools + SSL 关闭 + 口令已外部化的反例）。`npm run rules:matrix` 结果 **PASS 9 / GAP 0 / FAIL 0**，配置层从「4 个 GAP」全部转绿
- 修复 SpotBugs 结果缓存指纹仍写着 `findsecbugs-1.12.0`，升级到 1.14 后会命中旧缓存、看不到新增的 144 条安全规则；改为 `findsecbugs-1.14.0` 强制失效重扫
- 文档同步：README 改五类口径（功能、环境要求、配置项、CLI/MCP、扫描速度、面板内设置、规则覆盖度），`docs/RULES.md` 把配置层 8 条标为已覆盖、Swagger 保留缺口，`skills/` 三个 SKILL.md 与 `manifest.json` 更新为五类并给出 `--only qcsec` 用法

## 0.17.20

- **修复 FindSecBugs 从未生效**：`spotbugs-maven-plugin` 的 `plugins` 参数在 plugin.xml 里没有 userProperty，`-Dspotbugs.plugins=...` 传不进去，所以此前只跑了 SpotBugs 核心规则（144 个安全 pattern 全部空转）。实测：MD5 + `new Random()` 的探针只报 `DMI_RANDOM_USED_ONLY_ONCE`/`DM_DEFAULT_ENCODING`，pom 里配了 FindSecBugs 后才出现 `WEAK_MESSAGE_DIGEST_MD5`/`PREDICTABLE_RANDOM`
- 改为在项目根复制一份 `.qc-spotbugs-pom.xml` 注入 FindSecBugs（basedir 与 target 路径不变），`mvn -f` 运行后删除；项目自己已配 `findsecbugs` 时不改动原 pom；注入失败（非 Maven / 无 pom.xml）会作为扫描异常上报，不再静默降级
- FindSecBugs 升到 1.14.0（144 个 pattern，含 Spring `CorsRegistry` 的 `PERMISSIVE_CORS`、`SPRING_CSRF_PROTECTION_DISABLED`）
- 新增 `fixtures/` 规则靶场：7 个最小样例（CORS 正例/反例、CSRF 关闭、Druid 默认口令、Druid 加固、`allowMultiQueries`、Actuator 全暴露），每个带 `expect.json` 声明必须命中与禁止命中的规则
- 新增 `npm run rules:matrix`：跑真实扫描对比期望，输出 PASS / GAP / FAIL，编译失败也会显式列出；新增 `docs/RULES.md` 规则清单（CWE 映射 + 已覆盖/缺口 + 用例对应）
- 实测结果：代码层 3 个用例全部 PASS（`PERMISSIVE_CORS`、`SPRING_CSRF_PROTECTION_DISABLED` 均能命中，白名单写法不误报）；配置层 4 个用例为 GAP，确认当前没有任何扫描器覆盖 `application.yml`

## 0.17.19

- 新增 **MCP 服务端**（`out/cli.js mcp`，`npm run mcp`）：stdio + 换行分隔 JSON-RPC 2.0，零依赖，暴露 `quality_scan` / `quality_build` / `quality_tools_status` / `quality_tools_install` / `quality_report` / `quality_fix` 六个工具，agent 可直接以工具调用方式跑扫描与修复，不必记 CLI 参数
- MCP 请求串行处理：避免并发拉起多份 mvn / trivy，stdin 关闭时等所有请求收尾再退出；stdout 只放协议消息，日志全走 stderr
- CLI 新增 `fix` 子命令：应用四条确定性修复规则（`UnusedImports` / `RedundantImport` / `ModifierOrder` / `SimplifyBooleanExpression`），默认只预览并列出「文件 + 行号 + 规则」，`--write` 才落盘
- 抽出 `src/fixerCore.ts`：确定性修复变成纯函数（`planLineFix` / `applyFixesToContent`），IDE 面板的「一键修复」与 CLI/MCP 共用同一份规则实现，不再各自维护；删除类规则只删真正的 `import` 行，行号漂移时宁可不改
- 抽出 `src/agentOps.ts`：扫描 / 构建 / 工具安装 / 报告 / 修复统一成返回纯数据的操作层，CLI 与 MCP 共用，避免两套实现行为分叉
- 新增 `quality-center-mcp` Skill（MCP 配置样例、工具语义与调用顺序），`skills/manifest.json` 增加 MCP 工具清单，README 补充 MCP 接入章节

## 0.17.18

- 新增无界面 CLI（`out/cli.js`，`npm run agent`）：`scan` / `build` / `tools status` / `tools install` / `report`，用同一套扫描器、同一份基线，可在纯 Node 环境与 CI 中运行，不依赖 vscode API
- CLI 输出契约固定：stdout 只放结果，进度与日志走 stderr；`--json` 输出 `AgentPayload`（`schemaVersion: "2"`，含 summary / issues / ignored / suggestions / skipped / missingTools / nextActions，问题带相对路径与绝对路径、`fixable`、CVE 修复版本）；退出码 `0` 通过、`1` 有达到阈值的问题（`--fail-on` 默认 high）、`2` 工具缺失或执行失败、`3` 用法错误
- 新增 `skills/` agent 接口包：`quality-center-scan`、`quality-center-tools`、`quality-center-dependencies` 三个 Skill，外加 `manifest.json`（CLI 入口、命令、退出码、Skill 列表）与 README
- `.quality-center/issues.json` 与 CLI 输出统一加上 `schemaVersion`，作为稳定的 agent 契约
- `src/maven.ts` 与 vscode 解耦：编辑器内读用户设置，纯 Node 环境下按默认值走国内镜像，使 CLI 能复用完全相同的 Maven 行为
- README 新增「给 AI agent 的接口（CLI + Skills）」章节：命令、退出码、输出结构、Skill 触发场景

## 0.17.17

- 安装与构建改为流式执行：不再等命令跑完才拿结果，边跑边读输出，通知栏与面板顶部实时显示当前阶段（下载 / 解压 / 校验、模块 / 阶段）和已用时间，下载时显示百分比
- 安装与构建都可取消：点通知栏取消会结束整棵进程树，并提示「已取消（用时 N 秒）」，不再需要等超时
- 结束反馈补齐：安装成功提示路径与用时，失败提示退出码、用时、末尾输出并提供「查看日志 / 安装文档」；构建成功报出 `target` 下生成的 jar 与耗时，失败给出末尾 6 行原因（含超时判断）
- 修复便携安装在这台机器上「点下去没反应」：Maven 官方源实测只有 8 KB/s，脚本改为华为云镜像优先、Maven Central 与 Apache archive 兜底；下载改用系统自带 `curl.exe`（带重试、连接超时与单文件上限），慢源失败会立刻换下一个源并说明原因，不再挂满 10 分钟
- 修复 PowerShell 安装脚本在中文环境下解析失败：`.ps1` 以 UTF-8 BOM 写入，并在脚本内设置 `[Console]::OutputEncoding`，中文进度标记不再乱码
- 构建前先解析 `mvn`：找不到时直接提示「去安装 Maven / 安装文档」，而不是跑来一句构建失败
- 错误详情进一步去噪：`curl` / `winget` 的进度条与纯百分比行不再占据「失败原因」的最后几行
- GitHub Actions 升级到 Node 24 运行时：`checkout@v5`、`setup-node@v5`（Node 22）、`upload-artifact@v6`、`softprops/action-gh-release@v3`，消除 `Node.js 20 actions are deprecated` 警告

## 0.17.16

- 新增 `scripts/release.mjs` 一键发版（`npm run release`）：校验工作区干净 / 分支为 main / tag 未占用 → bump `package.json` 与 lock → 补 `CHANGELOG.md` 段落（已有则复用，缺则用上个 tag 以来的提交生成）→ `tsc` 与 `vsce package` 双校验 → commit + tag `v<version>` + push → `gh release create` 触发 `publish.yml` → 轮询 Actions 结果并确认 Open VSX `latest` 已指向新版本
- 发版脚本支持 `--dry-run`（只打印计划）/ `--no-wait`（不等 Actions）/ `--no-verify`（不等线上校验）/ `--branch`，校验或编译失败即中止，不会留下半成品提交
- 新增发版前的文档闸门：校验 README 是否覆盖 `package.json` 中全部 28 个配置项与 7 条命令、是否残留写死的 vsix 版本号、`description` 是否为空或超长，不达标直接拒绝发版（临时可 `--skip-docs`）
- README 补齐遗漏：命令表 4 条补到 7 条，配置表补 `qualityCenter.exportForAgent`，安装示例改用 `<version>` 占位，合并重复且过期的「发布」章节
- 明确文档与商店页的关系：`README.md` 随 vsix 一起打包，Open VSX / VS Code 市场展示的扩展介绍页正文就是该文件，因此每次发版必须同步更新

## 0.17.15

- 新增 `scripts/install.mjs` 跨平台一键安装脚本（Windows / macOS / Linux）：自动识别 Trae CN、Trae、Cursor、VS Code、VSCodium 的 CLI 与安装路径（优先 Trae CN），自动挑选最新 vsix 并 `--install-extension --force` 安装，`--build` 可先编译打包
- 外部工具的一键安装改为按系统自动选择：Windows `winget` → Chocolatey → Scoop → 官方产物便携安装；macOS `Homebrew` → 官方产物便携安装；Linux `Homebrew` → 官方产物便携安装（无需 sudo，`apt/dnf/pacman` 作为备用命令展示）
- 便携安装不写系统 PATH：Windows 落在 `%LOCALAPPDATA%\quality-center\tools`，macOS / Linux 落在 `~/.quality-center/tools`，`resolveBinary` 会自动搜索该目录；Maven 在 winget 源里没有官方包，改为下载 `apache-maven-3.9.9` 便携版，解决「有 JDK 却没有 mvn」导致的 SpotBugs 跳过
- 需要 sudo 的发行版安装不代跑，改为把命令复制到剪贴板并在终端手动执行，避免卡在密码输入
- 缺失外部工具不再静默跳过：扫描结束后弹出提示，提供「去安装」，装完自动重新扫描；面板底部「已跳过」提示行增加「安装」入口
- 新增配置 `qualityCenter.notifyMissingTools`（默认 true），提示过的工具在本次会话内不再重复弹窗，也能选「不再提示」整体关闭
- Maven 缺失单独识别：扫描前统一用 `resolveBinary('mvn')` 解析，找不到就直接提示而不是让 Checkstyle / SpotBugs 各跑一次失败的命令；解析到的绝对路径会传给扫描器，规避 IDE 先于工具安装启动导致的 PATH 过期
- 工具定位不再只依赖 `where` / `which`：先按 PATH 自己扫一遍（含 PATHEXT 兜底），再退回 shell 查找；`winget.exe` 这类「应用执行别名」用目录项兜底识别，避免误判为未安装
- 过滤 JVM 噪声：`Picked up JAVA_TOOL_OPTIONS: ...`、`OpenJDK 64-Bit Server VM warning` 等日志不再顶掉真正的错误详情，Checkstyle / SpotBugs / Gitleaks / Trivy 的错误只保留最后几行有效输出
- SpotBugs / Checkstyle 未生成报告时给出可操作的原因（超时、插件拉取失败、mvn 不在 PATH）和复现命令
- Gitleaks / Trivy 能定位到文件但执行失败（架构不匹配、被拦截等）时按「运行错误」上报，不再误报成「未安装」

## 0.17.14

- Trivy 漏洞库更新改为在扫描结束后后台进行（上限 10 分钟）：国内镜像本身可达，但漏洞库约 1.8GB、下载需数分钟，放到后台后扫描不再等待，下次扫描自动使用新库

## 0.17.13

- 修复代码检查长时间无法完成的问题：命令执行到超时时间后直接结束整棵进程树并立即返回，不再因为 mvn / trivy 子进程继续存活、占住输出流而卡死
- Trivy 漏洞库更新改为扫描前限时（90 秒）执行，失败就直接用本地库离线扫描；同一会话 6 小时内不再重复尝试，避免每次扫描都被网络阻塞

## 0.17.12

- 修复任务结束瞬间进度条只显示一半就消失的问题：完成时先把蓝色填充补满 100%，停留约 0.7 秒让用户看到完成状态，再逐只淡出猫咪并收起进度条

## 0.17.11

- 修复猫咪跑到右端时被可见「拉回」左侧的问题：奔跑改由 requestAnimationFrame 逐帧推进，猫队完整跑出右侧后瞬时回到左侧重新进入，不再出现倒拉动效

## 0.17.10

- 修复「第 1/3 步」时蓝条只有一小块的问题：进度改为按当前步骤号计算（第 1/3 步 = 33%，第 2/3 步 = 66%）
- 猫咪改为从左边缘进入后向右奔跑，不再在起点淡入浮现；跑到右端后从左侧重新进入

## 0.17.9

- 修复点击开始后猫咪要等一会儿才出现的问题：奔跑动画改为从最左侧起点开始，并在任务开始时强制重启动画，猫咪立刻出现在起始位置
- 跑到右端后淡出、从左侧重新淡入，避免瞬移

## 0.17.8

- 猫咪恢复全程循环奔跑：猫队从左侧持续跑向右侧（5.2s 一轮），不再停在左端
- 蓝色填充独立表示完成度（扫描器/阶段），与猫咪奔跑互不干扰；阶段完成时仍会减少一只猫

## 0.17.7

- 修复蓝色进度条不反映进度的问题：此前动画改的是填充块的 `left`，导致蓝色段在整个轨道上“游走”；现在填充块固定在左侧、宽度按真实进度延伸，高光在填充内部单独流动
- 猫咪增加持续奔跑动作（前后 5px 轻微移动 + 上下 6px 跳跃，逐只错开延迟），长时间阶段不再看起来静止不动

## 0.17.6

- 猫咪与进度条同步：猫队右边缘贴住蓝色填充前沿，随进度平滑右移（0.35s 过渡），不再独立循环奔跑
- 恢复猫咪 24px、轨道 11px 的尺寸，不再用缩小元素来回避对齐问题

## 0.17.5

- 修复任务结束时剩余猫咪同时消失的问题：任务结束后猫咪按 100ms 间隔逐只淡出，再收起进度条
- 深度修复阶段与实际步骤对齐：预演为「运行配方 → 生成修复补丁 → 整理预览」，应用为「备份改动 → 运行配方 → 收集改动 → 校验编译」

## 0.17.4

- 猫咪改为站在进度条轨道上（脚底贴轨道上沿），不再悬在轨道上方
- 进度条蓝色填充改为反映真实进度：扫描按扫描器数量，深度修复与依赖升级按阶段数，不再固定 34%

## 0.17.3

- 猫咪改为沿进度条从左向右奔跑（不再固定在中间），完成阶段时对应猫咪消失
- 猫头改为圆角方形脸，外耳深色、内耳粉色，方形轮廓下耳朵依然清晰
- 深度修复展示多阶段猫咪：预演/备份 → 运行配方 → 收集改动 → 校验编译，顶部显示「第 N/M 步」
- 依赖升级也显示进度条与猫咪：解析依赖树 → 对齐 BOM 版本；应用时 写入 pom → 校验编译

## 0.17.2

- 猫咪头像从 emoji 改为内联 SVG，内置 10 种品种：橘猫、狸花猫、奶牛猫、黑猫、白猫、三花猫、暹罗猫、蓝猫、银渐层、玳瑁猫
- 统一圆脸、三角耳、高光眼睛的扁平风格，深色主题下黑猫也保持清晰轮廓；22px 进度条尺寸下仍可区分品种

## 0.17.1

- 猫咪进度条改为按任务数展示：N 个待执行项对应 N 只不同品种/颜色的猫咪，每完成一项减少一只；暂停扫描时猫咪同步暂停
- 深度修复阶段没有分项进度，保留一只猫咪

## 0.17.0

- 新增「显示全部可用配方」：通过 `rewrite-maven-plugin:discover -Ddetail=true` 列出类路径上的全部 OpenRewrite 配方（约 1400 个），并带上官方 displayName 与 description
  - 新增配方不再需要升级插件；开启后可在设置里搜索、按风险分组勾选
  - 风险按 id 启发式分级：迁移、测试、删除/依赖变更类为高风险，其余为需确认的中风险
  - discover 结果按插件生命周期缓存，首次约 10 秒，可在设置中关闭
  - 设置面板新增配方搜索框，勾选状态在筛选时不会丢失
- 配置新增 `qualityCenter.openRewrite.showAllRecipes`（默认关闭）

## 0.16.1

- 深度修复配方按项目画像动态过滤，避免展示不适用配方：
  - Spring Boot 迁移仅在检测到对应 Spring Boot 版本时出现（2.7：2.x < 2.7；3.0：Spring Boot 2.x 且 Java ≥ 17）
  - Java 升级配方仅在当前 Java 版本低于目标时出现（Java 8 → 11、Java 11–16 → 17）
  - JUnit 4 → 5 迁移仅在检测到 JUnit 4 时出现
  - 设置弹窗显示「已按当前项目过滤：Java 8 · Spring Boot 2.4.2 · JUnit 4」
- 配方库从 6 个扩充到 19 个：低风险 8 个、中风险 6 个、高风险 5 个；`rewrite-maven-plugin` 统一为 6.0.5，配方包统一基于 rewrite 8.44.1，混选不会出现类路径冲突
- 项目画像新增 JUnit 版本识别

## 0.16.0

- 深度修复配方改为「插件内置配方库 + 面板设置里按风险分组勾选」，不再需要用户自己查 Maven 坐标：
  - 新增 `qualityCenter.openRewrite.autoRecipes`（默认开启），自动启用低风险配方（清理无用导入、简化布尔表达式、去除多余括号等）
  - 设置弹窗新增「深度修复配方」区块：低风险自动启用并置灰，高风险（如 Spring Boot 2.7 代码迁移）需手动勾选
  - 配方所需依赖包随选中配方自动带入，插件版本按配方兼容性自动选择
- 依赖升级预览补充版本来源与联动关系：
  - 每个升级项标注当前版本来源（父 POM / 导入的 BOM / pom 直接声明 / 传递依赖）
  - 升级 BOM 或父 POM 时列出会被一并解决的子依赖；显式写了版本的依赖不会被 BOM 升级覆盖，仍单独提示
  - 展示依赖树中的版本冲突（其它分支选择的版本、被 BOM 调整的声明），多个可选版本时在预览里直接下拉选择
- 新增 Spring Boot 升级支持：2.x（<2.7）可一键升级到 2.7.18，同时处理显式固定的 `spring-boot-maven-plugin` 版本；升级并通过编译后可继续执行 rewrite-spring 代码级迁移（高风险，需确认）
- 写回 pom 统一遵循「版本抽离」标准：硬编码版本、传依赖覆盖、属性多处共用等情况都会抽离为 `<artifactId>.version` 属性，`<properties>` 中统一管理

## 0.15.1

- 修复深度修复预览里中文注释显示为乱码：OpenRewrite 用 JVM 默认字符集读写源码，Windows 上默认编码可能不是 UTF-8，现在会按项目源码编码启动 Maven，补丁中的中文可正常显示
- 预演补丁若仍含无法解码的字符，会直接拦截并提示，避免把乱码写回源码
- 内置静态分析配方库 `org.openrewrite.recipe:rewrite-static-analysis`，无需再手动配置 `openRewrite.recipeArtifacts`
- 配方推荐文案改为说明配方库已内置，只需把配方加入白名单

## 0.15.0

- 依赖升级不再只支持「显式声明版本」的依赖：
  - 由 BOM / 父 POM 管理版本的依赖，可直接补一个显式 `<version>` 固定版本；
  - 传递依赖通过写入 `<dependencyManagement>` 覆盖实际解析版本；
  - 版本属性被多处引用时，改为只固定当前依赖，不再整项跳过
- 升级预览页按「直接依赖 / 版本覆盖」分组，每项标注写回方式
- 未纳入自动升级的项改为按原因折叠分组，避免一长串重复说明
- 新增 `dependencyManagement` 或版本标签时保持 pom 原有缩进

## 0.14.0

- 深度修复预演结果会缓存：关闭预览页签后再次点击「深度修复」，直接复用上次 dry-run 结果并重新打开预览，不再重新扫描
  - 缓存键包含 HEAD、工作区改动、配方与插件版本，任一变化都会自动重新预演
  - 应用修复后缓存自动失效
- 依赖升级改为与深度修复一致的预览页：每个依赖展示 pom 中被替换的行（红删绿增）与覆盖漏洞数，勾选后升级
  - 关闭页签或点「取消」不改动任何文件；BOM 管理、传递依赖等跳过原因在预览页底部列出
  - 升级后仍执行 `mvn compile` 门禁，失败回滚 pom
- 深度修复与依赖升级共用同一个预览窗口守卫，避免同时打开多个预览

## 0.13.0

- 深度修复改为打开独立的预览编辑器页：左侧文件列表，右侧逐行 diff（新增/删除/上下文着色）
- 预览页是普通编辑器页签，点击其他位置或切换文件不会关闭，可以慢慢比对；关闭页签或点「取消」才放弃
- 预览页内直接勾选要应用的文件，底部显示已选数量，点「应用选中文件」才真正执行，不再需要预先在弹窗里做选择
- 去掉原来的确认模态框与「查看修复预览」跳转；未开启预演时仍保留确认弹窗作为兜底
- 预览打开期间禁止重复发起深度修复，避免多个预览页互相覆盖

## 0.12.6

- 设置弹窗：快速模式 / 完整模式增加悬停、按下与选中态反馈，选中的模式高亮显示
- 设置按钮由「应用并扫描」改为「保存」，保存后不再自动触发扫描，下次扫描生效
- 问题列表的分组标题（如「密钥泄露 (14)」）可点击折叠 / 展开，折叠状态跨刷新保留
- 优化深度修复（扳手）与升级依赖（上传箭头）图标，语义更清晰
- 修复扫描过程中列表刷新导致滚动位置跳回顶部的问题

## 0.12.5

- 工具栏改为图标按钮（悬停有提示），窄侧边栏也能一行放下全部操作
- 新增扫描控制：开始 / 暂停 / 继续 / 终止
  - 暂停在扫描器边界生效：当前扫描器跑完后不再启动新的，继续时接着跑剩余扫描器
  - 终止会立即结束 Maven、Trivy、Gitleaks 进程树，已完成的扫描器结果保留
  - 暂停同时会暂停保存触发的自动扫描，点继续恢复
- Tab 改为紧凑四列栅格，窄面板下自动省略文字
- 工具栏、进度条、统计、Tab、搜索框固定在顶部，只有问题列表滚动

## 0.12.4

- 远程源默认改用国内可达镜像，避免联网阻塞：
  - Maven：用户没有 `~/.m2/settings.xml` 时自动使用阿里云公共仓库镜像；已有 settings.xml 时不覆盖，避免影响企业私服与代理
  - Trivy：漏洞库与 Java 索引库默认使用 daocloud 镜像
- 两类镜像都可在设置中改回官方源：`maven.useChinaMirror`、`trivy.dbRepository` / `trivy.javaDbRepository`

## 0.12.3

- 修复 Trivy 可能卡住数分钟的问题：本地漏洞库 12 小时内下载过时直接跳过更新检查
- 未显式配置仓库时默认走 daocloud 镜像，不再先等 ghcr.io 超时再回退；可用 `trivy.preferMirror` 关闭
- Trivy 内部超时从 15 分钟收紧到 4 分钟，外层进程超时 5 分钟，失败时给出网络类错误的明确提示
- 依赖漏洞结果缓存每天失效一次，确保漏洞库更新后能发现新 CVE
- 实测：库新鲜时 Trivy 约 3 秒；库过期时首次更新约 90 秒

## 0.12.2

- 扫描进度只保留在顶部猫咪进度条，去掉统计行与列表中的重复进度数字
- 工具栏新增「设置」：可勾选代码质量 / 密钥泄露 / 依赖漏洞 / 静态缺陷，切换快速模式与完整模式，控制保存时自动扫描
- 设置应用后立即重新扫描；若当前正在扫描则提示「结束后生效」
- 面板内设置写入工作区 `.vscode/settings.json`，与扩展设置项保持一致

## 0.12.1

- 扫描中显示实时进度：当前运行的扫描器、已完成 x/4、已用 N 秒，每秒刷新
- 猫咪进度条由无限滚动改为按扫描器完成比例填充
- 扫描器逐个完成时立即更新进度，Maven 扫描较慢时能明确看到是在跑 SpotBugs 还是 Checkstyle
- SpotBugs 超时由 10 分钟收紧到 4 分钟，异常时不会长期停留在「扫描中」

## 0.12.0

- 扫描提速：SpotBugs / Checkstyle / Trivy 按文件指纹复用结果，源码或字节码未变化时不再启动 Maven 或 trivy
  - 只改 Java 时保存后约 14 秒（原先约 35 秒）
  - 只改配置时约 1~2 秒
- 上次扫描结果与扫描器缓存持久化，重开 IDE 后打开面板立即显示旧结果，后台再刷新
- 保存文件触发扫描时只响应 java/xml/properties/yml/toml/json 等可能影响结果的文件，并忽略 target、node_modules 等目录

## 0.11.1

- 修复 Tab 栏在窄侧边栏下最右侧被裁剪：改为自动换行，全部页签始终可见
- 修复「进行中」状态挤压严重等级筛选行：进度只保留在顶部猫咪进度条，等级行只显示统计
- 深度修复期间禁用扫描/修复/升级按钮，隐藏可修复条与构建提示，避免误操作与信息堆叠
- 精简深度修复确认弹窗：标题单行展示，文件清单、项目画像、配方说明收进详情区

## 0.11.0

- 深度修复支持按文件选择性应用：dry-run 预演后勾选要应用的文件，未勾选的文件会在修复后自动恢复原样
- 恢复时区分已跟踪文件与配方新建文件：前者从修复前快照 checkout，后者直接删除，不影响未提交改动
- 选择性应用后重新统计实际改动文件，再执行编译门禁
- 新增开关：`dependencyUpgrade.enabled` 控制是否显示「升级依赖」，`openRewrite.fileSelection` 控制是否弹出文件勾选

## 0.10.0

- 新增「升级依赖」：把 CVE 的修复版本直接写入 pom，一键消除依赖漏洞
- 只处理 pom 中显式声明版本的直接依赖；BOM 管理的依赖、传递依赖会列出跳过原因，不做猜测性修改
- 支持版本写成 `${xxx}` 的情况：属性只被该依赖引用时修改属性值，被多处引用时跳过并提示
- 升级前可多选依赖，升级后自动执行 `mvn -DskipTests compile` 门禁；编译失败自动还原 pom.xml
- CVE 详情新增「升级此依赖」，可直接针对单个组件升级

## 0.9.0

- 新增 SpotBugs + FindSecBugs 字节码级静态缺陷扫描：检测空指针、资源泄漏、可变对象暴露，以及 SQL 注入、命令注入、XSS、路径穿越、响应头注入等安全 sink
- 新增「静态缺陷」Tab，按严重度排序；安全类问题自动升级严重等级，并展示缺陷类别与 CWE
- 内置常见缺陷类型的中文说明与修复建议，未收录类型按类别回退，保证不出现空白
- 未构建（缺少 `target/classes`）时自动跳过，并复用「构建并扫描」入口；面板与 AI 导出同步新增该类问题

## 0.8.0

- 深度修复新增 dry-run 预演：先展示将改动的文件列表，可打开补丁查看，再决定是否执行；可在设置中关闭
- 新增问题级深度修复：Checkstyle 规则映射到 OpenRewrite 配方，单条问题即可运行对应配方
- 新增本地基线/忽略：面板增加「已忽略」Tab，支持忽略与恢复；忽略项不计入统计、建议与 AI 导出
- 忽略记录保存在 `.quality-center/baseline.json`，按稳定指纹匹配，代码移动不会失效

## 0.7.1

- 深度修复自动解析项目根 `pom.xml`，识别 Java 与 Spring Boot 版本
- 确认弹窗展示项目画像与推荐配方（静态分析、Spring Boot 升级评估），标注风险等级
- 推荐内容仅展示、不自动启用，并同步写入「质量中心」输出日志

## 0.7.0

- 深度修复改为「临时备份 + 原地改写」：不再 `git stash`，从根本上消除先一键修复再深度修复时的 stash 恢复冲突
- 回滚时先恢复代码到 HEAD，再应用备份补丁，未提交改动与未跟踪文件都能完整还原
- 默认配方扩展到 3 个：清理无用导入、`Objects.isNull` 改写、缩短全限定类名，确认弹窗展示每个配方的中文用途
- 修复改动统计改为与修复前快照对比，不再把用户已有的未提交改动算进去

## 0.6.2

- 猫咪改为 🐱 头像，去掉镜像翻转，各平台朝向一致
- 修复系统「减少动态效果」导致猫咪静止的问题：扫描与深度修复期间始终播放从左到右的波动动画
- 进度光带改为平滑渐变，速度与猫咪奔跑同步

## 0.6.1

- 深度修复复用猫咪进度条，实时显示当前阶段（备份改动 / 运行配方 / 校验编译 / 恢复改动）与已用秒数
- 深度修复期间暂停自动扫描，避免扫描到改写过程中的半成品代码
- stash 恢复冲突时列出具体冲突文件，可一键打开冲突文件或源代码管理
- 新增「放弃本次修复并恢复我的改动」，一键回到修复前并恢复未提交代码
- 深度修复全流程写入「质量中心」输出日志，失败时可点「查看日志」定位

## 0.6.0

- 扫描期间在面板顶部显示猫咪奔跑进度条：条纹流动 + 猫咪往返奔跑，扫描结束自动隐藏
- 适配系统「减少动态效果」偏好（prefers-reduced-motion）

## 0.5.2

- 深度修复不再要求工作区干净：检测到未提交改动时自动 `git stash --include-untracked` 备份，结束后恢复
- 回滚只撤销本次修复改动，不会丢失用户未提交的代码；恢复冲突时改动仍保留在 stash 中
- OpenRewrite 执行失败时自动撤销本次产生的改动并恢复备份

## 0.5.1

- 新增 `openRewrite.recipeArtifacts`：通过 `-Drewrite.recipeArtifactCoordinates` 加载额外配方包（如 `rewrite-static-analysis`），仍无需修改项目 pom
- 此前白名单只能使用 `rewrite-maven-plugin` 自带配方，现在可扩展到 OpenRewrite 静态分析配方库

## 0.5.0

- 新增「深度修复」：调用 OpenRewrite 社区配方做编译级重构，默认执行 `org.openrewrite.java.RemoveUnusedImports`
- 零 pom 侵入：以全限定坐标临时调用 `rewrite-maven-plugin`，不修改项目构建文件；默认只允许插件类路径自带的配方
- 安全护栏：要求工作区无未提交改动；修复后自动执行 `mvn compile` 门禁，失败可一键回滚
- 新增配置：`openRewrite.enabled`、`openRewrite.recipes`、`openRewrite.pluginVersion`、`openRewrite.compileGate`

## 0.4.5

- 一键修复支持布尔表达式简化：`false == x`、`x != true` 等改为等价写法（含 `!` 取反与双否定合并）
- 含字符串字面量或注释的行保守跳过，避免误改

## 0.4.4

- 严重度筛选改为多选，可同时勾选多个等级
- 增加「✕ 清除等级」快捷入口
- 空结果提示会列出当前已选等级

## 0.4.3

- 顶部严重度标签支持点击筛选（严重/高危/中危/低危），与标签页、搜索框可叠加使用
- 再次点击当前等级可取消筛选；统计显示为「共 X / N 项」
- 筛选后无结果时提示如何取消

## 0.4.2

- 修复展开详情抢占点击跳转的问题：点击条目恢复跳转到对应代码行，详情改由「详情」按钮展开
- CVE 条目没有代码位置，点击条目仍直接展开详情

## 0.4.1

- 代码质量问题补充中文说明与修复建议（覆盖 UnusedImports、ModifierOrder、SimplifyBooleanExpression 等常用规则，并对常见英文消息做中文替换）
- 密钥泄露问题补充中文类型与处置建议（API Key、私钥、云凭证、各类 Token、口令等）
- 三类问题的条目均可点击展开详情，展示中文说明、修复建议与原始信息
- report.md 中代码质量与密钥条目改用中文，并附修复建议

## 0.4.0

- CVE 列表改为展示中文摘要（组件、版本、CVSS、攻击向量、权限要求、影响面均由结构化字段生成，不依赖翻译服务）
- CVE 条目支持点击展开详情：影响组件、修复版本、CVSS/CWE、披露时间、修复建议、英文原文、参考链接
- 详情内可一键「打开漏洞库」「复制详情给 AI」（复制内容已含中文摘要与修复建议）
- issues.json 增加 zhSummary / advice / cvss / cwe 等字段

## 0.3.1

- 无可用构建产物时在面板给出提示，并提供「构建并扫描」按钮（执行 mvn package 后自动复扫）
- 后台扫描期间保留上一次结果继续展示，扫描完成后才覆盖，不再闪空白
- issues.json 增加 buildHint 字段

## 0.3.0

- 新增「修复建议」标签页：从扫描结果推导根因级行动方案（框架升级、依赖覆盖、密钥治理、人工处理）
  - 自动识别 pom.xml 中的 Spring Boot 版本，给出升级目标版本与影响范围
  - 按组件聚合 CVE，给出建议升级到的版本
  - 建议可单独复制给 AI
- Checkstyle 内置默认规则集：项目无自定义配置时自动使用，不再出现「未找到规则文件」而跳过
- Trivy 源码模式改用 `--offline-scan`，不再联网解析 pom，彻底避免 Maven 中央仓库 429 限流
- 429 限流错误改为可读的中文提示，且不再做无意义的重试
- issues.json / report.md 同步包含修复建议

## 0.2.1

- Checkstyle 等级按规则语义映射：无用导入/修饰符顺序等卫生问题降为低危，不再虚标高危
- CVE 扫描新增过滤：默认只显示有修复版本的漏洞，可配置最低等级阈值（trivy.minSeverity）
- CVE 按「漏洞编号 + 组件 + 版本」去重
- 支持项目根目录 `.trivyignore` 忽略清单（trivy 自动加载）

## 0.2.0

- 新增一键修复：删除无用导入、删除冗余导入、按 JLS 顺序重排修饰符
- 面板顶部展示可修复数量，支持整批修复或单条修复，修复后自动重扫
- 新增命令 `质量中心：自动修复可确定性问题`

## 0.1.3

- 「AI 可读取」提示移到统计栏右侧，改为紧凑的「AI 数据」按钮，点击直接打开 issues.json
- 列表上方只保留扫描异常与跳过原因，减少视觉噪音

## 0.1.2

- 面板顶部改为标签页切换：全部 / 代码质量 / 密钥泄露 / 依赖漏洞，标签上直接显示各类数量
- 替代原先的勾选框筛选，切换更直观

## 0.1.1

- 修复 IDE 进程 PATH 过期导致 Gitleaks / Trivy 被误判为未安装的问题，新增常见安装目录回退查找
- 每条问题新增「复制」按钮，支持只复制单条问题给 AI
- 新增 AI 可读结果文件：`.quality-center/issues.json` 与 `report.md`，每轮扫描后自动更新
- 跳过原因与扫描异常提示移动到列表上方，便于发现

## 0.1.0

首个版本：

- 聚合 Checkstyle（代码质量）、Gitleaks（密钥泄露）、Trivy（依赖漏洞 CVE）三类扫描
- 侧边栏统一面板，支持按来源筛选与关键字搜索
- 打开项目自动扫描、保存文件后自动增量扫描
- 一键复制为 Markdown，或导出报告文件
- 点击问题跳转到对应代码行
