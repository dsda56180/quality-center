---
name: quality-center-java-upgrade
description: 按 quality-center 的标准化流程完成一次 Java 项目依赖与配置安全整改：先出计划与 pom 补丁，再由 AI 处理必须看代码才能判断的部分（组件替换、死代码、CORS 过滤器链、凭证占位），最后按构建门禁与复扫验收。
---

# Java 项目升级整改（标准化流程）

本 Skill 只写「必须判断」的部分。执行顺序、写回方式由 `.quality-center/upgrade/<planId>/plan.json` 与
`.quality-center/bin/qc.cjs` 保证，**不要自己重排流程，也不要手写 pom**。

## 0. 前置

```bash
node .quality-center/bin/qc.cjs scan . --json --fail-on none   # 或 quality_scan
node .quality-center/bin/qc.cjs upgrade plan .                 # 只读 pom，产出 plan.json + pom.diff
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

## 3. 落盘与验收

```bash
node .quality-center/bin/qc.cjs upgrade apply . --plan <planId> --hash <pomHash>            # 预览 diff
node .quality-center/bin/qc.cjs upgrade apply . --plan <planId> --hash <pomHash> --write    # 落盘
node .quality-center/bin/qc.cjs upgrade check . --plan <planId>                             # 必须为 0
node .quality-center/bin/qc.cjs build .                                                     # 构建门禁
node .quality-center/bin/qc.cjs scan . --only trivy --json --fail-on none                   # 复扫
```

MCP 等价：`quality_upgrade_plan` → `quality_upgrade_apply(write=false)` → `write=true` → `quality_build` → `quality_scan`。

验收四条，缺一条不算完成：`upgrade check` 退出码 0；构建成功；目标 CVE 在复扫中消失；`errors` 为空。
涉及代码级改动时再跑单测（策略 `buildGate: test` 时强制）。

## 4. 汇报

一条一行：`CVE-xxxx · 组件 当前版本 → 目标版本 · 理由（同线最小修复 / BOM 对齐 / 传递依赖覆盖 / 策略禁用替换）`，
并写明「已验证：构建通过 + 复扫无该 CVE」。被跳过或人工处理的项单独列，附原因与建议下一步。

## 5. 禁止事项

- 不为了扫描变干净改 `.trivyignore` / `baseline.json`，除非用户明确同意且有官方无修复版本证据。
- 不在没跑构建门禁的情况下说「升级完成」。
- 不跨大版本硬升，不隐去破坏性变更风险。
- 不把 AI 猜测的版本号写进 pom：版本只能来自 `fixedVersion` 或计划候选。
