# Quality Center 质量中心

把 **代码质量**、**密钥泄露**、**依赖漏洞（CVE）**、**字节码级静态缺陷** 四类检查聚合到一个 IDE 侧边栏面板里，结果可一键复制给 AI 修复。

> 适用于所有基于 VS Code 内核的编辑器：VS Code、Cursor、Trae、VSCodium 等。
> JetBrains IDEA 属于独立的插件体系，暂不适用（后续可考虑移植）。

## 功能

- **一个面板看全部**：活动栏「质量中心」图标，汇总四类问题，按严重度排序
- **代码质量**：调用 Maven Checkstyle 规则扫描 Java 项目
- **密钥泄露**：调用 Gitleaks 检测硬编码的 API Key、Token、密码
- **依赖漏洞**：调用 Trivy 扫描 pom.xml / jar，列出 CVE、受影响版本和修复版本
- **依赖一键升级**：把有修复版本的直接依赖写回 pom，编译失败自动还原
- **静态缺陷**：调用 SpotBugs + FindSecBugs 分析编译后的字节码，发现空指针、资源泄漏、可变对象暴露以及 SQL 注入、命令注入、XSS、路径穿越等安全 sink
- **零手动触发**：打开项目自动扫描，保存文件后自动增量扫描
- **一键交付 AI**：面板「复制给 AI」生成结构化 Markdown，或「导出报告」保存为 `.md`
- **单条复制**：每条问题右侧有「复制」按钮，只把这一条交给 AI
- **AI 可读接口**：每轮扫描自动写入 `.quality-center/issues.json`（结构化）与 `.quality-center/report.md`，AI agent 可直接读取该文件
- **点击跳转**：代码类问题可直接跳转到对应文件行

## 环境要求

| 扫描器 | 依赖 | 安装方式 |
| --- | --- | --- |
| Checkstyle | JDK 8+、Maven | 项目自带即可 |
| Gitleaks | `gitleaks` 可执行文件 | `winget install gitleaks.gitleaks` |
| Trivy | `trivy` 可执行文件 | `winget install aquasecurity.trivy` |
| SpotBugs | JDK、Maven、已编译的 `target/classes` | 首次运行自动从 Maven 仓库下载分析器与 FindSecBugs 插件 |

缺失的工具会自动跳过，并在面板底部提示，不影响其他检查。

## 安装

### 本地安装（开发调试）

```bash
npm install
npm run compile
npm run package
```

然后安装生成的 `.vsix`：

```bash
code --install-extension quality-center-0.1.0.vsix
# Trae:
trae-cn --install-extension quality-center-0.1.0.vsix
```

### 从 Open VSX 安装

```bash
code --install-extension dsda56180.quality-center
```

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `qualityCenter.scanOnStartup` | `true` | 打开项目后自动扫描一次 |
| `qualityCenter.scanOnSave` | `true` | 保存文件后自动触发扫描 |
| `qualityCenter.checkstyle.enabled` | `true` | 启用 Checkstyle |
| `qualityCenter.checkstyle.config` | `""` | 规则文件路径，留空则依次尝试 `.githooks/checkstyle-config.xml`、`checkstyle.xml`、`config/checkstyle/checkstyle.xml` |
| `qualityCenter.gitleaks.enabled` | `true` | 启用 Gitleaks |
| `qualityCenter.gitleaks.path` | `""` | 可执行文件路径，留空从 PATH 查找 |
| `qualityCenter.trivy.enabled` | `true` | 启用 Trivy |
| `qualityCenter.trivy.path` | `""` | 可执行文件路径，留空从 PATH 查找 |
| `qualityCenter.trivy.scanTarget` | `""` | 扫描目标，留空则自动优先使用 `target` 目录（构建产物） |
| `qualityCenter.trivy.dbRepository` | `""` | 漏洞库 OCI 仓库，留空用官方源，失败自动回退国内镜像 |
| `qualityCenter.trivy.javaDbRepository` | `""` | Java 依赖索引库 OCI 仓库，同上 |
| `qualityCenter.trivy.minSeverity` | `low` | 低于该等级的 CVE 不显示（low/medium/high/critical） |
| `qualityCenter.trivy.onlyFixed` | `true` | 只显示有修复版本的 CVE |
| `qualityCenter.spotbugs.enabled` | `true` | 启用 SpotBugs + FindSecBugs 字节码检测 |
| `qualityCenter.dependencyUpgrade.enabled` | `true` | 显示「升级依赖」按钮，允许一键改写 pom 版本 |
| `qualityCenter.openRewrite.enabled` | `true` | 启用「深度修复」 |
| `qualityCenter.openRewrite.recipes` | 清理无用导入 / `Objects.isNull` / 缩短全限定类名 | 允许执行的 OpenRewrite 配方白名单 |
| `qualityCenter.openRewrite.recipeArtifacts` | `[]` | 额外配方包的 Maven 坐标，如 `org.openrewrite.recipe:rewrite-static-analysis:2.10.0` |
| `qualityCenter.openRewrite.pluginVersion` | `5.44.0` | `rewrite-maven-plugin` 版本 |
| `qualityCenter.openRewrite.compileGate` | `true` | 修复后自动编译校验，失败提示回滚 |
| `qualityCenter.openRewrite.dryRunPreview` | `true` | 执行前先 dry-run 预演，展示将改动的文件并支持查看补丁 |
| `qualityCenter.openRewrite.fileSelection` | `true` | 预演后弹出文件勾选，仅应用勾选文件的改动 |

