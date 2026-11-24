# 安全规则清单与缺口

这份清单是"能力边界"的唯一事实来源：每条规则要么有扫描器在跑并有 fixture 回归，要么明确标成缺口。
新增规则必须先在这里立项、再补 fixture，矩阵转绿才算完成。

## 覆盖口径

- **代码层**（Java 源码 / 字节码）：由 `SpotBugs + FindSecBugs 1.14`（144 个 pattern）承担，`PERMISSIVE_CORS`、`SPRING_CSRF_*` 等由字节码 + Spring 语义检测。
- **配置层**（`application.yml` / `.properties`）：**目前没有任何扫描器覆盖**，这是已知的大缺口，计划由 `qcsec` 承担。
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
| `permitAll()` 打到 actuator / admin 路径 | 284 | 无 | **缺口**（Semgrep 社区规则可移植） | 待补 |
| 日志打印口令 / 令牌等敏感字段 | 532 | 无 | **缺口** | 待补 |
| 文件上传未校验类型与大小 | 434 | 无 | **缺口** | 待补 |

## 配置层（缺口，计划由 `qcsec` 承担）

| 风险 | CWE | 目标规则 ID | 状态 | 用例 |
| --- | --- | --- | --- | --- |
| CORS 在 yml 里配成任意源（`cors.allowed-origins: *` 且允许凭证） | 942 | `SEC_CORS_WILDCARD_WITH_CREDENTIALS` | 缺口 | 待补 |
| Druid stat-view 使用默认口令 `admin/123456` | 1392 | `SEC_DRUID_STATVIEW_DEFAULT_PASSWORD` | 缺口 | `druid-statview-default` |
| Druid stat-view 绑定 `0.0.0.0` / 对外暴露 | 668 | `SEC_DRUID_STATVIEW_PUBLIC_BIND` | 缺口 | `druid-statview-default` |
| JDBC URL 打开 `allowMultiQueries=true`（注入可堆叠执行） | 89 | `SEC_JDBC_ALLOW_MULTI_QUERIES` | 缺口 | `jdbc-allow-multi-queries` |
| Actuator 全端点暴露（含 `env` / `heapdump`） | 497 | `SEC_ACTUATOR_EXPOSE_ALL` | 缺口 | `actuator-expose-all` |
| Swagger / knife4j 在生产环境开放 | 200 | `SEC_SWAGGER_PUBLIC` | 缺口 | 待补 |
| `spring.devtools` 在生产启用 | 489 | `SEC_DEVTOOLS_ENABLED` | 缺口 | 待补 |
| 配置文件里明文口令（非 `${...}` 占位） | 798 | `SEC_PLAINTEXT_PASSWORD_PROPERTY` | 缺口 | 待补 |
| 关闭 HTTPS / `server.ssl.enabled: false` | 319 | `SEC_SSL_DISABLED` | 缺口 | 待补 |

## 接线现状与局限

FindSecBugs 必须写进 pom 的 `<build><plugins>` 才生效（`spotbugs-maven-plugin` 的 `plugins` 参数没有 userProperty，`-Dspotbugs.plugins` 传不进去）。插件现在的做法：

1. 项目 pom 里已经出现 `findsecbugs` → 尊重用户配置，直接用原 pom；
2. 否则复制一份到项目根 `.qc-spotbugs-pom.xml`，注入 FindSecBugs 1.14 后 `mvn -f` 运行，结束后删除；
3. 注入失败（没 pom.xml / 不是 Maven 工程）→ 只跑 SpotBugs 核心规则，并把原因作为"扫描异常"上报，不静默降级。

已知局限：

- **多模块工程**：只注入根 pom，SpotBugs 在子模块上运行时不会带上 FindSecBugs（后续计划改用 SpotBugs 独立发行版 + `-pluginList` 解决）。
- 需要 `target/classes`（或先执行构建），否则 SpotBugs 直接跳过。
- 配置层（yml / properties）没有任何扫描器，所以上面 9 条配置类风险目前一律检不出。
