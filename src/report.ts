import * as path from 'path';
import { Issue, ScanResult, SEVERITY_LABEL, SEVERITY_ORDER, SOURCE_LABEL } from './model';

function rel(root: string, file?: string): string {
  if (!file) {
    return '';
  }
  const relative = path.relative(root, file);
  return (relative || file).split(path.sep).join('/');
}

function counts(issues: Issue[]): string {
  const parts = SEVERITY_ORDER.map((severity) => {
    const total = issues.filter((issue) => issue.severity === severity).length;
    return total > 0 ? `${SEVERITY_LABEL[severity]} ${total}` : '';
  }).filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : '无问题';
}

export function toMarkdown(result: ScanResult, root: string): string {
  const lines: string[] = [];
  lines.push('# 代码质量与安全报告');
  lines.push('');
  lines.push(`- 项目：\`${root}\``);
  lines.push(`- 扫描时间：${new Date(result.finishedAt).toLocaleString()}`);
  lines.push(`- 问题总数：${result.issues.length}（${counts(result.issues)}）`);
  lines.push('');

  if (result.errors.length > 0) {
    lines.push('## 扫描异常');
    for (const error of result.errors) {
      lines.push(`- [${SOURCE_LABEL[error.source]}] ${error.message.replace(/\r?\n/g, ' ')}`);
    }
    lines.push('');
  }

  const trivy = result.issues.filter((issue) => issue.source === 'trivy');
  if (trivy.length > 0) {
    lines.push('## 依赖漏洞（CVE）');
    lines.push('');
    lines.push('| 严重度 | 组件 | 当前版本 | 修复版本 | 漏洞编号 | 说明 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const issue of trivy) {
      const note = issue.message.replace(/\|/g, '\\|');
      lines.push(
        `| ${SEVERITY_LABEL[issue.severity]} | ${issue.packageName || ''} | ${
          issue.installedVersion || ''
        } | ${issue.fixedVersion || '暂无'} | ${issue.rule} | ${note} |`
      );
    }
    lines.push('');
  }

  for (const source of ['gitleaks', 'checkstyle'] as const) {
    const group = result.issues.filter((issue) => issue.source === source);
    if (group.length === 0) {
      continue;
    }
    lines.push(`## ${SOURCE_LABEL[source]}`);
    lines.push('');
    const byFile = new Map<string, Issue[]>();
    for (const issue of group) {
      const key = rel(root, issue.file) || '(未知文件)';
      if (!byFile.has(key)) {
        byFile.set(key, []);
      }
      byFile.get(key)!.push(issue);
    }
    for (const [file, items] of byFile) {
      lines.push(`### ${file}`);
      for (const issue of items) {
        const location = issue.line ? `第 ${issue.line} 行` : '';
        lines.push(`- ${location}（${issue.rule}）：${issue.message}`);
      }
      lines.push('');
    }
  }

  if (result.skipped.length > 0) {
    lines.push('## 已跳过的检查');
    for (const item of result.skipped) {
      lines.push(`- ${SOURCE_LABEL[item.source]}：${item.reason}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