另外支持在项目根目录放置 `.trivyignore` 文件忽略指定 CVE（Trivy 原生格式，每行一个 CVE 编号）。

## 命令

| 命令 | 说明 |
| --- | --- |
| `质量中心：重新扫描` | 立即执行全部扫描 |
| `质量中心：复制报告为 Markdown` | 把当前结果复制到剪贴板 |
| `质量中心：导出报告文件` | 保存为 `.md` 并打开 |
| `质量中心：深度修复` | 用 OpenRewrite 执行白名单配方，编译失败可回滚 |

## 隐私与安全

- 所有扫描均在本机执行，不上传任何代码
- 密钥扫描结果只保留规则、文件与行号，**不展示、不导出密钥原文**
- Trivy 首次运行需要联网下载漏洞数据库（约 50 MB），之后自动缓存

## 自动执行

打开项目后自动扫描，保存文件后 1.5 秒自动复扫，全程无需手动执行命令：

| 触发时机 | 行为 |
| --- | --- |
| 打开项目 | 先展示上次结果，再后台自动扫描四类问题 |
| 保存文件 | 仅当保存的是 java/xml/properties/yml/toml/json 等文件时触发，防抖 1.5 秒 |
| 点击「一键修复」 | 修完自动复扫验证 |
| 点击「构建并扫描」 | 执行 `mvn -DskipTests package` 后自动复扫 |

后台扫描期间，面板继续展示上一次的结果，只有扫描完成后才整体替换，不会闪成空白；顶部会显示猫咪进度条，并实时标注当前运行的扫描器、已完成数量和已用时间。

### 扫描速度

每个扫描器都会按「文件指纹」复用上一次的结果，指纹不变时直接跳过执行：

| 扫描器 | 指纹依据 | 未变化时的耗时 | 实际耗时 |
| --- | --- | --- | --- |
| SpotBugs | `target/classes/**/*.class` + pom | 不执行 Maven | 约 33 秒 |
| Checkstyle | `src/**/*.java` + 规则文件 + pom | 不执行 Maven | 约 14 秒 |
| Trivy | pom + `target/**/*.jar|pom` | 不执行 trivy | 约 3 秒 |
| Gitleaks | 每次执行（本身约 1 秒） | 1 秒 | 1 秒 |

因此：

- 只改 Java 代码时，保存后通常只需重跑 Checkstyle（约 14 秒），不再重跑 SpotBugs；
- 只改配置或文档时，通常 1~2 秒完成；
- 执行过 `mvn compile` 后字节码变化，下一次扫描会重新运行 SpotBugs。

上次扫描结果与各扫描器缓存持久化在扩展存储目录，重开 IDE 后打开面板即可秒出结果，后台再刷新。

如果项目没有可用的构建产物（`target` 下没有 jar/pom），面板会给出提示并提供「构建并扫描」按钮，一键构建后再扫描，无需手动执行 Maven 命令。

配置缺失时自动兜底：项目没有 Checkstyle 配置就使用内置规则集；没有 `target` 目录时改用离线模式扫描源码，不联网、不触发仓库限流。

