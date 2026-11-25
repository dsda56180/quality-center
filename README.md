# Quality Center 质量中心

把 **代码质量**、**密钥泄露**、**依赖漏洞（CVE）**、**字节码级静态缺陷**、**配置与框架安全**、**AST 语义规则** 六类检查聚合到一个 IDE 侧边栏面板里，结果可一键复制给 AI 修复。

> 适用于所有基于 VS Code 内核的编辑器：VS Code、Cursor、Trae、VSCodium 等。
> JetBrains IDEA 属于独立的插件体系，暂不适用（后续可考虑移植）。

## 功能

- **一个面板看全部**：活动栏「质量中心」图标，汇总六类问题，按严重度排序
- **代码质量**：调用 Maven Checkstyle 规则扫描 Java 项目
- **密钥泄露**：调用 Gitleaks 检测硬编码的 API Key、Token、密码
- **依赖漏洞**：调用 Trivy 扫描 pom.xml / jar，列出 CVE、受影响版本和修复版本
- **配置安全（qcsec）**：内置扫描器直接解析 `application*.yml` / `.properties` / `bootstrap*.yml` 与 MyBatis Mapper XML，不用装任何外部工具，检出 Druid 面板默认口令与 `0.0.0.0` 绑定、`allowMultiQueries=true`、Actuator 全端点暴露、CORS 通配源（含允许凭证）、明文口令、devtools 开启、`server.ssl.enabled: false`、Swagger/Knife4j 文档开放、Mapper 里 `${}` 字符串替换与 `statementType="STATEMENT"`、Druid 面板未配账号或开启 reset-enable、JDBC 关闭 TLS、Actuator 与业务共用端口、Redis 空口令、Nacos 默认账号/关闭鉴权/token 密钥未更换、RabbitMQ guest 账号、Kafka SASL 明文口令、Gateway actuator 端点开启
- **AST 语义规则（astgrep）**：用 ast-grep 解析 Java 语法树（引擎随扩展打包，逐平台二进制），检查 `permitAll()` 是否覆盖 `/actuator`、`/admin`、`/druid`、`/nacos` 等敏感路径或 `anyRequest().permitAll()`（含匹配器参数为常量白名单、`@Value` 默认值、`web.ignoring()` 绕过滤器链三种写法）、日志是否直接输出口令/令牌、`MultipartFile` 参数所在方法是否缺少大小与类型校验、SQL 是否由「字面量 + 变量」拼接后执行、`@CrossOrigin` 是否通配来源、SpEL/OGNL 是否用外部输入构造表达式、`Runtime.exec` / `ProcessBuilder -c` 是否拼接命令、MyBatis 注解 SQL 是否含 `${}`、`new URL` 与 `RestTemplate` 的地址是否来自变量（SSRF）、`getWriter()` / `PrintWriter` 是否直接写外部输入、Thymeleaf `th:utext` 与 JSP 是否未转义输出、上传文件名（含同方法局部变量中转）是否拼落盘路径（路径穿越）、`String.format` / `StringBuilder`（含链式 append）是否拼 SQL 后执行；平台不支持时只跳过这一层并说明原因
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
| SpotBugs | JDK、Maven、已编译的 `target/classes` | 首次运行自动从 Maven 仓库下载分析器与 FindSecBugs 插件；FindSecBugs 通过临时 pom 注入（`-Dspotbugs.plugins` 传不进去） |
| 配置安全（qcsec） | 无（插件内置文本解析） | 开箱即用 |
| 语义规则（astgrep） | 无（内置 ast-grep 引擎，按平台打包在扩展内） | 开箱即用，平台不支持时该层跳过并说明原因 |

缺失的工具不会自动下载：扫描结束后会弹窗提示并提供「去安装」，按系统自动选择安装方式——Windows 走 winget → Chocolatey → Scoop → 官方产物便携安装；macOS 走 Homebrew → 官方产物便携安装；Linux 走 Homebrew → 官方产物便携安装（无需 sudo，apt/dnf/pacman 作为备用命令给出）。便携安装落在插件自己的工具目录（Windows `%LOCALAPPDATA%\quality-center\tools`，其余 `~/.quality-center/tools`），不改系统 PATH，卸载后可直接删除。装完自动重新扫描；面板底部也保留带「安装」入口的「已跳过」提示。设 `qualityCenter.notifyMissingTools` 为 `false` 可整体关闭弹窗。

