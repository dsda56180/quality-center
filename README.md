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
- **面板内设置**：点「设置」勾选扫描类型，或一键切换快速 / 完整模式
- **扫描控制**：图标工具栏支持开始、暂停、继续、终止；暂停在扫描器边界生效，终止会结束 Maven / Trivy 进程树
- **固定头部**：工具栏、进度、统计、Tab 与搜索框固定，只有问题列表滚动
- **静态缺陷**：调用 SpotBugs + FindSecBugs 分析编译后的字节码，发现空指针、资源泄漏、可变对象暴露以及 SQL 注入、命令注入、XSS、路径穿越等安全 sink
- **零手动触发**：打开项目自动扫描，保存文件后自动增量扫描
- **工具缺失可一键安装**：外部工具缺失不再静默跳过，扫描后弹窗 + 面板「安装」入口，装完自动重扫
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

缺失的工具不会自动下载：扫描结束后会弹窗提示并提供「去安装」，按系统自动选择安装方式——Windows 走 winget → Chocolatey → Scoop → 官方产物便携安装；macOS 走 Homebrew → 官方产物便携安装；Linux 走 Homebrew → 官方产物便携安装（无需 sudo，apt/dnf/pacman 作为备用命令给出）。便携安装落在插件自己的工具目录（Windows `%LOCALAPPDATA%\quality-center\tools`，其余 `~/.quality-center/tools`），不改系统 PATH，卸载后可直接删除。装完自动重新扫描；面板底部也保留带「安装」入口的「已跳过」提示。设 `qualityCenter.notifyMissingTools` 为 `false` 可整体关闭弹窗。

## 安装

### 一键安装到本机编辑器（跨平台）

`scripts/install.mjs` 在 Windows / macOS / Linux 上都可用，按系统自动挑选编辑器 CLI（优先 Trae CN，其次 Trae / Cursor / VS Code / VSCodium），并把本仓库最新的 `.vsix` 装上：

```bash
npm install
node scripts/install.mjs --list          # 先看看本机检测到哪些编辑器
node scripts/install.mjs                 # 自动选择并安装
node scripts/install.mjs --cli trae-cn   # 指定 CLI（也可传绝对路径）
node scripts/install.mjs --build         # 先 tsc + vsce package，再安装
```

安装完成后重启编辑器（或用命令面板的「Developer: Reload Window」）生效。

### 发版到 GitHub Release + Open VSX

`.github/workflows/publish.yml` 只在「Release 被发布」或手动触发时运行，推 `main` 不会发版。用下面的脚本可以一次走完全流程：

```bash
npm run release                # 版本号自动 +1（patch），如 0.17.15 → 0.17.16
npm run release -- 0.18.0      # 指定版本
npm run release -- --dry-run   # 只打印计划，不改文件、不推送
npm run release -- --no-wait   # 建完 Release 就返回，不等 Actions
```

脚本做的事：校验工作区干净 / 分支为 `main` / tag 不存在 → 更新 `package.json` 与 `package-lock.json` →
补 `CHANGELOG.md` 段落（已有该版本段落则直接复用，否则用上个 tag 以来的提交记录生成）→ `tsc` 编译与
`vsce package` 打包校验 → commit + tag `v<version>` + push → `gh release create` 触发 Actions →
等发布结果并确认 Open VSX `latest` 已指向新版本。

