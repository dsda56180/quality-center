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
}

export interface ScanError {
  source: IssueSource;
  message: string;
}

export interface ScanResult {
  startedAt: number;
  finishedAt: number;
  issues: Issue[];
  errors: ScanError[];
  skipped: { source: IssueSource; reason: string }[];
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