安装过程有完整反馈：通知栏显示当前阶段（下载 / 解压 / 校验）与下载百分比，面板顶部同步显示同一行进度并累计已用时间，可随时点取消（会结束整棵进程树）；结束、失败、取消都会弹提示并写明用时与原因，详细输出写入「质量中心」输出面板。Maven 便携安装走华为云镜像（失败回退 Maven Central 与 Apache archive），下载带重试与单文件超时，不会因为镜像慢而一直挂着。

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
npm run pack                      # 可复现打包；也可加 --version 0.27.8 指定版本
```

`npm run pack` 会在临时目录里只装运行时依赖、补齐各平台 `@ast-grep` 二进制，并在打包后校验 VSIX 里确实带上了
AST 引擎。不要用 `vsce package --no-dependencies` 出开发包：它会把 `node_modules` 整体排除，装上后
「语义规则」整类跳过，面板提示 `AST 引擎不可用（Cannot find module '@ast-grep/napi'）`。

然后安装生成的 `.vsix`（文件名里的版本号以当前 `package.json` 为准）：

```bash
code --install-extension quality-center-<version>.vsix
# Trae:
trae-cn --install-extension quality-center-<version>.vsix
```

也可以直接 `node scripts/install.mjs --build`，自动完成「编译 → 打包 → 装进本机编辑器 → 回读校验」。

### 从 Open VSX 安装

```bash
code --install-extension dsda56180.quality-center
```

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `qualityCenter.scanOnStartup` | `true` | 打开项目后自动扫描一次 |
| `qualityCenter.scanOnSave` | `true` | 保存文件后自动触发扫描 |
| `qualityCenter.exportForAgent` | `true` | 每轮扫描后写入 `.quality-center/issues.json` 与 `report.md`，供 AI agent 直接读取 |
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
| `qualityCenter.qcsec.enabled` | `true` | 启用配置安全扫描（qcsec），无需外部工具 |
| `qualityCenter.astgrep.enabled` | `true` | 启用 AST 语义规则（astgrep）：解析 Java 语法树与 Thymeleaf/JSP/FreeMarker/Velocity 模板，覆盖 27 条规则（permitAll 敏感路径、日志敏感字段、上传校验、SQL 拼接、@CrossOrigin、SpEL、命令执行、MyBatis 注解 SQL、SSRF、XSS、路径穿越、Zip Slip、开放重定向、XXE、不安全随机数、JWT 不验签、时序比较、Cookie 标志、任意文件读取、SSTI、LDAP/JDBC/日志注入、敏感打印、反序列化、上传扩展名） |
| `qualityCenter.rules.mute` | `[]` | 规则静音（单规则开关）：规则 id、前缀通配 `SEC_DRUID_*` 或来源名 `trivy`；静音条数记入 `summary.mutedByRule`，不进面板与报告 |
| `qualityCenter.aggregate` | `false` | 同文件聚合：同规则同文件 ≥3 处合并为一条（仅 medium 及以下，高危逐条展示） |
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
| `质量中心：自动修复可确定性问题` | 修复无导入、修饰符顺序、布尔表达式等确定性规则 |
| `质量中心：深度修复（OpenRewrite）` | 用 OpenRewrite 执行白名单配方，编译失败可回滚 |
| `质量中心：复制报告为 Markdown` | 把当前结果复制到剪贴板 |
| `质量中心：导出报告文件` | 保存为 `.md` 并打开 |
| `质量中心：打开问题位置` | 跳到某条问题对应的文件行 |
| `质量中心：打开设置` | 打开面板内的扫描范围与配方设置 |

## 给 AI agent 的接口（MCP + CLI + Skills）

插件除了侧边栏，还对外提供三种接入方式，三种都走同一套扫描器、同一份基线与同一套修复规则：

1. **MCP 服务端**（推荐给 agent）：`node <扩展目录>/out/cli.js mcp`，stdio + JSON-RPC，零依赖。
2. **CLI**：`out/cli.js` 的各子命令，适合脚本与 CI。
3. **Skills**：`skills/` 下可加载的 Skill 包 + `manifest.json` 清单。

### AI 时代，插件负责什么

AI 已经能读 pom、跑 mvn、改文件；插件不再和模型比“会不会改”，而是补它补不了的四件事：

- **记忆**：`.quality-center/` 是仓库内的账本（扫描、计划、步骤、构建结果），换会话、换 Agent 都能从 `handoff.md` 一页接上。
- **边界**：策略是契约，`planId + pomHash` 是许可证，`qc propose/validate`（规划中）让 AI 只能提议、不能绕过计划直接写 pom。
- **签证**：构建门禁与 `upgrade check` 产出前后哈希、退出码、日志，把“已升级完成”变成可核验的事实。
- **上下文经济**：摘要 / 增量 / 分组计划 / 失败翻译，让 Agent 读 10 行而不是 1000 行。

一句话：**不给 AI 加能力，给 AI 加边界和记忆；边界越清楚，它才越敢放手做。**

### MCP 配置

把下面这段加到 MCP 客户端（Trae / Claude Desktop / Cursor 等）的配置里，`args` 第一项换成你的扩展目录：

```json
{
  "mcpServers": {
    "quality-center": {
      "command": "node",
      "args": ["<扩展目录>/out/cli.js", "mcp"]
    }
  }
}
```

暴露的工具：

| 工具 | 作用 |
| --- | --- |
| `quality_next` | **唯一状态机**：现在到哪、下一步只做什么、命令、阻塞与警告，并刷新 `.quality-center/handoff.md`；开局/换会话先调它 |
| `quality_status` | 一次返回工具就绪、最近扫描计数、升级计划分组进度与 pom hash，需要细节时再调 |
| `quality_explain` | 把构建失败翻译成原因/影响/建议（属性覆盖 BOM、坐标不存在、依赖解析、编译错误、收敛冲突） |
| `quality_scan` | 六类扫描；默认摘要 + Top N（`detail=full` 才给全量），`delta=true` 只比新增/消失 |
| `quality_build` | 按策略 `buildGate` 执行构建，返回 `tests`（executed/skipped）与 `drift`；pom 偏离活动计划时拒绝构建，测试默认不跳过 |
| `quality_tools_status` | 工具是否就绪、解析到的路径、能否自动安装 |
| `quality_tools_install` | 按当前系统自动安装 mvn / gitleaks / trivy |
| `quality_report` | 读取已落盘的 issues.json / report.md，不重新扫描 |
| `quality_fix` | 确定性修复，默认只预览，`write=true` 才落盘；落盘时保存 before 快照、patch 与 `fix-result.json` |
| `quality_fix_rollback` | 按 `fixId` 回滚确定性修复；修复后又被改过的文件拒绝覆盖 |
| `quality_upgrade_plan` | 出 Plan V3；默认只回分组概览 + 首组候选（`group=` 取别的组，`detail=full` 要全量），`reuse=true` 同 hash 复用计划 |
| `quality_upgrade_apply` | 按 `planId + pomHash` 分批落盘（`group` / `packages`），跨线需 `allowCrossLine` |
| `quality_upgrade_check` | pending / partial / applied / drift，CI 与 AI 收尾都用它 |
| `quality_upgrade_revert` | 回到计划前快照；pom 被手工改过时拒绝 |
| `quality_finalize` | 插件口径收尾：基线/最终计数、按来源变化、首次可见、计划进度、构建/测试与阻塞，写 `final-report.json / .md` |
| `quality_phase` | AI 显式推进阶段（`static_fix` 等），面板与事件日志据此显示当前阶段 |

服务端在 stdin/stdout 上收发换行分隔的 JSON-RPC，stdout 只放协议消息；请求串行处理，避免并发拉起多份 mvn/trivy。

### CLI

```bash
node <扩展目录>/out/cli.js next <项目>                   # 唯一下一步 + 刷新 handoff.md
node <扩展目录>/out/cli.js next <项目> --json            # 状态机 JSON（command/blockers/handoffFile）
node <扩展目录>/out/cli.js explain <项目>                # 构建失败 → 原因/影响/建议
node <扩展目录>/out/cli.js prompt <项目> --drive         # 输出“AI 全权推进”循环指令（可直接粘贴）
node <扩展目录>/out/cli.js scan --json --fail-on high   # 六类扫描，JSON 到 stdout
node <扩展目录>/out/cli.js scan --json --detail summary --top 10   # 只给计数 + Top N
node <扩展目录>/out/cli.js scan --json --only trivy --delta        # 复扫只看新增/消失
node <扩展目录>/out/cli.js scan --only trivy,spotbugs   # 只跑指定扫描器
node <扩展目录>/out/cli.js scan --only qcsec            # 只跑配置层规则（无需 mvn/trivy）
node <扩展目录>/out/cli.js scan --only astgrep          # 只跑 AST 语义规则（无需 mvn/trivy）
node <扩展目录>/out/cli.js scan --mute SEC_DRUID_STATVIEW_RESET_ENABLED   # 单规则静音，支持 SEC_* 前缀通配
node <扩展目录>/out/cli.js scan --sarif report.sarif   # 额外写 SARIF 2.1.0（GitHub code scanning 可直接上传）
node <扩展目录>/out/cli.js scan --gha --fail-on high    # 输出 ::error/::warning 注解，CI 里直接标到代码行
node <扩展目录>/out/cli.js scan --aggregate             # 同文件同类问题合并（medium 及以下）
node <扩展目录>/out/cli.js build <项目>                 # 按策略 buildGate 构建（默认 package）
node <扩展目录>/out/cli.js fix <项目>                   # 确定性修复，默认只预览
node <扩展目录>/out/cli.js fix <项目> --write           # 写回文件，改完需复扫
node <扩展目录>/out/cli.js tools status --json          # 工具是否就绪
node <扩展目录>/out/cli.js tools install mvn            # 缺失工具自动安装
node <扩展目录>/out/cli.js report --md                  # 复用已有结果
```

### 升级计划与编辑器接入

升级不再让 AI 直接改 `pom.xml`：插件先产出计划与补丁，AI 只审 diff、只处理判断类修复。

```bash
node <扩展目录>/out/cli.js upgrade plan <项目>                     # 只读，产出 plan.json + pom.diff
node <扩展目录>/out/cli.js upgrade apply <项目> --plan <id>         # 预览 diff，不动 pom
node <扩展目录>/out/cli.js upgrade apply <项目> --plan <id> --hash <pomHash> --group framework --write
node <扩展目录>/out/cli.js upgrade apply <项目> --plan <id> --hash <hashAfter> --only a:b,c:d --write
node <扩展目录>/out/cli.js upgrade check <项目> --plan <id>         # pending / partial / applied / drift
node <扩展目录>/out/cli.js upgrade revert <项目> --plan <id>        # 回到计划前快照
node <扩展目录>/out/cli.js integrate <项目> --all                  # 写策略/启动器/Skill 与各编辑器适配器
node <扩展目录>/out/cli.js integrate <项目> --all --check          # 漂移检测，不写文件
```

- 目标版本由 `.quality-center/upgrade-policy.json` 的 `frameworkTargets` 按 Java 版本推导，不再写死版本号；Java 17 未声明上限时只跳过框架层并给出原因，不会静默跳 3.x。
- 源码也要升 JDK 时，在策略里写 `targetJavaVersion`（如 `"17"`），并给同 key 配 `frameworkTargets`（如 `"17": "3.2.12"`）。计划会生成 `<java.version>` 迁移，并和 Boot 3.x 父 POM 一起进 `framework` 组；已授权的迁移不再要求跨线确认。
- **`qc next` / `quality_next` 是唯一入口**：它把扫描、计划、步骤、构建结果收敛成「一个状态 + 一个命令 + 为什么」，同时刷新 `.quality-center/handoff.md`；新会话或新 Agent 读这一页就能接上，不用自己推断流程。
- **构建失败先 `qc explain` / `quality_explain`**：把 `Non-resolvable import POM`、坐标不存在、依赖解析失败、编译错误、收敛冲突翻译成原因/影响/建议；`build-result.json` 记录每次构建（成功也记），`next` 不会靠日志时间猜。
- 候选带 `group`：`framework → family → independent → cross-line`，AI/CI 一组一组推进；一组没通过构建就停在 `partial`，不会把整条依赖链一次性怼进 pom。
- 升级前会告警“项目属性覆盖框架 BOM”（如 `okhttp.version`、`kotlin.version`），这是框架组落盘后最常见的 `Non-resolvable import POM` 来源。
- `apply` 必须带当前 `pomHash`，不一致直接拒绝；整份计划一次落盘时，结果还要与 `pomHashAfter` 逐字节一致。
- 跨大版本（poi 4→5、mssql 8→13 等）默认拒绝写入，需要显式 `--allow-cross-line` 或人工处理。
- 需要新增 `<dependencyManagement>` 才能固定的传递依赖 CVE 默认只报告：策略里 `allowDependencyManagement` 为 `false` 时，候选会带“未授权”原因跳过，不把 AI 引向手改 pom；确认版本组合可靠后再显式打开。
- **同一时间只允许一个活动计划**：已有 `pending/partial` 计划时，`upgrade plan` / `quality_upgrade_plan` 会拒绝再生成第二个（CLI 用 `--replace`、MCP 用 `replace=true` 才能显式替换）；已 `revert` 的计划不再占用“当前计划”。
- 每次落盘都记录 `steps.json` 与 `pom.before.xml`，`upgrade revert` 可回到计划前状态；手工改过 pom 时回滚会被拒绝。
- `integrate` 生成 `.quality-center/bin/qc.cjs` 启动器，MCP 配置统一写成它的**项目内绝对路径**并带 `cwd`（Trae 不展开 `${workspaceFolder}`）；扩展升级后不需要改各编辑器的配置；已适配 Trae / Cursor / VS Code / Copilot 与 Claude 风格 `.mcp.json`。面板检测到配置里仍是字面量变量时会显示“MCP 配置未展开变量”。
- 生成物按“目录集中”原则组织：策略、启动器、Skill、扫描结果与升级计划全在 `.quality-center/` 内，并自带 `.gitignore`（只放行策略/启动器/Skill）；编辑器目录里只留 ≤10 行的指针文件。默认只为检测到的编辑器生成，额外要 `AGENTS.md` 与根 `.mcp.json` 时加 `--fallback`。

### 交给 AI 的入口

插件负责判定、出补丁、守门禁；需要判断或排障时把现场交给编辑器 / CLI 里的 AI，而不是等插件更新。

- 升级预览面板：**「复制给 AI 继续」**（含当前计划、分组顺序、pomHash 与硬性规则）
- 升级向导卡：**「复制给 AI 全权推进」**（现在只复制一句 MCP 入口；AI 先调 `quality_agent_brief`，由插件返回完整驱动指令与状态，不再手工粘贴长 prompt）
- MCP：`quality_agent_brief` 是“全权推进”的唯一入口，返回 `prompt + next`；`mode=autopilot` 会先做一次目标确认（范围/JDK 边界/门禁），确认后连续执行到收尾，只有 JDK 11/17/21、Boot 3 等硬阻塞再询问，最后强制复扫
- **AI 在 MCP 里做的事会实时投影到面板**：MCP/CLI 每次工具调用写 `.quality-center/run-state.json` 与 `events.jsonl`，面板监听这些事实文件重建台账并显示“AI 执行中 / 阶段 / 最近工具 / 多久前更新”；AI 运行中面板进入只读态，隐藏所有人工写操作（扫描/修复/升级向导/问题级操作），只展示 AI 阶段；AI 不再驱动猫咪进度条，避免 run-state 抖动导致面板闪烁
- 收尾必须调 `quality_finalize`：修复前/后、按来源变化、首次可见、计划进度、构建/测试与阻塞都由插件从基线快照和事实文件算，AI 只转述，不再自己数；`quality_finalize` 会拒绝早于源码/pom 变更的旧扫描，面板同时展示最终验收，AI 没写最终报告时面板自动补一次完整复扫
- 工具面板顶部有 MCP 状态条：检测 `.trae/.cursor/.vscode/.mcp.json` 配置，并启动 `qc.cjs mcp` 做 `initialize + tools/list` 自检；Trae 已启用并连上后，MCP 服务写 `.quality-center/mcp-client.json` 心跳，面板校验 pid 后显示“MCP 已接入 · Trae”，否则只显示“已配置 · 需在 IDE 启用”
- 首次打开面板若发现 MCP 未配置/异常，会弹一次安装提示，可直接生成/修复；可用 `qualityCenter.mcp.notifyMissing=false` 关闭
- 编译失败弹窗：**「复制给 AI」**（附带 Maven 尾部与「已还原 pom」的事实）
- 命令面板：`quality-center: 复制 AI 启动指令（升级）`（协助模式）、`quality-center: 复制 AI 全权推进指令（升级）`（全权模式）

指令里只放“去读哪里、按什么顺序、什么不许做”，事实源仍是 `.quality-center/issues.json`、`report.md`、`plan.json` 与 MCP 的 `quality_report`，不重复搬运上下文。配套的 `quality_upgrade_check` / `quality_upgrade_revert` 让 AI 能自己确认是否真落地、失败能自己回滚。

约定：stdout 只放结果，进度和日志全部走 stderr；退出码 `0` 通过、`1` 有达到阈值的问题（默认 `high`）、`2` 工具缺失或执行失败、`3` 用法错误。扫描结果同时写 `.quality-center/issues.json`、`report.md` 与 `report.sarif`。

`--sarif` 输出标准 SARIF 2.1.0（`runs[0].tool.driver` + `results[].locations`），GitHub Actions 里可直接 `upload-sarif` 到 code scanning；`--gha` 则输出 `::error/::warning file=…,line=…,title=规则::消息` 形式的注解，适合不想接 code scanning 的流水线。两者可以一起用。

`--json` 输出 `schemaVersion: "2"` 的 `AgentPayload`：`summary`（按严重度与来源计数）、`issues`（含相对路径 `file`、绝对路径 `abs`、`rule`、`zhSummary`、`advice`、`fixable`、`package`/`installedVersion`/`fixedVersion`/`cvss`）、`ignored`、`suggestions`（根因级方案）、`skipped`、`errors`、`missingTools`、`nextActions`。字段只增不减，结构变化时升版本号。

`fix` 覆盖与面板「一键修复」相同的四条确定性规则（`UnusedImports`、`RedundantImport`、`ModifierOrder`、`SimplifyBooleanExpression`），不碰其他问题；删除类规则只删真正的 `import` 行，行号漂移时宁可不改。

### Skills

`skills/` 内含五个 Skill 与机器可读清单：

| Skill | 触发场景 |
| --- | --- |
| `quality-center-scan` | 跑扫描、读结果、判断严重度与交付口径 |
| `quality-center-tools` | 缺 mvn / gitleaks / trivy 时自动安装，或先构建产物 |
| `quality-center-dependencies` | 按 CVE 修复版本升级 pom，整组对齐 BOM/父 POM 并编译校验 |
| `quality-center-java-upgrade` | 标准化升级整改：审计划、组件替换、死代码、CORS 与凭证、构建与复扫验收 |
| `quality-center-mcp` | 把插件接成 MCP 服务端，按工具语义编排调用顺序 |

`skills/manifest.json` 声明 CLI 入口、命令、退出码、MCP 工具与 Skill 路径，支持清单式发现；把对应 `SKILL.md` 放进 agent 的 skills 目录即可加载。CLI/MCP 的修复只做确定性改写，依赖升级与语义修复由 agent 按 Skill 指引完成并复扫确认。

## 安全规则覆盖度与缺口

插件维护一份规则清单 [`docs/RULES.md`](docs/RULES.md)：每条风险映射到 CWE、规则 ID、当前状态（已覆盖 / 缺口）和 fixture 用例。覆盖度是可量化口径，不承诺 100%，缺口写在表里：

```bash
npm run rules:matrix        # 跑 fixtures/ 下的正例与反例，输出 PASS / GAP / FAIL
```

代码层由 SpotBugs + FindSecBugs 1.14（144 个 pattern）承担，可检出宽松 CORS（`PERMISSIVE_CORS`）、关闭 CSRF（`SPRING_CSRF_PROTECTION_DISABLED`）、硬编码口令、SQL 注入、XXE、反序列化、路径穿越等；配置层由内置 `qcsec` 承担，覆盖 Druid 面板默认口令与公网绑定、Druid `filters` 含 `config`、面板 `allow` 留空、`allowMultiQueries`、Actuator 全暴露 / `health.show-details=always` / `base-path=/` / Gateway 端点、CORS 通配源、明文口令、devtools、SSL 关闭、Swagger/Knife4j 文档开放、Knife4j 关 Basic 认证、Redis 空口令、中间件默认账号、Spring Security 内置账号、Nacos 关闭鉴权 / 身份标识未换 / token 密钥未换、Kafka SASL 明文口令、JDBC 关闭 TLS、MySQL 公钥获取、错误堆栈回传、SQL 与根日志 DEBUG、默认激活 dev profile、会话 Cookie 标志、会话超时过长、静态资源映射本地目录共 36 条配置规则，外加 MyBatis 的 `${}`（按 ORDER BY/LIMIT 位置分级，并标注所属 `<sql>` 片段与被哪个语句引用）与 `statementType="STATEMENT"` 2 条 Mapper 规则；源码语义层由 `astgrep` 承担，覆盖 `permitAll()` 敏感路径（含常量/`@Value` 默认值与 `web.ignoring()`）、日志敏感字段、上传缺少校验、SQL 字符串拼接（含 `String.format`、`StringBuilder` 链式 append、变量中转）、`@CrossOrigin` 通配、SpEL/OGNL 注入、命令执行拼接、MyBatis 注解 SQL、SSRF、PrintWriter 与 Thymeleaf/JSP 未转义输出、上传路径穿越、Zip Slip、开放重定向、XXE、不安全随机数、JWT 不验签、时序比较、会话 Cookie 标志、任意文件读取、SSTI（含 FreeMarker/Velocity 源码级注入）、LDAP/JDBC/日志注入、敏感字段打印、反序列化、上传扩展名校验共 27 条规则。当前矩阵 91 个用例全部转绿（`PASS 91 / GAP 0 / FAIL 0`）。

`astgrep` 的引擎是 `@ast-grep/napi` + `@ast-grep/lang-java`（Java 语法为 wasm），打包时会把 Windows x64/arm64、macOS x64/arm64、Linux x64/arm64 六个平台的二进制一起放进 vsix（约 13 MB），用户侧无需再下载；第三方平台（如 musl 发行版）会在「已跳过」里注明「AST 引擎不可用」，其余五类扫描照常。

FindSecBugs 只能通过 pom 的 `<build><plugins>` 生效——`spotbugs-maven-plugin` 的 `plugins` 参数没有 userProperty，`-Dspotbugs.plugins` 实际传不进去（0.17.19 及以前就是这样静默失效的）。现在插件会复制一份 `.qc-spotbugs-pom.xml` 注入后再运行、结束即删；项目自己配了 FindSecBugs 时不动原文件；非 Maven 工程降级为核心规则并把原因作为扫描异常上报。多模块工程目前只注入根 pom。

SpotBugs 失败时会给出真正的原因（`Failed to execute goal` 段落或 POM/依赖解析的关键行），完整 Maven 输出写到 `.quality-center/logs/spotbugs.log`；若报告目录写不进去（只读、被杀软/编辑器占用、路径异常），会自动把占位文件挪到 `.bak-<时间戳>` 后重跑，仍失败则把报告改写到 `.quality-center/spotbugs-out`。

## 隐私与安全

- 所有扫描均在本机执行，不上传任何代码
- 密钥扫描结果只保留规则、文件与行号，**不展示、不导出密钥原文**
- Trivy 首次运行需要联网下载漏洞数据库（约 50 MB），之后自动缓存

## 自动执行

打开项目后自动扫描，保存文件后 1.5 秒自动复扫，全程无需手动执行命令：

| 触发时机 | 行为 |
| --- | --- |
| 打开项目 | 先展示上次结果，再后台自动扫描六类问题 |
| 保存文件 | 仅当保存的是 java/xml/properties/yml/toml/json 等文件时触发，防抖 1.5 秒 |
| 点击「一键修复」 | 修完自动复扫验证 |
| 点击「构建并扫描」 | 执行 `mvn -B -DskipTests package` 后自动复扫；构建过程实时显示当前模块/阶段与用时，成功会报出 target 下的 jar 并注明耗时，失败给出末尾几行原因与「查看日志」，可取消 |

后台扫描期间，面板继续展示上一次的结果，只有扫描完成后才整体替换，不会闪成空白；顶部会显示猫咪进度条：每个待执行扫描器对应一只不同品种的猫咪（橘猫、狸花、奶牛、黑猫、白猫、三花、暹罗、蓝猫、银渐层、玳瑁），猫队持续从左向右循环奔跑，蓝色填充按完成度增长，完成一项就减少一只，同时标注当前运行的扫描器、已完成数量和已用时间。深度修复与依赖升级也复用这条进度条，按执行阶段显示多只猫咪和「第 N/M 步」。

### 扫描速度

每个扫描器都会按「文件指纹」复用上一次的结果，指纹不变时直接跳过执行：

| 扫描器 | 指纹依据 | 未变化时的耗时 | 实际耗时 |
| --- | --- | --- | --- |
| SpotBugs | `target/classes/**/*.class` + pom | 不执行 Maven | 约 33 秒 |
| Checkstyle | `src/**/*.java` + 规则文件 + pom | 不执行 Maven | 约 14 秒 |
| Trivy | pom + `target/**/*.jar|pom` | 不执行 trivy | 约 3 秒（漏洞库 12 小时内更新过） |
| Gitleaks | 每次执行（本身约 1 秒） | 1 秒 | 1 秒 |
| qcsec | 每次执行（纯文本解析） | 0 秒 | 小于 100 毫秒 |
| astgrep | 每次执行（ast-grep 解析 Java 语法树） | 0 秒 | 1~3 秒（按源码量） |

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
| 快速模式 | 勾选代码质量、密钥泄露、依赖漏洞、配置安全、语义规则，关闭 SpotBugs（约 15 秒） |
| 完整模式 | 六类检查全部开启（约 35 秒） |
| 代码质量 / 密钥泄露 / 依赖漏洞 / 静态缺陷 / 配置安全 / 语义规则 | 单独开关某一类扫描 |
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

## 发布与文档同步

`README.md` 不只是仓库说明：`vsce package` 会把它打进扩展包，**Open VSX / VS Code 市场的扩展介绍页正文就是这份 README**，`package.json` 的 `description` 则用于搜索结果与列表摘要。所以每次发版前文档必须是最新的，否则商店页会停留在旧功能说明。

`npm run release` 已经内置了这一步的校验：发布前会检查 README 是否覆盖 `package.json` 里声明的**每一个配置项**与**每一条命令标题**、是否还残留旧版本号示例、`description` 是否为空或过长；任何一项不达标都会直接中止发版，提示缺哪些内容（临时可用 `--skip-docs` 跳过）。

发版流程本身：

```
npm run release   →  校验工作区/分支/tag + README 覆盖度
                  →  bump package.json / package-lock.json
                  → 补 CHANGELOG 段落（缺则用上个 tag 以来的提交生成）
                  →  tsc 编译 + vsce 打包校验
                  →  commit + tag v<version> + push
                  →  gh release create（触发 publish.yml）
                  →  等 Actions 结果 + 确认 Open VSX latest 已指向新版本
```

`publish.yml` 只监听「Release 被发布」和手动触发，**推 `main` 不会发版**。前提是仓库 Secrets 里配置了 `OVSX_TOKEN`（open-vsx.org → Settings → Access Tokens，命名空间需已创建）。

手动发布（脚本不可用时）：

```bash
npm run package
npx ovsx publish quality-center-<version>.vsix -p <YOUR_TOKEN>
```

## 许可证

MIT