SpotBugs 分析的是 `target/classes` 里的字节码，因此需要项目先构建过；没有编译产物时该板块自动跳过，并在面板提示点击「构建并扫描」。升级窗口内的字节码可能落后于源码，改完代码后建议先构建再扫描。

## 修复建议

「修复建议」标签页不是逐条问题的罗列，而是从结果推导根因级行动方案：

| 类别 | 触发条件 | 示例 |
| --- | --- | --- |
| 框架升级 | 从 pom.xml 识别 Spring Boot 版本 + 框架层 CVE | 升级 Spring Boot 2.4.2 → 2.7.18，可覆盖 224 条 |
| 依赖升级 | 同一组件命中 ≥ 2 个 CVE | 升级 tomcat-embed-core 9.0.41 → 9.0.x 最新补丁 |
| 密钥治理 | 存在硬编码密钥 | 先轮换再迁移到配置中心 |
| 人工处理 | 剩余分散问题 | 建议逐条复制给 AI 评估 |

每条建议可单独复制，格式为标题 + 影响范围 + 操作说明，直接粘贴给 AI 即可。建议同时写入 `issues.json` 的 `suggestions` 字段和 `report.md` 的「修复建议」章节。

## CVE 中文展示与详情

Trivy 漏洞库只提供英文字段，插件不会做机器翻译，而是用结构化数据生成中文摘要：

```
ch.qos.logback:logback-classic 1.2.3 命中高危漏洞，CVSS 7.5，
可远程网络攻击，无需认证，无需用户交互，影响可用性。
```

摘要中的攻击向量、权限要求、影响面来自 CVSS 向量逐段解析，组件名与版本来自依赖清单，因此不会出现翻译臆造。

点击任意 CVE 条目可展开详情：

| 区块 | 内容 |
| --- | --- |
| 基础信息 | 漏洞编号、影响组件、当前版本、修复版本、CVSS、CWE、披露时间 |
| 问题说明 | 中文摘要 |
| 修复建议 | 升级目标 + 传递依赖覆盖方式 + 无法升级时的缓解措施 |
| 英文原文 | 官方标题与描述（保留原始信息） |
| 操作 | 打开漏洞库 / 参考链接 / 复制详情给 AI |

需要英文描述的完整中文翻译时，点「复制详情给 AI」，把原文交给 AI 翻译即可。

## 依赖一键升级

面板工具栏点「升级依赖」，或在某条 CVE 详情里点「升级此依赖」，即可把修复版本写回 `pom.xml`：

1. 只处理 **pom 中显式声明版本** 的直接依赖；由 Spring Boot BOM 管理的依赖、传递依赖不会自动改，会在提示中列出原因；
2. 版本同一线内择优：例如 `9.0.41` 优先升到 `9.0.x` 最新补丁，避免跨大版本引入破坏性变更；
3. 版本写成 `${xxx}` 时，仅当该属性只被这一个依赖引用才修改属性值，多处引用会跳过；
4. 自动执行 `mvn -DskipTests compile` 门禁，失败会还原 `pom.xml` 并展示失败日志；
5. 成功后自动重新扫描，确认漏洞已消除。

## 代码质量与密钥的中文说明

四个板块行为一致：列表显示中文摘要，点击展开详情（中文说明、修复建议、原始信息）。

| 板块 | 中文来源 |
| --- | --- |
| 代码质量 | 内置规则字典 + 常见英文消息的中文替换，如 `Unused import - X` → `未使用的导入：X` |
| 密钥泄露 | 规则字典覆盖 API Key、私钥、AWS/GitHub/GitLab Token、Slack Token、JWT、口令等，并给出轮换与迁移建议 |
| 静态缺陷 | 按 SpotBugs 缺陷类型（空指针、资源泄漏、可变对象暴露、SQL/命令注入、XSS、路径穿越等）给出中文说明与修复建议，未收录类型回退到类别说明 |
| 依赖漏洞 | CVSS 向量与依赖字段生成，见上一节 |

未收录的规则会回退到通用说明，不会显示空白。

## 一键修复

面板会统计可确定性修复的问题，点击「一键修复」或单条「修复」即可改写：

| 规则 | 修复动作 |
| --- | --- |
| `UnusedImports` / `RedundantImport` | 删除对应 import 行 |
| `ModifierOrder` | 按 Java 规范重排修饰符 |
| `SimplifyBooleanExpression` | `false == x` → `!x`、`x != true` → `!x` 等等价改写 |

