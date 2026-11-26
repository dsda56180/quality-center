import * as path from 'path';
import { FIXABLE_RULES } from './fixerCore';
import { Issue, ScanResult, SEVERITY_LABEL, SEVERITY_ORDER, SOURCE_LABEL } from './model';

function rel(root: string, file?: string): string {
  if (!file) {
    return '';
  }
  const relative = path.relative(root, file);
  return (relative || file).split(path.sep).join('/');
}

function clean(text: string | undefined, max = 160): string {
  if (!text) {
    return '';
  }
  const oneLine = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function cell(text: string | undefined, max = 160): string {
  return clean(text, max).replace(/\|/g, '\\|');
}

function pct(value: number, total: number): string {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '0%';
}

/** 用方块字符做轻量条形图，Markdown 预览和纯文本都能读 */
function bar(value: number, max: number, width = 16): string {
  if (value <= 0 || max <= 0) {
    return '·'.repeat(width);
  }
  const filled = Math.max(1, Math.round((value / max) * width));
  return '█'.repeat(filled) + '·'.repeat(Math.max(0, width - filled));
}

function rank(severity: Issue['severity']): number {
  return SEVERITY_ORDER.indexOf(severity);
}

function duration(result: ScanResult): string {
  const seconds = Math.max(0, (result.finishedAt - result.startedAt) / 1000);
  return seconds >= 60
    ? `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`
    : `${seconds.toFixed(1)} 秒`;
}

interface ComponentRisk {
  name: string;
  count: number;
  critical: number;
  high: number;
  maxCvss: number;
  fixedVersion: string;
}

interface FileRisk {
  file: string;
  count: number;
  severity: Issue['severity'];
  sources: string;
}

export function toMarkdown(result: ScanResult, root: string): string {
  const lines: string[] = [];
  const issues = result.issues;
  const total = issues.length;
  const severityCount = (severity: Issue['severity']): number =>
    issues.filter((issue) => issue.severity === severity).length;
  const critical = severityCount('critical');
  const high = severityCount('high');
  const medium = severityCount('medium');
  const low = severityCount('low');
  const info = severityCount('info');
  const severeHigh = critical + high;
  const fixable = issues.filter(
    (issue) => FIXABLE_RULES.has(issue.rule) && !!issue.file && !!issue.line
  ).length;
  const fileSet = new Set(issues.map((issue) => issue.file).filter(Boolean) as string[]);
  const trivy = issues.filter((issue) => issue.source === 'trivy');
  const packageSet = new Set(trivy.map((issue) => issue.packageName || '(未知组件)'));

  lines.push('# 代码质量与安全报告');
  lines.push('');
  lines.push(
    `\`${root}\` · 扫描于 ${new Date(result.finishedAt).toLocaleString()} · 用时 ${duration(result)}`
  );
  lines.push('');

  lines.push('## 核心看板');
  lines.push('');
  lines.push('| 问题总数 | 严重 + 高危 | 可自动修复 | 涉及文件 | 依赖组件 |');
  lines.push('| ---: | ---: | ---: | ---: | ---: |');
  lines.push(
    `| **${total}** | **${severeHigh}** | **${fixable}** | **${fileSet.size}** | **${packageSet.size}** |`
  );
  lines.push('');
  if (severeHigh > 0) {
    lines.push(
      `> 先处理 ${severeHigh} 项严重/高危问题；其中 ${fixable} 项可由插件确定性修复，其余按建议逐项处理。`
    );
  } else if (total > 0) {
    lines.push('> 没有严重/高危问题；优先清理中危项和依赖漏洞，再做常规代码治理。');
  } else {
    lines.push('> 本轮没有发现问题。');
  }
  if (result.buildHint) {
    lines.push('');
    lines.push(`> 提示：${clean(result.buildHint, 240)}`);
  }
  lines.push('');

  if (result.errors.length > 0) {
    lines.push('### 扫描异常');
    lines.push('');
    for (const error of result.errors) {
      lines.push(`- **${SOURCE_LABEL[error.source]}**：${clean(error.message, 220)}`);
    }
    lines.push('');
  }

  lines.push('### 严重度分布');
  lines.push('');
  lines.push('| 等级 | 数量 | 占比 | 分布 |');
  lines.push('| --- | ---: | ---: | --- |');
  for (const severity of SEVERITY_ORDER) {
    const value = severityCount(severity);
    if (value === 0 && severity === 'info') {
      continue;
    }
    lines.push(
      `| ${SEVERITY_LABEL[severity]} | ${value} | ${pct(value, total)} | ${bar(value, total)} |`
    );
  }
  lines.push('');

  lines.push('### 来源分布');
  lines.push('');
  lines.push('| 来源 | 数量 | 占比 | 分布 |');
  lines.push('| --- | ---: | ---: | --- |');
  for (const source of ['checkstyle', 'gitleaks', 'trivy', 'spotbugs', 'qcsec', 'astgrep'] as const) {
    const value = issues.filter((issue) => issue.source === source).length;
    lines.push(
      `| ${SOURCE_LABEL[source]} | ${value} | ${pct(value, total)} | ${bar(value, total)} |`
    );
  }
  lines.push('');

  if (trivy.length > 0) {
    const byPackage = new Map<string, ComponentRisk>();
    for (const issue of trivy) {
      const name = issue.packageName || '(未知组件)';
      if (!byPackage.has(name)) {
        byPackage.set(name, { name, count: 0, critical: 0, high: 0, maxCvss: 0, fixedVersion: '' });
      }
      const item = byPackage.get(name)!;
      item.count += 1;
      if (issue.severity === 'critical') {
        item.critical += 1;
      }
      if (issue.severity === 'high') {
        item.high += 1;
      }
      item.maxCvss = Math.max(item.maxCvss, issue.cvss ?? 0);
      if (!item.fixedVersion && issue.fixedVersion) {
        item.fixedVersion = issue.fixedVersion;
      }
    }
    const riskiest = [...byPackage.values()]
      .sort(
        (a, b) =>
          b.critical - a.critical ||
          b.high - a.high ||
          b.maxCvss - a.maxCvss ||
          b.count - a.count
      )
      .slice(0, 5);
    lines.push('### 高风险组件 Top 5');
    lines.push('');
    lines.push('| 组件 | CVE | 严重 / 高危 | 最高 CVSS | 建议版本 |');
    lines.push('| --- | ---: | ---: | ---: | --- |');
    for (const item of riskiest) {
      lines.push(
        `| ${cell(item.name, 80)} | ${item.count} | ${item.critical} / ${item.high} | ${
          item.maxCvss > 0 ? item.maxCvss.toFixed(1) : '-'
        } | ${cell(item.fixedVersion || '待评估', 60)} |`
      );
    }
    lines.push('');
  }

  const byFile = new Map<string, { count: number; severity: Issue['severity']; sources: Set<string> }>();
  for (const issue of issues) {
    if (!issue.file) {
      continue;
    }
    const file = rel(root, issue.file);
    if (!byFile.has(file)) {
      byFile.set(file, { count: 0, severity: 'info', sources: new Set() });
    }
    const item = byFile.get(file)!;
    item.count += 1;
    if (rank(issue.severity) < rank(item.severity)) {
      item.severity = issue.severity;
    }
    item.sources.add(SOURCE_LABEL[issue.source]);
  }
  const hotFiles: FileRisk[] = [...byFile.entries()]
    .map(([file, item]) => ({
      file,
      count: item.count,
      severity: item.severity,
      sources: [...item.sources].join(' / ')
    }))
    .sort((a, b) => b.count - a.count || rank(a.severity) - rank(b.severity))
    .slice(0, 5);
  if (hotFiles.length > 0) {
    lines.push('### 问题最集中的文件 Top 5');
    lines.push('');
    lines.push('| 文件 | 问题数 | 最高等级 | 来源 |');
    lines.push('| --- | ---: | --- | --- |');
    for (const item of hotFiles) {
      lines.push(
        `| \`${item.file}\` | ${item.count} | ${SEVERITY_LABEL[item.severity]} | ${item.sources} |`
      );
    }
    lines.push('');
  }

  if (result.suggestions.length > 0) {
    lines.push('## 优先处理');
    lines.push('');
    const top = result.suggestions.slice(0, 5);
    for (const [index, item] of top.entries()) {
      const impact = item.impactLabel ? `${item.impact} ${item.impactLabel}` : `${item.impact} 项`;
      lines.push(`${index + 1}. **${item.title}**（${impact}）`);
      lines.push(`   ${clean(item.detail, 180)}`);
    }
    lines.push('');
    if (result.suggestions.length > top.length) {
      lines.push(
        `<details><summary>其余 ${result.suggestions.length - top.length} 条修复建议</summary>`
      );
      lines.push('');
      for (const [index, item] of result.suggestions.slice(top.length).entries()) {
        lines.push(`### ${top.length + index + 1}. ${item.title}`);
        lines.push('');
        lines.push(`影响 ${item.impact} 项。${clean(item.detail, 400)}`);
        lines.push('');
      }
      lines.push('</details>');
      lines.push('');
    }
  }

  if (total > 0) {
    lines.push('## 详细清单（默认折叠）');
    lines.push('');
    lines.push('> 日常只需要看上面的核心看板和优先处理；需要逐条核对或复制给 AI 时再展开。');
    lines.push('');
  }

  if (trivy.length > 0) {
    lines.push(
      `<details><summary><strong>依赖漏洞 ${trivy.length} 条 CVE · 涉及 ${packageSet.size} 个组件</strong></summary>`
    );
    lines.push('');
    lines.push('| 严重度 | 组件 | 当前版本 | 建议版本 | 漏洞 | CVSS | 摘要 |');
    lines.push('| --- | --- | --- | --- | --- | ---: | --- |');
    for (const issue of [...trivy].sort((a, b) => rank(a.severity) - rank(b.severity) || (b.cvss ?? 0) - (a.cvss ?? 0))) {
      lines.push(
        `| ${SEVERITY_LABEL[issue.severity]} | ${cell(issue.packageName, 60)} | ${cell(
          issue.installedVersion,
          30
        )} | ${cell(issue.fixedVersion || '暂无', 60)} | ${cell(issue.rule, 40)} | ${
          issue.cvss ? issue.cvss.toFixed(1) : '-'
        } | ${cell(issue.zhSummary || issue.message, 140)} |`
      );
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  for (const source of ['gitleaks', 'checkstyle', 'spotbugs', 'qcsec', 'astgrep'] as const) {
    const group = issues.filter((issue) => issue.source === source);
    if (group.length === 0) {
      continue;
    }
    lines.push(
      `<details><summary><strong>${SOURCE_LABEL[source]} ${group.length} 项</strong></summary>`
    );
    lines.push('');
    const byGroupFile = new Map<string, Issue[]>();
    for (const issue of group) {
      const key = rel(root, issue.file) || '(未知文件)';
      if (!byGroupFile.has(key)) {
        byGroupFile.set(key, []);
      }
      byGroupFile.get(key)!.push(issue);
    }
    for (const [file, items] of byGroupFile) {
      lines.push(`**\`${file}\`（${items.length} 项）**`);
      lines.push('');
      for (const issue of items) {
        const location = issue.line ? `第 ${issue.line} 行` : '未定位';
        lines.push(`- ${location} · \`${issue.rule}\`：${clean(issue.zhSummary || issue.message, 180)}`);
        if (issue.advice) {
          lines.push(`  - 建议：${clean(issue.advice, 160)}`);
        }
      }
      lines.push('');
    }
    lines.push('</details>');
    lines.push('');
  }

  const extras: string[] = [];
  if (result.skipped.length > 0) {
    extras.push(`### 已跳过的检查（${result.skipped.length}）`);
    extras.push('');
    for (const item of result.skipped) {
      extras.push(`- **${SOURCE_LABEL[item.source]}**：${clean(item.reason, 180)}`);
    }
    extras.push('');
  }
  if (result.ignored.length > 0) {
    extras.push(`### 已按基线忽略（${result.ignored.length}）`);
    extras.push('');
    extras.push('这些项命中本地基线，不计入本轮问题总数。');
    extras.push('');
  }
  if (result.mutedByRule) {
    extras.push(`### 已被规则静音（${result.mutedByRule}）`);
    extras.push('');
    extras.push('这些项被 `qualityCenter.rules.mute` 过滤，不计入本轮问题总数。');
    extras.push('');
  }
  if (extras.length > 0) {
    lines.push('<details><summary><strong>其他信息</strong></summary>');
    lines.push('');
    lines.push(...extras);
    lines.push('</details>');
    lines.push('');
  }

  return lines.join('\n');
}
