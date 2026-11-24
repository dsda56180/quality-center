---
name: quality-center-dependencies
description: 依据 quality-center 的依赖漏洞扫描结果规划并执行 pom 依赖升级（含 BOM / 父 POM 整组对齐、传递依赖覆盖、编译校验），改完复扫确认漏洞消除。当用户要求「修掉这些 CVE / 升级依赖 / Spring Boot 升个小版本」时使用。
---

# 依赖漏洞修复（CVE）

## 1. 拿到干净的数据

```bash
node <扩展目录>/out/cli.js tools install mvn      # 没装先装
node <扩展目录>/out/cli.js build <项目目录>       # 先生成 target 产物，依赖清单才准确
node <扩展目录>/out/cli.js scan <项目目录> --only trivy --json --fail-on none
```

看 `issues[]` 里 `source: "trivy"` 的条目：`package`、`installedVersion`、`fixedVersion`（逗号分隔多个候选）、`cvss`、`advice`。
顶层 `suggestions[]` 是插件给出的根因级方案（框架升级 / 同组件多 CVE / 密钥治理 / 人工处理），优先参考它，别自己从零判断。

## 2. 选版本的三条硬规则

1. **同一版本线内取最小修复**：`9.0.41 → 9.0.x 最新补丁`，不要跨大版本（`→10.x`）引入破坏性变更。
2. **BOM / 父 POM 管理的依赖整组对齐**：Spring Boot 由 BOM 管理的 `spring-*`、`tomcat-embed-*`、`jackson-*`、`logback-*` 不要逐个写死版本；升级 BOM/父 POM 后它们自动跟随。显式写死版本的不受 BOM 覆盖，需要单独处理。
3. **传递依赖用 `dependencyManagement` 覆盖**：pom 里没有声明的组件，新增条目并引用抽离出的属性，而不是加一条 `<dependency>`。

写回风格与插件一致：版本统一由 `<properties>` 管理，硬编码时抽离成 `<artifactId>.version` 再引用。

## 3. 执行与校验

```bash
# 改完 pom 必须编译校验（插件在 IDE 里用 mvn compile 作为门禁，这里等价）
node <扩展目录>/out/cli.js build <项目目录>     # package 成功即包含 compile
node <扩展目录>/out/cli.js scan <项目目录> --only trivy --json --fail-on none
```

验收：`summary.trivy` 下降、目标 CVE 不再出现、`errors` 为空、构建成功。若升级了 Spring Boot 大版本，还必须跑一遍单元测试或至少 `mvn -DskipTests=false test -DfailIfNoTests=false`，并提示用户做代码级迁移（`[INFO]` 版本线不同，等价写法可能不成立）。

## 4. 汇报格式

每条 CVE 写：`CVE 编号 · 组件 当前版本 → 目标版本 · 理由（同线最小修复 / BOM 对齐 / 传递依赖覆盖）`，
并说明「已验证：构建通过 + 复扫无该 CVE」。不要凭 `fixedVersion` 之外的猜测填版本号。

## 5. 禁止事项

- 不要为了让扫描变干净而改 `.trivyignore` 或 `baseline.json`，除非用户明确要求忽略且有正当理由（例如官方无修复版本）。
- 不要跨大版本硬升（Spring Boot 2.x → 3.x、Java 8 → 17）而不说明风险。
- 不要在没跑构建校验的情况下宣布「升级完成」。
