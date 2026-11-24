---
name: quality-center-tools
description: 检查并自动安装 quality-center 依赖的外部工具（Maven / gitleaks / trivy），以及在扫描前先构建 jar 产物。当扫描结果显示「缺失工具」或哈希提示需要构建产物、用户要求「把工具装上 / 先构建再扫」时使用。
---

# 工具就绪与构建产物

quality-center 自己不下载可执行文件，它调用本机已有的 `mvn`、`gitleaks`、`trivy`。
缺少任何一个，对应扫描器会被跳过（结果里的 `skipped` + `missingTools`），此时结论是不完整的。

## 1. 先看状态

```bash
node <扩展目录>/out/cli.js tools status          # 人读
node <扩展目录>/out/cli.js tools status --json   # 机器读
```

输出字段：`id`、`bin`、`found`、`path`、`installable`、`plan`、`docs`。

- `found: true` 就不用再装。
- `installable: true` 表示当前系统有可执行的自动安装方案（Windows winget / Chocolatey / Scoop / 官方产物便携安装；macOS、Linux Homebrew / 官方产物便携安装）。
- `installable: false` 且 `requiresRoot` 方案时，CLI 会打印需要 sudo 的命令，交给用户执行。

## 2. 安装

```bash
node <扩展目录>/out/cli.js tools install mvn
node <扩展目录>/out/cli.js tools install gitleaks
node <扩展目录>/out/cli.js tools install trivy
```

- 进度打到 stderr（下载百分比、解压、校验），完成时打印最终路径。
- 便携安装落在插件自己的目录：Windows `%LOCALAPPDATA%\quality-center\tools`，macOS/Linux `~/.quality-center/tools`，不改系统 PATH；插件查找可执行文件时也会扫这里。
- Maven 便携安装优先走华为云镜像，失败回退 Maven Central / Apache archive；gh 源慢时会等待，不要在中途重复触发第二个安装。
- 退出码 `0` 成功、`2` 失败（附末尾输出）、`3` 工具 id 写错。

## 3. 构建 jar

Trivy 需要 `pom.xml` 或 `target/` 下的 jar，SpotBugs 需要 `target/classes`：

```bash
node <扩展目录>/out/cli.js build <项目目录>
```

- 执行 `mvn -B -DskipTests package`，进度（模块名 / 阶段 / BUILD SUCCESS）打到 stderr。
- 成功打印 `target` 下的 jar 名；失败打印退出码与末尾几行原因，退出码 `2`。
- 构建完再 `scan`，`buildHint` 与 `skipped` 里的「需要构建」应消失。

## 4. 顺序建议

1. `tools status` → 缺什么装什么。
2. 有 `pom.xml` 且 `target/` 为空时先 `build`。
3. 再 `scan`，确认 `missingTools` 为空、`skipped` 里没有「缺少工具」。

## 5. 禁止事项

- 不要用 `curl`/`wget` 自己下二进制装到系统 PATH；用 `tools install`，否则插件可能找不到。
- 不要同时跑两个安装（会争抢同一个临时目录与下载文件）。
- 不要在没有确认 `tools status` 的情况下断言「扫描通过」。