> Open VSX 不允许覆盖已发布版本号，`latest` 接口有 `max-age=600` 的缓存，脚本会自己轮询等待。

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
| `qualityCenter.notifyMissingTools` | `true` | 外部工具（gitleaks / trivy / mvn）缺失时弹窗提示并提供一键安装 |
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
| `qualityCenter.maven.useChinaMirror` | `true` | 无 `~/.m2/settings.xml` 时用阿里云公共仓库镜像执行 Maven；已有配置不覆盖 |
| `qualityCenter.trivy.onlyFixed` | `true` | 只显示有修复版本的 CVE |
| `qualityCenter.trivy.preferMirror` | `true` | 未配置仓库时优先走 daocloud 镜像，避免 ghcr.io 不可达导致长时间等待 |
| `qualityCenter.spotbugs.enabled` | `true` | 启用 SpotBugs + FindSecBugs 字节码检测 |
| `qualityCenter.dependencyUpgrade.enabled` | `true` | 显示「升级依赖」按钮，允许一键改写 pom 版本 |
| `qualityCenter.openRewrite.enabled` | `true` | 启用「深度修复」 |
| `qualityCenter.openRewrite.recipes` | `[]` | 手动启用的进阶配方；面板「设置」里按风险分组勾选，且只展示当前项目适用的配方 |
| `qualityCenter.openRewrite.autoRecipes` | `true` | 自动启用当前项目适用的低风险配方（8 个等价改写） |
| `qualityCenter.openRewrite.showAllRecipes` | `false` | 设置中显示 discover 列出的全部配方（含官方描述），新增配方无需升级插件 |
| `qualityCenter.openRewrite.recipeArtifacts` | `[]` | 额外配方包的 Maven 坐标；配方库所需的包已内置，通常无需填写 |
| `qualityCenter.openRewrite.pluginVersion` | `5.44.0` | `rewrite-maven-plugin` 版本 |
| `qualityCenter.openRewrite.compileGate` | `true` | 修复后自动编译校验，失败提示回滚 |
| `qualityCenter.openRewrite.dryRunPreview` | `true` | 执行前先 dry-run，并在编辑器页签打开 diff 预览 |
| `qualityCenter.openRewrite.fileSelection` | `true` | 预览页允许勾选部分文件，仅应用勾选文件的改动 |

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

后台扫描期间，面板继续展示上一次的结果，只有扫描完成后才整体替换，不会闪成空白；顶部会显示猫咪进度条：每个待执行扫描器对应一只不同品种的猫咪（橘猫、狸花、奶牛、黑猫、白猫、三花、暹罗、蓝猫、银渐层、玳瑁），猫队持续从左向右循环奔跑，蓝色填充按完成度增长，完成一项就减少一只，同时标注当前运行的扫描器、已完成数量和已用时间。深度修复与依赖升级也复用这条进度条，按执行阶段显示多只猫咪和「第 N/M 步」。

### 扫描速度

每个扫描器都会按「文件指纹」复用上一次的结果，指纹不变时直接跳过执行：

| 扫描器 | 指纹依据 | 未变化时的耗时 | 实际耗时 |
| --- | --- | --- | --- |
| SpotBugs | `target/classes/**/*.class` + pom | 不执行 Maven | 约 33 秒 |
| Checkstyle | `src/**/*.java` + 规则文件 + pom | 不执行 Maven | 约 14 秒 |
| Trivy | pom + `target/**/*.jar|pom` | 不执行 trivy | 约 3 秒（漏洞库 12 小时内更新过） |
| Gitleaks | 每次执行（本身约 1 秒） | 1 秒 | 1 秒 |

因此：

- 只改 Java 代码时，保存后通常只需重跑 Checkstyle（约 14 秒），不再重跑 SpotBugs；
- 只改配置或文档时，通常 1~2 秒完成；
- 执行过 `mvn compile` 后字节码变化，下一次扫描会重新运行 SpotBugs。

上次扫描结果与各扫描器缓存持久化在扩展存储目录，重开 IDE 后打开面板即可秒出结果，后台再刷新。

Trivy 的耗时主要在漏洞库更新：本地库 12 小时内下载过时会直接跳过更新检查（约 3 秒）；超过 12 小时后首次扫描会先更新漏洞库（国内镜像下约 90 秒），之后恢复 3 秒。

### 远程源与镜像

所有需要联网拉取的内容默认走国内可达镜像，避免在无法访问境外服务时长时间卡住：

| 内容 | 默认源 | 配置项 |
| --- | --- | --- |
| Maven 插件与依赖（Checkstyle / SpotBugs / OpenRewrite / 编译校验） | 阿里云公共仓库 `maven.aliyun.com` | `qualityCenter.maven.useChinaMirror` |
| Trivy 漏洞库 | `ghcr.m.daocloud.io/aquasecurity/trivy-db` | `qualityCenter.trivy.dbRepository` |
| Trivy Java 索引库 | `ghcr.m.daocloud.io/aquasecurity/trivy-java-db` | `qualityCenter.trivy.javaDbRepository` |

