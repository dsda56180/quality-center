---
name: quality-center-mcp
description: 把 quality-center 接成 MCP 服务端（stdio），让 agent 以工具调用方式直接跑扫描、构建、装工具和确定性修复，而不是记 CLI 参数。当用户要「把质量检查接进 MCP / 让 agent 直接调用插件能力 / 给 Trae 或 Cursor 配个质量工具」时使用。
---

# 通过 MCP 调用 quality-center

扩展包内自带 MCP 服务端：`node <扩展目录>/out/cli.js mcp`。
stdio + 换行分隔 JSON-RPC 2.0，零依赖，`protocolVersion` 默认 `2024-11-05`。

## 1. 配置

MCP 客户端配置（Trae / Claude Desktop / Cursor 通用）：

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

`<扩展目录>` 的找法：`~/.trae-cn/extensions/dsda56180.quality-center-<ver>`（VS Code 换成 `~/.vscode/extensions`）。

## 2. 工具与调用顺序

| 工具 | 参数 | 返回要点 |
| --- | --- | --- |
| `quality_tools_status` | 无 | `tools[]`：`found` / `path` / `installable` / `plan` |
| `quality_tools_install` | `tool`(必填) | `ok`、`path` 或 `requiresRoot` 命令 |
| `quality_build` | `path?` | `ok`、`seconds`、`jars[]`、`reason` |
| `quality_scan` | `path?` `only?` `failOn?` `exportFiles?` | `exitCode` + `AgentPayload`(schemaVersion 2) |
| `quality_report` | `format`(`summary`/`json`/`markdown`) | 上次落盘结果 |
| `quality_fix` | `path?` `write?` | `mode`、`applied`、`files[].changes[]` |

标准顺序：`quality_tools_status` → 缺则 `quality_tools_install` → 有 pom 且 `target/` 空则 `quality_build` → `quality_scan` →（`quality_fix` 预览 + 复核）。

- `quality_fix` 的 `write` 默认 `false`，先预览改动清单再决定是否落盘；落盘后必须重新 `quality_scan`。
- `quality_scan` 返回里 `missingTools` 非空时 `exitCode` 为 `2`：结论不完整，先装工具。
- `skipped[]` 非空表示某类扫描没跑成（配置关闭 / 缺工具 / 缺产物），不要当成「没问题」。
- 服务端串行处理请求，不要并发发多个 `quality_scan` / `quality_build`。

## 3. 判定与交付

1. 读 `summary`：确认五类扫描（含 `qcsec` 配置安全）都真的跑了。
2. `critical/high` 逐条处理；`fixable=true` 的用 `quality_fix`，其余按 `advice` 手改。
3. CVE 按 `fixedVersion`（同版本线取最小修复、BOM 整组对齐），改完 `quality_build` + `quality_scan` 复核。
4. 汇报引用 `rule`、`file:line`、`installedVersion → fixedVersion`，不编造 CVE 编号。

## 4. 禁止事项

- 不要用 `--failOn: none`（或忽略 `exitCode`）来宣布「通过」。
- 不要改 `.quality-center/baseline.json` 让问题消失；忽略必须由用户确认。
- 不要自己 `curl` 装二进制绕过 `quality_tools_install`，否则插件可能找不到。
