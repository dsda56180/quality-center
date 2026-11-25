import * as fs from 'fs';
import * as path from 'path';
import { Issue, ScanResult, SEVERITY_LABEL, SEVERITY_ORDER, SOURCE_LABEL } from './model';
import { toMarkdown } from './report';
import { toSarif } from './sarif';

export interface AgentExport {
  dir: string;
  jsonPath: string;
  markdownPath: string;
  sarifPath: string;
}

function relative(root: string, file?: string): string {
  if (!file) {
    return '';
  }
  return path.relative(root, file).split(path.sep).join('/');
}

function summarize(issues: Issue[]): Record<string, number> {
  const summary: Record<string, number> = { total: issues.length };
  for (const severity of SEVERITY_ORDER) {
    summary[severity] = issues.filter((issue) => issue.severity === severity).length;
  }
  for (const source of ['checkstyle', 'gitleaks', 'trivy', 'spotbugs', 'qcsec', 'astgrep'] as const) {
    summary[source] = issues.filter((issue) => issue.source === source).length;
  }
  return summary;
}

/**
 * 把扫描结果写成 AI agent 可直接读取的结构化文件：
 *   .quality-center/issues.json  —— 机器可读，含完整字段
 *   .quality-center/report.md    —— 人可读
 */
export function exportForAgent(root: string, result: ScanResult): AgentExport {
  const dir = path.join(root, '.quality-center');
  fs.mkdirSync(dir, { recursive: true });

  const issues = result.issues.map((issue, index) => ({
    id: index + 1,
    source: issue.source,
    sourceLabel: SOURCE_LABEL[issue.source],
    severity: issue.severity,
    severityLabel: SEVERITY_LABEL[issue.severity],
    file: relative(root, issue.file),
    line: issue.line ?? 0,
    column: issue.column ?? 0,
    rule: issue.rule,
    message: issue.message,
    package: issue.packageName ?? '',
    installedVersion: issue.installedVersion ?? '',
    fixedVersion: issue.fixedVersion ?? '',
    link: issue.link ?? '',
    zhSummary: issue.zhSummary ?? '',
    advice: issue.advice ?? '',
    title: issue.title ?? '',
    cvss: issue.cvss ?? 0,
    cwe: issue.cwe ?? [],
    publishedAt: issue.publishedAt ?? '',
    category: issue.category ?? '',
    occurrences: issue.occurrences ?? 1
  }));

  const payload = {
    // 给 agent 的稳定契约：字段只增不减，结构变化时升级版本号
    schemaVersion: '2',
    generatedAt: new Date(result.finishedAt).toISOString(),
    projectRoot: root,
    summary: summarize(result.issues),
    suggestions: result.suggestions,
    buildHint: result.buildHint ?? '',
    errors: result.errors,
    skipped: result.skipped,
    issues
  };

  const jsonPath = path.join(dir, 'issues.json');
  const markdownPath = path.join(dir, 'report.md');
  // SARIF 顺手写一份：GitHub code scanning / 其它平台都能直接上传
  const sarifPath = path.join(dir, 'report.sarif');
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(markdownPath, toMarkdown(result, root), 'utf8');
  fs.writeFileSync(sarifPath, toSarif(result, root), 'utf8');

  return { dir, jsonPath, markdownPath, sarifPath };
}

export function formatIssueForCopy(issue: Issue, root: string, id: number): string {
  const lines: string[] = [];
  lines.push(`### [#${id}] [${SEVERITY_LABEL[issue.severity]}] ${issue.rule}`);
  lines.push(`- 来源：${SOURCE_LABEL[issue.source]}`);
  if (issue.file) {
    const location = relative(root, issue.file);
    lines.push(`- 位置：\`${location}${issue.line ? `:${issue.line}` : ''}\``);
  }
  if (issue.packageName) {
    lines.push(`- 依赖：${issue.packageName} ${issue.installedVersion || ''}`);
  }
  if (issue.fixedVersion) {
    lines.push(`- 修复版本：${issue.fixedVersion}`);
  }
  if (issue.link) {
    lines.push(`- 详情：${issue.link}`);
  }
  if (issue.zhSummary) {
    lines.push(`- 中文摘要：${issue.zhSummary}`);
  }
  if (issue.cvss) {
    lines.push(`- CVSS：${issue.cvss}${issue.cvssVector ? `（${issue.cvssVector}）` : ''}`);
  }
  if (issue.cwe && issue.cwe.length > 0) {
    lines.push(`- CWE：${issue.cwe.join(', ')}`);
  }
  if (issue.advice) {
    lines.push(`- 修复建议：${issue.advice}`);
  }
  lines.push(`- 问题：${issue.message}`);
  return lines.join('\n');
}