Maven 镜像只在用户没有 `~/.m2/settings.xml` 时启用，已有配置（企业私服、代理、本地仓库）不会被覆盖；需要走官方源时把对应配置清空或关闭开关即可。

### 面板内设置

工具栏「设置」可以直接控制扫描范围，无需翻设置页：

| 选项 | 说明 |
| --- | --- |
| 快速模式 | 勾选代码质量、密钥泄露、依赖漏洞，关闭 SpotBugs（约 15 秒） |
| 完整模式 | 四类检查全部开启（约 35 秒） |
| 代码质量 / 密钥泄露 / 依赖漏洞 / 静态缺陷 | 单独开关某一类扫描 |
| 保存文件后自动扫描 | 关闭后只在手动点击「重新扫描」时执行 |

应用后只保存设置，不触发扫描，下次扫描按新配置执行；设置写入工作区 `.vscode/settings.json`，与扩展设置项等价，团队可随项目共享。

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

面板工具栏点「升级依赖」，或在某条 CVE 详情里点「升级此依赖」，会先打开「依赖升级预览」页签：

- 每个可升级项一张卡片，展示当前版本来源（父 POM / 导入的 BOM / pom 直接声明 / 传递依赖）、将被改动的内容（红删绿增）与覆盖漏洞数；
- 会在预览前执行一次 `mvn dependency:tree -Dverbose`（按 pom 内容哈希缓存），用于识别真实解析版本、版本冲突与 BOM 联动关系；
- 升级 BOM 或父 POM 时列出会被一并解决的子依赖；多个可选目标版本时可直接在下拉框里确认；
- 勾选要升级的项后点「升级并校验编译」；关闭页签或点「取消」不会改动任何文件；
- 预览页是普通编辑器页签，切走或点击别处不会关闭，可以反复比对。

执行时的规则：

1. 写回方式遵循「版本号统一由 `<properties>` 管理」的标准设计，预览页会标注：
   - `属性`：版本写成 `${xxx}` 且只被这一个依赖引用时，改属性值；
   - `版本抽离`：硬编码版本、或属性被多处共用时，抽离出 `<artifactId>.version` 属性并让依赖引用它；
   - `版本覆盖`：依赖没有在 pom 中声明（传递依赖），在 `<dependencyManagement>` 中新增条目，版本同样引用抽离出的属性；
   - `父 POM / BOM / 构建插件`：升级父 POM、导入的 BOM 或显式固定的插件版本，整组组件一起对齐；
2. Spring Boot 2.x（<2.7）会作为一组升级到 2.7.18：由 BOM 管理的 `spring-*`、`tomcat-embed-*`、`jackson-*`、`logback-*` 等不再逐个固定；显式写了版本的依赖不会被 BOM 覆盖，仍单独提示；
3. 版本同一线内择优：例如 `9.0.41` 优先升到 `9.0.x` 最新补丁，避免跨大版本引入破坏性变更；
4. 无法确定的项（版本不一致、缺少同线修复版本等）会在预览页底部按原因折叠分组列出；
5. 自动执行 `mvn -DskipTests compile` 门禁，失败会还原 `pom.xml` 并展示失败日志；
6. 成功后自动重新扫描，确认漏洞已消除；若升级了 Spring Boot，还会询问是否继续执行代码级迁移（rewrite-spring，高风险，先预览再应用）。

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

