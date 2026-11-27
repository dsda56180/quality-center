#!/usr/bin/env node
/**
 * prompt 事实一致性自检。
 *
 * 背景：prompt 里的 Java 级别、框架目标、buildGate 只允许由 plan.json /
 * upgrade-policy.json / pom 推导。这些值一旦被写回文案，同一段 prompt 就会出现
 * 两个版本边界（确认项说 Java 8，默认参数说 Java 11），AI 只会按先读到的那条走。
 *
 * 用法：npm run verify:prompt（需先 npm run compile）
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const outFile = path.join(repoRoot, 'out', 'agentPrompt.js');

if (!fs.existsSync(outFile)) {
  console.error('[verify:prompt] 缺少 out/agentPrompt.js，先执行 npm run compile');
  process.exit(1);
}
const { buildAgentPrompt } = require(outFile);

const failures = [];
const temps = [];

function check(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function expectContains(text, label, value) {
  check(text.includes(value), `${label}：缺少 "${value}"`);
}

function expectAbsent(text, label, value) {
  check(!text.includes(value), `${label}：不应出现 "${value}"`);
}

function pomFor(javaVersion, bootVersion) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>${bootVersion}</version>
  </parent>
  <groupId>verify</groupId>
  <artifactId>prompt-facts</artifactId>
  <version>1.0.0</version>
  <properties>
    <java.version>${javaVersion}</java.version>
  </properties>
</project>
`;
}

function makeProject(name, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qc-prompt-${name}-`));
  temps.push(dir);
  fs.writeFileSync(path.join(dir, 'pom.xml'), pomFor(options.javaVersion, options.bootVersion), 'utf8');
  if (options.policy) {
    fs.mkdirSync(path.join(dir, '.quality-center'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.quality-center', 'upgrade-policy.json'),
      `${JSON.stringify(options.policy, null, 2)}\n`,
      'utf8'
    );
  }
  return dir;
}

function promptOf(dir) {
  return buildAgentPrompt(dir, { mode: 'autopilot' });
}

try {
  // 1) Java 11 + Boot 2.1.18 + 项目策略 compile / 不跑测试
  {
    const dir = makeProject('java11', {
      javaVersion: '11',
      bootVersion: '2.1.18.RELEASE',
      policy: { buildGate: 'compile', runTests: false }
    });
    const text = promptOf(dir);
    const label = 'Java 11 / compile 项目';
    expectContains(text, label, 'Java 11');
    expectContains(text, label, '框架 2.1.18.RELEASE → 2.7.18');
    expectContains(text, label, 'buildGate=compile');
    expectContains(text, label, 'runTests=false');
    expectContains(text, label, '升到 17/21');
    expectAbsent(text, label, 'Java 8');
    expectAbsent(text, label, 'buildGate=package');
    expectAbsent(text, label, 'Spring Boot 2.7.18');
    const driveText = buildAgentPrompt(dir, { mode: 'drive' });
    expectContains(driveText, `${label}（drive）`, '计划按 Java 11');
    expectAbsent(driveText, `${label}（drive）`, 'Java 8');
  }

  // 2) Java 8 + Boot 2.4.2 + 没有策略文件（全部按默认推导）
  {
    const dir = makeProject('java8', { javaVersion: '8', bootVersion: '2.4.2' });
    const text = promptOf(dir);
    const label = 'Java 8 / 默认策略项目';
    expectContains(text, label, 'Java 8');
    expectContains(text, label, '框架 2.4.2 → 2.7.18');
    expectContains(text, label, 'buildGate=package');
    expectContains(text, label, '升到 11/17/21');
    expectAbsent(text, label, 'Java 11');
  }

  // 3) 策略已授权源码迁移到 Java 17 / Boot 3.2.12
  {
    const dir = makeProject('java17', {
      javaVersion: '8',
      bootVersion: '2.4.2',
      policy: {
        targetJavaVersion: '17',
        frameworkTargets: { '8': '2.7.18', '11': '2.7.18', '17': '3.2.12' },
        allowNextFrameworkLine: true
      }
    });
    const text = promptOf(dir);
    const label = '已授权迁移到 Java 17';
    expectContains(text, label, 'Java 8 → 17');
    expectContains(text, label, '框架 2.4.2 → 3.2.12');
    expectContains(text, label, '升到 21');
    expectAbsent(text, label, '升到 11/17/21');
  }

  // 4) 源码回潮扫描：这些文件里不允许再出现项目事实字面量
  const SOURCE_RULES = [
    ['src/agentPrompt.ts', /Java 8|JDK8|JDK 8|2\.7\.18|buildGate=package/, 'prompt 模板'],
    ['src/mcp.ts', /JDK8|JDK 8|默认 JDK/, 'MCP 工具描述'],
    ['src/extension.ts', /Spring Boot 3|JDK 11|JDK 17/, '面板复制文案'],
    ['src/suggest.ts', /2\.7\.18/, '升级建议'],
    ['src/projectProfile.ts', /2\.7\.18/, '项目画像建议']
  ];
  for (const [rel, pattern, label] of SOURCE_RULES) {
    const file = path.join(repoRoot, rel);
    if (!fs.existsSync(file)) {
      failures.push(`${label}：找不到 ${rel}`);
      continue;
    }
    const body = fs.readFileSync(file, 'utf8');
    const match = pattern.exec(body);
    if (match) {
      const line = body.slice(0, match.index).split('\n').length;
      failures.push(`${label}：${rel}:${line} 又写死了 "${match[0]}"`);
    }
  }
} finally {
  for (const dir of temps) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响结论
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:prompt] 失败：');
  for (const item of failures) {
    console.error(`  - ${item}`);
  }
  process.exit(1);
}

console.log('[verify:prompt] 通过：3 个项目场景的边界/门禁均跟随 pom 与策略，源码无回潮字面量');