含字符串字面量或注释的行会保守跳过；修完自动重新扫描。

## 深度修复（OpenRewrite）

「一键修复」只处理插件内置的确定性改写。更复杂的结构性问题（无用导入、等价写法、冗余修饰等）交给 OpenRewrite——它的配方库是开源社区长期维护、被大量项目验证过的，按编译单元（AST）改写，不做文本替换。

面板工具栏点「深度修复」后：

1. 先执行 dry-run 预演，列出将改动的文件；可打开补丁预览后再确认执行（`qualityCenter.openRewrite.dryRunPreview`，默认开启）；
2. 预演后进入文件勾选：取消勾选的文件不会保留改动，执行完会自动恢复为修复前的状态；
3. 若有未提交改动，先把 `git diff HEAD` 与未跟踪文件备份到系统临时目录，**不执行 stash、不移动你的工作区代码**；
4. 直接在现有代码上运行 OpenRewrite（全限定坐标调用 `rewrite-maven-plugin`，不修改项目 pom），因此不会产生 stash 恢复冲突；
5. 自动运行 `mvn -DskipTests compile` 门禁；失败或配方执行出错时，可一键恢复到修复前（包含你的未提交改动）；
6. 成功后自动复扫。

执行过程中，面板顶部的猫咪进度条会显示当前阶段（备份改动 / 运行配方 / 校验编译 / 恢复改动）和已用秒数；详细日志写入「质量中心」输出面板。

默认配方为清理无用导入、`Objects.isNull` 改写、缩短全限定类名，可在设置中增删。

执行前会解析项目根 `pom.xml`（parent、`dependencyManagement`、compiler 配置），识别 Java 与 Spring Boot 版本，并在确认弹窗中展示：

- 项目画像，例如 `Java 8 · Spring Boot 2.4.2`；
- 推荐但**未启用**的配方，例如 static-analysis 配方包，或 Spring Boot 2.7 升级评估，并标注风险等级。

推荐只做展示，不会自动写入配置，也不会自动执行升级迁移配方。

问题详情里还有「深度修复此规则」：只运行该条问题对应的配方（如 `UnusedImports` → 清理无用导入、`SimplifyBooleanExpression` → 简化布尔表达式），适合逐类处理，不必全量执行。

## 基线 / 忽略

问题详情里点「忽略此问题」会把该条写入项目根 `.quality-center/baseline.json`，之后扫描仍会检测但不再计入统计、修复建议和 AI 导出。面板新增「已忽略」Tab，可逐条「恢复」。

忽略记录使用稳定指纹（来源 + 规则 + 文件 + 消息；CVE 用包名 + 版本），不包含行号，代码移动后仍能匹配。该文件默认位于已被 `.gitignore` 忽略的目录中，仅本机生效；如需团队共享，可自行取消忽略并提交。

需要 `org.openrewrite.staticanalysis.*` 等进阶配方时，不必改项目 pom：把配方包坐标填进 `openRewrite.recipeArtifacts` 即可，插件会通过 `-Drewrite.recipeArtifactCoordinates` 临时加入类路径。例如：

```json
"qualityCenter.openRewrite.recipes": [
  "org.openrewrite.java.RemoveUnusedImports",
  "org.openrewrite.staticanalysis.SimplifyBooleanExpression"
],
"qualityCenter.openRewrite.recipeArtifacts": [
  "org.openrewrite.recipe:rewrite-static-analysis:2.10.0"
]
```

插件只执行白名单里明确列出的配方，不会自动加载任意来源的配方包。

## 发布

推 tag 并创建 GitHub Release 后，CI 会自动构建并发布到 Open VSX：

```bash
git tag v0.2.1 && git push origin v0.2.1
# 在 GitHub 上创建 Release，Actions 会自动执行 npm run package + ovsx publish
```

前提：在仓库 Settings → Secrets and variables → Actions 中配置 `OVSX_TOKEN`
（Token 在 open-vsx.org → Settings → Access Tokens 生成，命名空间需已在 open-vsx.org 创建）。

也可以手动发布：

```bash
npm run package
npx ovsx publish quality-center-<version>.vsix -p <YOUR_TOKEN>
```

## 许可证

MIT
