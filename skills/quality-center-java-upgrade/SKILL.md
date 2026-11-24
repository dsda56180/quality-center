---
name: quality-center-java-upgrade
description: 按 quality-center 的标准化流程完成一次 Java 项目依赖与配置安全整改：先出计划与 pom 补丁，再由 AI 处理必须看代码才能判断的部分（组件替换、死代码、CORS 过滤器链、凭证占位），最后按构建门禁与复扫验收。
---

# Java 项目升级整改（标准化流程）

本 Skill 只写「必须判断」的部分。执行顺序、写回方式由 `.quality-center/upgrade/<planId>/plan.json` 与
`.quality-center/bin/qc.cjs` 保证，**不要自己重排流程，也不要手写 pom**。

## 0. 前置

先调一次 `quality_status`（CLI: `qc status`）拿全局：工具就绪、最近扫描计数、计划分组进度、pom hash。不要分别调 report/check 去猜状态。

```bash
node .quality-center/bin/qc.cjs scan . --json --detail summary --top 10   # 只给计数 + Top N（或 quality_scan）
node .quality-center/bin/qc.cjs upgrade plan . --reuse                    # 同 hash 复用计划，不新建目录
```

计划里出现 `frameworkTarget: null` 或 `skipped` 提示「未声明框架目标版本」时：向用户确认该 Java 版本允许的
框架上限，写进 `.quality-center/upgrade-policy.json` 的 `frameworkTargets`，再重新 plan。**不要擅自跨大版本。**

## 1. 审阅计划（AI 的工作从这里开始）

读 `plan.json`，逐条判断：

- `candidates`：插件已按「同线最小修复 + BOM 整组对齐 + 上限裁剪」算好，只需核对 `note` 与业务是否冲突。
- `skipped`：必须逐条给出结论——是「策略禁用需替换」「无适用修复版本」「无法定位，人工处理」中的哪一种。
- `blockedByPolicy`：这些是被策略禁掉的依赖，处理方式见第 2 节。

禁止：把 `pom.diff` 拆开手工重写；调整候选顺序；把被跳过项静默丢弃。

## 2. 判断类任务（插件不做，AI 做）

### 2.1 组件替换

策略禁用的依赖（如 `com.alibaba:fastjson`）不是升级能解决的，要替换：

1. 先用引用搜索列出使用点：`grep -rn "com.alibaba.fastjson" --include=*.java`，按 `JSON.parseObject` / `JSONObject` / `SerializerFeature` 分类。
2. 输出替换清单（旧 API → 新 API），**先让用户确认**再改代码；改了必须复扫，确认对应规则消失。
3. 不确定语义等价时（如 `SerializerFeature.WriteMapNullValue`）标记为人工确认，不要猜。

### 2.2 死代码

插件只给候选（无引用的类/方法）。删除前必须确认三件事：无反射调用（`Class.forName` / `getDeclaredMethod`）、
无配置引用（XML/YAML/注解里的全限定名）、不是 SPI 或框架回调入口。任一条不确定就保留并在报告里说明。

### 2.3 CORS 与凭证

- CORS 必须在**过滤器层**生效：MVC 的 `addCorsMappings` 在 `SsoTokenFilter` 等自定义 Filter 之后执行，
  `Access-Control-Request-Headers` 会因过滤器短路不回 CORS 头。定位顺序：`web.xml` → `@WebFilter` → `FilterRegistrationBean`，
  找到真正在链上的那个再改，改完用非法 Origin 实测，不能只看配置项已存在。
- 凭证写 `${ENV:原变量名}` 前先确认原值来源（配置中心/启动脚本/env），键名保持可读；改完用 `grep` 复核仓库内无明文残留。

### 2.4 框架大版本

只有策略允许（`allowNextFrameworkLine: true`）时才讨论跨大版本。此类改动一律要求：跑全部单测、
给出破坏性变更清单、单独分支，不与 CVE 修复混在一个提交里。

## 3. 落盘与验收（按组推进，禁止一次全量）

计划的 `candidates` 带 `group`，按 `framework → family → independent → cross-line` 依次推进，一组一验证：

```bash
# 1) 框架先落地并验证
node .quality-center/bin/qc.cjs upgrade apply . --plan <planId> --hash <当前 pomHash> --group framework --write
node .quality-center/bin/qc.cjs upgrade check . --plan <planId>        # partial = 还有分组未落盘
node .quality-center/bin/qc.cjs build .                                # 失败只读 errors 的 file/line，全文在 .quality-center/build.log
node .quality-center/bin/qc.cjs scan . --json --only trivy --delta      # 复扫只看新增/消失，别要全量

# 2) 通过后继续下一组；--hash 用上一步返回的 hashAfter
node .quality-center/bin/qc.cjs upgrade apply . --plan <planId> --hash <上一步 hashAfter> --group family --write

# 3) 独立依赖可以精确到包
node .quality-center/bin/qc.cjs upgrade apply . --plan <planId> --hash <hash> --only a:b,c:d --write

# 4) 跨大版本必须显式确认（默认会被拒绝并列出包名）
node .quality-center/bin/qc.cjs upgrade apply . --plan <planId> --hash <hash> --only x:y --allow-cross-line --write

# 5) 失败回滚到计划前快照
node .quality-center/bin/qc.cjs upgrade revert . --plan <planId>
```

MCP 等价：`quality_upgrade_plan` → `quality_upgrade_apply(group=…, write=false)` → `write=true` → `quality_build`
（`errors` 已解析出文件/行号）→ `quality_upgrade_check`（`state=applied` 才算完成）→ 失败时 `quality_upgrade_revert`。

验收四条，缺一条不算完成：`upgrade check` 退出码 0；构建成功；目标 CVE 在复扫中消失；`errors` 为空。
涉及代码级改动时再跑单测（策略 `buildGate: test` 时强制）。

### 3.1 止损规则（硬性）

- 一轮只推进一组；这组没通过构建，不允许开下一组。
- 同一组连续两次构建失败：停手，回滚到该组之前，说明两次失败差异与判断，**不要继续换版本碰运气**。
- 构建报错只按 `errors` 里的文件/行号定向修；禁止 `sed` 或批量替换 pom 版本号。
- 手工改过 pom 会让 `upgrade check` 变成 `drift`；此时必须停下来重新 `upgrade plan`，不得继续 `apply`。

## 4. 汇报

一条一行：`CVE-xxxx · 组件 当前版本 → 目标版本 · 理由（同线最小修复 / BOM 对齐 / 传递依赖覆盖 / 策略禁用替换）`，
并写明「已验证：构建通过 + 复扫无该 CVE」。被跳过或人工处理的项单独列，附原因与建议下一步。

## 5. 禁止事项

- 不为了扫描变干净改 `.trivyignore` / `baseline.json`，除非用户明确同意且有官方无修复版本证据。
- 不在没跑构建门禁的情况下说「升级完成」。
- 不跨大版本硬升，不隐去破坏性变更风险。
- 不把 AI 猜测的版本号写进 pom：版本只能来自 `fixedVersion` 或计划候选。
