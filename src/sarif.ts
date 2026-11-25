/**
 * SARIF 2.1.0 导出：让结果能直接被 GitHub code scanning / Azure DevOps / IDE 读取。
 * 只做标准字段，不引入自定义扩展，保证上传到 code scanning 不会被拒。
 */
import path from 'path';
import { ScanResult } from './model';

const LEVEL: Record<string, 'error' | 'warning' | 'note'> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
  info: 'note'
};

const RULE_HELP: Record<string, string> = {
  checkstyle: '代码风格与可维护性问题',
  gitleaks: '源码中的密钥/凭据泄露',
  trivy: '第三方依赖漏洞（CVE）',
  spotbugs: '字节码级静态缺陷（含 FindSecBugs 安全规则）',
  qcsec: '配置层与框架语义安全问题',
  astgrep: '源码语义（AST）安全问题'
};

export function toSarif(result: ScanResult, root: string): string {
  const ruleIds = new Set<string>();
  const results = result.issues.map((issue) => {
    ruleIds.add(issue.rule);
    const relative = issue.file ? path.relative(root, issue.file).split(path.sep).join('/') : '';
    const location = relative
      ? {
          physicalLocation: {
            artifactLocation: { uri: relative },
            region: {
              startLine: issue.line && issue.line > 0 ? issue.line : 1,
              startColumn: issue.column && issue.column > 0 ? issue.column : 1
            }
          }
        }
      : undefined;
    return {
      ruleId: issue.rule,
      level: LEVEL[issue.severity] ?? 'warning',
      message: { text: issue.message },
      ...(location ? { locations: [location] } : {}),
      properties: {
        source: issue.source,
        severity: issue.severity,
        cwe: issue.cwe ?? []
      }
    };
  });

  const rules = Array.from(ruleIds).map((id) => ({
    id,
    name: id,
    shortDescription: { text: id },
    properties: { tags: ['security'] }
  }));

  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'quality-center',
              informationUri: 'https://github.com/dsda56180/quality-center',
              rules
            }
          },
          results,
          properties: {
            sources: RULE_HELP,
            ignored: result.ignored.length,
            skipped: result.skipped.map((item) => ({ source: item.source, reason: item.reason }))
          }
        }
      ]
    },
    null,
    2
  );
}

/** GitHub Actions 注解：error/warning/notice 直接出现在 PR 的 Files changed 视图 */
export function toWorkflowCommands(result: ScanResult, root: string): string {
  const lines: string[] = [];
  for (const issue of result.issues) {
    const level = issue.severity === 'critical' || issue.severity === 'high' ? 'error' : 'warning';
    const relative = issue.file ? path.relative(root, issue.file).split(path.sep).join('/') : '';
    const props: string[] = [];
    if (relative) {
      props.push(`file=${relative}`);
    }
    if (issue.line) {
      props.push(`line=${issue.line}`);
    }
    if (issue.column) {
      props.push(`col=${issue.column}`);
    }
    props.push(`title=${issue.rule}`);
    const message = issue.message.replace(/\r?\n/g, ' ').replace(/%/g, '%25');
    lines.push(`::${level} ${props.join(',')}::${message}`);
  }
  if (lines.length === 0) {
    lines.push(`::notice title=quality-center::未发现问题（${result.issues.length} 项）`);
  }
  return lines.join('\n');
}