1. 先执行 dry-run 预演，然后在编辑器页签打开「深度修复预览」：左侧文件列表、右侧逐行 diff，可勾选要应用的文件（`qualityCenter.openRewrite.dryRunPreview`，默认开启）；
2. 预览页可以一直留着慢慢看，切到其他编辑器或点击别处不会关闭；只有点「应用选中文件」才执行，点「取消」或直接关闭页签则放弃；再次点击「深度修复」会复用上次预演结果，不重复 dry-run（代码或配方变化后自动重新预演）；
3. 若有未提交改动，先把 `git diff HEAD` 与未跟踪文件备份到系统临时目录，**不执行 stash、不移动你的工作区代码**；
4. 直接在现有代码上运行 OpenRewrite（全限定坐标调用 `rewrite-maven-plugin`，不修改项目 pom），因此不会产生 stash 恢复冲突；
5. 自动运行 `mvn -DskipTests compile` 门禁；失败或配方执行出错时，可一键恢复到修复前（包含你的未提交改动）；
6. 成功后自动复扫。

执行过程中，面板顶部的猫咪进度条会显示当前阶段（备份改动 / 运行配方 / 校验编译 / 恢复改动）和已用秒数；详细日志写入「质量中心」输出面板。

内置 19 个常用配方，并**按当前项目画像过滤**，不需要自己查 Maven 坐标：

- 低风险（自动启用，8 个）：清理无用导入、`Objects.isNull` 改写、缩短全限定类名、整理 import 顺序、简化布尔表达式、去除多余括号、去除多余分号、使用菱形泛型；
- 中风险（手动勾选，6 个）：统一代码格式、equals 常量左置、简化布尔返回、Lambda 改方法引用、使用 `StandardCharsets`、简化常量条件分支；
- 高风险（手动勾选，5 个，带项目条件）：Spring Boot 2.7 代码迁移（仅 Spring Boot 2.x < 2.7）、Spring Boot 3.0 代码迁移（仅 Spring Boot 2.x 且 Java ≥ 17）、Java 8 → 11 迁移（仅 Java ≤ 8）、升级到 Java 17（仅 Java 11–16）、JUnit 4 → JUnit 5 迁移（仅检测到 JUnit 4）。

设置弹窗顶部会显示「已按当前项目过滤：Java 8 · Spring Boot 2.4.2 · JUnit 4」；不适用的配方直接隐藏，切换项目后重新打开设置即按新项目过滤。在「设置 → 深度修复配方」里可以：

- 关闭「自动启用低风险配方」，改为逐项勾选；
- 按风险分组查看配方说明，勾选需要的高风险配方；
- 开启「显示全部可用配方」：调用 `rewrite:discover -Ddetail=true` 列出类路径上的全部 OpenRewrite 配方（约 1400 个，含官方英文描述），新增配方无需升级插件；首次加载约 10 秒，可用搜索框筛选；
- 配方所需的依赖包由插件按选择自动带入，`rewrite-maven-plugin` 版本也会按配方兼容性自动选择（当前配方库统一为 6.0.5）。

执行前会解析项目根 `pom.xml`（parent、`dependencyManagement`、compiler 配置），识别 Java 与 Spring Boot 版本，并给出提示：

- 项目画像，例如 `Java 8 · Spring Boot 2.4.2`；
- 低风险配方已自动启用；
- 若识别到 Spring Boot 2.x（<2.7），提示可通过「升级依赖」升级到 2.7.18 后再执行代码级迁移。

问题详情里还有「深度修复此规则」：只运行该条问题对应的配方（如 `UnusedImports` → 清理无用导入、`SimplifyBooleanExpression` → 简化布尔表达式），适合逐类处理，不必全量执行。

需要配方库之外的自定义配方包时，把坐标填进 `openRewrite.recipeArtifacts` 即可；插件只执行设置中明确勾选的配方，不会自动加载任意来源的配方包。

## 基线 / 忽略

问题详情里点「忽略此问题」会把该条写入项目根 `.quality-center/baseline.json`，之后扫描仍会检测但不再计入统计、修复建议和 AI 导出。面板新增「已忽略」Tab，可逐条「恢复」。

忽略记录使用稳定指纹（来源 + 规则 + 文件 + 消息；CVE 用包名 + 版本），不包含行号，代码移动后仍能匹配。该文件默认位于已被 `.gitignore` 忽略的目录中，仅本机生效；如需团队共享，可自行取消忽略并提交。

插件只执行设置里明确勾选的配方，不会自动加载任意来源的配方包。

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
