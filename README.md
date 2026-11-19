# Quality Center 质量中心

把 **代码质量**、**密钥泄露**、**依赖漏洞（CVE）** 三类检查聚合到一个 IDE 侧边栏面板里，结果可一键复制给 AI 修复。

> 适用于所有基于 VS Code 内核的编辑器：VS Code、Cursor、Trae、VSCodium 等。
> JetBrains IDEA 属于独立的插件体系，暂不适用（后续可考虑移植）。

## 功能

- **一个面板看全部**：活动栏「质量中心」图标，汇总三类问题，按严重度排序
- **代码质量**：调用 Maven Checkstyle 规则扫描 Java 项目
- **密钥泄露**：调用 Gitleaks 检测硬编码的 API Key、Token、密码
- **依赖漏洞**：调用 Trivy 扫描 pom.xml / jar，列出 CVE、受影响版本和修复版本
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
| `qualityCenter.openRewrite.enabled` | `true` | 启用「深度修复」 |
| `qualityCenter.openRewrite.recipes` | `["org.openrewrite.java.RemoveUnusedImports"]` | 允许执行的 OpenRewrite 配方白名单 |
| `qualityCenter.openRewrite.recipeArtifacts` | `[]` | 额外配方包的 Maven 坐标，如 `org.openrewrite.recipe:rewrite-static-analysis:2.10.0` |
| `qualityCenter.openRewrite.pluginVersion` | `5.44.0` | `rewrite-maven-plugin` 版本 |
| `qualityCenter.openRewrite.compileGate` | `true` | 修复后自动编译校验，失败提示回滚 |

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

打开项目后自动扫描，保存文件后 1.5 秒自动增量复扫，全程无需手动执行命令：

| 触发时机 | 行为 |
| --- | --- |
| 打开项目 | 自动执行三类扫描 |
| 保存文件 | 防抖 1.5 秒后重新扫描 |
| 点击「一键修复」 | 修完自动复扫验证 |
| 点击「构建并扫描」 | 执行 `mvn -DskipTests package` 后自动复扫 |

后台扫描期间，面板继续展示上一次的结果，只有扫描完成后才整体替换，不会闪成空白；顶部会显示一只奔跑的猫咪进度条，扫描结束自动隐藏。

如果项目没有可用的构建产物（`target` 下没有 jar/pom），面板会给出提示并提供「构建并扫描」按钮，一键构建后再扫描，无需手动执行 Maven 命令。

配置缺失时自动兜底：项目没有 Checkstyle 配置就使用内置规则集；没有 `target` 目录时改用离线模式扫描源码，不联网、不触发仓库限流。

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

## 代码质量与密钥的中文说明

三个板块行为一致：列表显示中文摘要，点击展开详情（中文说明、修复建议、原始信息）。

| 板块 | 中文来源 |
| --- | --- |
| 代码质量 | 内置规则字典 + 常见英文消息的中文替换，如 `Unused import - X` → `未使用的导入：X` |
| 密钥泄露 | 规则字典覆盖 API Key、私钥、AWS/GitHub/GitLab Token、Slack Token、JWT、口令等，并给出轮换与迁移建议 |
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

1. 检测未提交改动；若有，自动执行 `git stash push --include-untracked` 备份，结束后自动恢复，不需要你先提交代码；
2. 用全限定坐标调用 `rewrite-maven-plugin`，**不修改项目 pom**；
3. 执行配置中的配方白名单；
4. 自动运行 `mvn -DskipTests compile` 门禁，失败时弹窗询问是否执行 `git checkout -- .` 回滚（只撤销本次修复，不会碰你已备份的改动）；
5. 恢复未提交改动后自动复扫。

执行过程中，面板顶部的猫咪进度条会显示当前阶段（备份改动 / 运行配方 / 校验编译 / 恢复改动）和已用秒数；详细日志写入「质量中心」输出面板。

如果恢复时与修复改动冲突，会列出具体冲突文件，并提供三个入口：打开第一个冲突文件、打开源代码管理、「放弃本次修复并恢复我的改动」。选择最后一项会自动撤销本次修复并恢复你的未提交代码；即使不选择，你的改动也始终完整保存在 `git stash` 中，可用 `git stash list` 查看。

默认白名单仅含 `org.openrewrite.java.RemoveUnusedImports`，可在设置中追加。

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
