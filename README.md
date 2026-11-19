# Quality Center 质量中心

把 **代码质量**、**密钥泄露**、**依赖漏洞（CVE）** 三类检查聚合到一个 IDE 侧边栏面板里，结果可一键复制给 AI 修复。

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
code --install-extension dongxin.quality-center
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

## 命令

| 命令 | 说明 |
| --- | --- |
| `质量中心：重新扫描` | 立即执行全部扫描 |
| `质量中心：复制报告为 Markdown` | 把当前结果复制到剪贴板 |
| `质量中心：导出报告文件` | 保存为 `.md` 并打开 |

## 隐私与安全

- 所有扫描均在本机执行，不上传任何代码
- 密钥扫描结果只保留规则、文件与行号，**不展示、不导出密钥原文**
- Trivy 首次运行需要联网下载漏洞数据库（约 50 MB），之后自动缓存

## 发布

```bash
# 打包
npm run package

# 发布到 Open VSX（需先在 open-vsx.org 创建命名空间并获取 token）
npx ovsx publish quality-center-0.1.0.vsix -p <YOUR_TOKEN>

# 发布到 VS Code 市场
npx vsce publish -p <YOUR_PAT>
```

发布前请修改 `package.json` 中的 `publisher` 与 `repository` 字段。

## 许可证

MIT
