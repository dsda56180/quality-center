/**
 * 规则静音（单规则开关）。
 *
 * 支持三种写法，匹配规则 id 或来源名（大小写不敏感）：
 * - `SEC_MYBATIS_DOLLAR_SUBSTITUTION`：精确匹配一条规则
 * - `SEC_DRUID_*`：按前缀匹配一组规则
 * - `trivy`：按来源整体静音（等价于关闭该扫描器的结果，但保留其它扫描器）
 */
import { Issue } from './model';

function matches(pattern: string, issue: Issue): boolean {
  const raw = pattern.trim();
  if (!raw) {
    return false;
  }
  const lower = raw.toLowerCase();
  if (lower === issue.rule.toLowerCase() || lower === issue.source.toLowerCase()) {
    return true;
  }
  if (lower.endsWith('*')) {
    return issue.rule.toLowerCase().startsWith(lower.slice(0, -1));
  }
  return false;
}

export interface MuteOutcome {
  issues: Issue[];
  muted: number;
}

export function muteRules(issues: Issue[], patterns?: string[]): MuteOutcome {
  const list = (patterns ?? []).filter((item) => typeof item === 'string' && item.trim().length > 0);
  if (list.length === 0) {
    return { issues, muted: 0 };
  }
  const kept: Issue[] = [];
  let muted = 0;
  for (const issue of issues) {
    if (list.some((pattern) => matches(pattern, issue))) {
      muted += 1;
      continue;
    }
    kept.push(issue);
  }
  return { issues: kept, muted };
}

/** 解析命令行/配置里的静音列表：支持逗号分隔的一整串 */
export function parseMuteList(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}
