#!/usr/bin/env node
/** 报告结构检查：核心内容在前，详细清单默认折叠，分布图使用方块条 */
const assert = require('assert');
const { toMarkdown } = require('../out/report.js');

const issues = [
  {
    source: 'checkstyle',
    severity: 'high',
    file: '/repo/src/main/java/Demo.java',
    line: 12,
    rule: 'ModifierOrder',
    message: '修饰符顺序不规范',
    advice: '按 JLS 顺序调整'
  },
  {
    source: 'checkstyle',
    severity: 'low',
    file: '/repo/src/main/java/Demo.java',
    line: 18,
    rule: 'EmptyStatement',
    message: '空语句'
  },
  {
    source: 'trivy',
    severity: 'critical',
    rule: 'CVE-2026-0001',
    packageName: 'org.example:demo',
    installedVersion: '1.0.0',
    fixedVersion: '1.0.1',
    cvss: 9.8,
    zhSummary: '演示组件存在严重漏洞'
  },
  {
    source: 'gitleaks',
    severity: 'high',
    file: '/repo/src/main/resources/application.yml',
    line: 3,
    rule: 'generic-api-key',
    message: '疑似硬编码密钥'
  }
];

const result = {
  startedAt: Date.now() - 5000,
  finishedAt: Date.now(),
  issues,
  ignored: [],
  errors: [{ source: 'spotbugs', message: '未找到 target/classes' }],
  skipped: [{ source: 'spotbugs', reason: '需要先编译' }],
  suggestions: [
    { category: 'manual', title: '先处理严重漏洞', detail: '升级演示组件到修复版本。', impact: 1 }
  ],
  buildHint: '未使用构建产物，静态缺陷可能不完整'
};

const markdown = toMarkdown(result, '/repo');

assert(markdown.startsWith('# 代码质量与安全报告'), '标题应在最前');
assert(markdown.includes('## 核心看板'), '应包含核心看板');
assert(markdown.includes('| 问题总数 | 严重 + 高危 | 可自动修复 | 涉及文件 | 依赖组件 |'), '应包含看板指标');
assert(markdown.includes('### 严重度分布'), '应包含严重度分布');
assert(markdown.includes('### 来源分布'), '应包含来源分布');
assert(markdown.includes('### 高风险组件 Top 5'), '应包含高风险组件');
assert(markdown.includes('## 详细清单\n'), '应包含详细清单标题');
assert(!markdown.includes('（默认折叠）'), '标题不应出现“默认折叠”字样');
assert(markdown.includes('<details><summary><strong>依赖漏洞'), 'CVE 明细应折叠');
assert(markdown.includes('<details><summary><strong>代码质量'), '逐文件清单应折叠');
assert(markdown.includes('█'), '分布应使用方块条');
assert(markdown.indexOf('## 核心看板') < markdown.indexOf('## 详细清单'), '核心内容必须在详细清单前');

console.log('报告结构检查通过');
