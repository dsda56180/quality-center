export type IssueSource = 'checkstyle' | 'gitleaks' | 'trivy';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Issue {
  source: IssueSource;
  severity: Severity;
  /** 绝对路径，CVE 类问题可能没有 */
  file?: string;
  line?: number;
  column?: number;
  rule: string;
  message: string;
  /** 受影响依赖包名（CVE） */
  packageName?: string;
  installedVersion?: string;
  fixedVersion?: string;
  link?: string;
  /** 中文问题摘要（CVE），由结构化字段生成 */
  zhSummary?: string;
  /** 中文修复建议 */
  advice?: string;
  /** 英文原标题（CVE） */
  title?: string;
  /** 英文原描述（CVE），已截断 */
  description?: string;
  cvss?: number;
  cvssVector?: string;
  cwe?: string[];
  references?: string[];
  publishedAt?: string;
}

export interface ScanError {
  source: IssueSource;
  message: string;
}

export type SuggestionCategory = 'framework' | 'dependency' | 'secret' | 'manual';

/** 基于扫描结果推导出的修复建议（不是逐条问题，而是行动方案） */
export interface Suggestion {
  category: SuggestionCategory;
  title: string;
  detail: string;
  /** 该建议能覆盖的问题条数，用于排序 */
  impact: number;
}

export interface ScanResult {
  startedAt: number;
  finishedAt: number;
  issues: Issue[];
  /** 命中本地基线、当前不展示的问题 */
  ignored: Issue[];
  errors: ScanError[];
  skipped: { source: IssueSource; reason: string }[];
  suggestions: Suggestion[];
  /** 未使用构建产物扫描时给出的提示，UI 据此展示「构建并扫描」按钮 */
  buildHint?: string;
}

export const SOURCE_LABEL: Record<IssueSource, string> = {
  checkstyle: '代码质量',
  gitleaks: '密钥泄露',
  trivy: '依赖漏洞'
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: '严重',
  high: '高危',
  medium: '中危',
  low: '低危',
  info: '提示'
};

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
