---
name: quality-center-scan
description: 用 quality-center 的无界面 CLI 对一个仓库做代码质量、密钥泄露、依赖漏洞(CVE)、字节码静态缺陷四类扫描，拿到结构化问题清单后再动手改代码。当用户要求「跑一下质量检查 / 扫一遍安全问题 / 看看有哪些 CVE / 提交前做个门禁」时使用。
---

# quality-center 扫描与结果解读

quality-center 是一个 VS Code 系插件（publisher `dsda56180`），除了侧边栏面板，还提供了无界面 CLI：
同一套扫描器、同一份基线，可在纯 Node 环境跑，供 agent 与 CI 调用。

## 1. 定位 CLI

按顺序尝试，命中即用（`<ver>` 为已安装版本）：

```bash
# 1) 编辑器扩展目录（Windows 示例，macOS/Linux 把 HOME 换成对应路径）
ls "$HOME/.trae-cn/extensions/" 2>/dev/null | grep quality-center
ls "$HOME/.vscode/extensions/"  2>/dev/null | grep quality-center
# 2) 仓库内开发版
ls out/cli.js 2>/dev/null
```

确定路径后统一用 `node <扩展目录>/out/cli.js` 调用，下称 `qc`：

```bash
qc() { node "$HOME/.trae-cn/extensions/dsda56180.quality-center-<ver>/out/cli.js" "$@"; }
qc version    # 打印版本，先确认能跑
qc tools status
```

如果找不到任何安装，说明用户没装插件：提示他执行 `npm run release`/安装 vsix，不要自己下载二进制。

## 2. 跑扫描

```bash
qc scan                                  # 当前目录，四类全扫，人读摘要
qc scan --json --fail-on high            # 机器读：JSON 到 stdout，进度在 stderr
qc scan --only trivy,spotbugs --json     # 只跑指定扫描器
qc scan --fail-on none --json            # 只取数据，不要退出码
```

- **stdout 只有结果**（`--json` 时是 `AgentPayload`），进度/日志一律在 stderr，可放心 `2>/dev/null`。
- 退出码：`0` 通过、`1` 有达到阈值的问题（默认 `high`）、`2` 工具缺失或执行失败、`3` 用法错误。
- 结果同时写到 `<项目>/.quality-center/issues.json` 与 `report.md`；`--no-export` 可关闭。
- 配置来自 `<项目>/.vscode/settings.json` 的 `qualityCenter.*`，缺省值与插件一致。

## 3. 读输出（schemaVersion = 2）

```json
{
  "schemaVersion": "2",
  "summary": { "total": 10, "critical": 0, "high": 1, "medium": 3, "low": 6,
               "ignored": 0, "checkstyle": 1, "gitleaks": 0, "trivy": 8, "spotbugs": 1 },
  "issues": [
    { "id": 1, "source": "trivy", "severity": "high", "rule": "CVE-2023-6378",
      "file": "pom.xml", "abs": "D:\\proj\\pom.xml", "line": 0,
      "zhSummary": "…中文摘要…", "advice": "…修复建议…",
      "fixable": false, "package": "ch.qos.logback:logback-core",
      "installedVersion": "1.2.3", "fixedVersion": "1.3.12, 1.4.12, 1.2.13" }
  ],
  "ignored": [], "suggestions": [], "errors": [], "skipped": [],
  "missingTools": [], "buildHint": "", "nextActions": []
}
```

要点：

- `issues[].file` 是相对路径、`abs` 是绝对路径，改代码用 `abs`。
- `fixable: true` 只表示「面板的一键修复」能处理（`UnusedImports` / `RedundantImport` / `ModifierOrder` / `SimplifyBooleanExpression`），其余由你按 `advice` 手改。
- `skipped` 说明某类扫描没跑成（配置关闭 / 缺工具 / 缺构建产物），不要把它当成「没有问题」。
- `missingTools` 非空时退出码是 `2`，先装工具再重扫，别基于不完整结果下结论。
- `nextActions` 是插件给出的下一步建议，可直接照做。

## 4. 判断与交付

1. 先看 `summary` 与 `skipped`：确认四类都真的跑了。
2. `critical/high` 逐条处理；`fixable` 的直接改；CVE 按 `fixedVersion`（注意「同一版本线内取最小修复」，BOM 管理的依赖要整组对齐）。
3. 改完必须重扫，对比 `summary.total` 与相关条目是否消失。
4. 汇报时引用 `rule`、`file:line`、`installedVersion → fixedVersion`，不要凭记忆编造 CVE 编号或版本号。

## 5. 禁止事项

- 不要为了「过门禁」而调用 `--fail-on none` 掩盖真实问题，除非用户明确要求只看报告。
- 不要改动 `.quality-center/baseline.json` 来让问题消失；如要忽略必须由用户确认。
- 不要假设工具已安装：`qc tools status` 是唯一事实来源。
