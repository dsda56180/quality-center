# quality-center Agent Kit

给 AI agent 用的接口包：一个无界面 CLI（`out/cli.js`）+ 三个 Skill。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `manifest.json` | 机器可读入口：CLI 命令、退出码、Skill 清单与触发条件 |
| `quality-center-scan/SKILL.md` | 扫描与结果解读（四类检查、AgentPayload v2） |
| `quality-center-tools/SKILL.md` | 检查/安装外部工具、构建 jar 产物 |
| `quality-center-dependencies/SKILL.md` | 按 CVE 修复版本升级 pom 并校验 |

## 怎么接入

1. **CLI 路径**：扩展装在哪，CLI 就在哪 —— `<扩展目录>/out/cli.js`（扩展内已编入，无需额外安装）。
2. **Skill 加载**：把对应的 `SKILL.md` 放进 agent 的 skills 目录即可；`manifest.json` 供支持清单式发现的框架读取。
3. **验证连通性**：

```bash
node <扩展目录>/out/cli.js version
node <扩展目录>/out/cli.js tools status
node <扩展目录>/out/cli.js scan --only gitleaks --json --fail-on none
```

## 约定

- stdout 只放结果，进度与日志在 stderr；`--json` 输出 `AgentPayload`（`schemaVersion: "2"`）。
- 退出码：`0` 通过、`1` 有达到阈值的问题、`2` 工具缺失/执行失败、`3` 用法错误。
- 扫描结果同时落盘到 `<项目>/.quality-center/issues.json` 与 `report.md`。
- 不做破坏性动作：CLI 只读扫描、构建、装工具；改代码与改 pom 由 agent 按 Skill 指引完成并复扫。
