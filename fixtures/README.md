# 规则覆盖矩阵（fixtures）

每个子目录是一个最小可复现样例，`expect.json` 声明：

| 字段 | 含义 |
| --- | --- |
| `layer` | `code`（Java 源码 / 字节码）或 `config`（yml、properties） |
| `scanners` | 评估本用例要跑哪些扫描器；空数组表示该层暂无扫描器 |
| `requiresBuild` | 是否需要先 `mvn compile` 才有字节码 |
| `expect.mustFire` | 必须命中的规则 ID |
| `expect.mustNotFire` | 禁止命中的规则 ID（防误报） |
| `target.rules` | 目标规则 ID（可能来自尚未实现的 `qcsec`） |
| `target.owner` | `findsecbugs` / `trivy` / `qcsec` |
| `target.status` | `covered` 已覆盖；`gap` 尚未实现 |

## 跑矩阵

```bash
npm run compile && npm run rules:matrix
npm run rules:matrix -- cors        # 只跑 id 含 cors 的用例
npm run rules:matrix -- --no-build  # 不自动编译
```

输出里 `PASS` 表示与期望一致，`FAIL` 表示规则失效或误报，`GAP` 表示这一层还没有扫描器（只记录，不算失败）。
新增规则时先加用例（正例 + 反例），再让矩阵转绿。

## 现有用例

| 用例 | 层 | 期望 |
| --- | --- | --- |
| `cors-permissive` | code | `PERMISSIVE_CORS` 必须命中 |
| `cors-explicit-allowlist` | code | `PERMISSIVE_CORS` 不得命中 |
| `csrf-disabled` | code | `SPRING_CSRF_PROTECTION_DISABLED` 必须命中 |
| `druid-statview-default` | config | 目标 `SEC_DRUID_STATVIEW_*`（待实现） |
| `druid-statview-hardened` | config | 加固写法，不应告警 |
| `jdbc-allow-multi-queries` | config | 目标 `SEC_JDBC_ALLOW_MULTI_QUERIES`（待实现） |
| `actuator-expose-all` | config | 目标 `SEC_ACTUATOR_EXPOSE_ALL`（待实现） |

规则清单与缺口见 [`docs/RULES.md`](../docs/RULES.md)。
