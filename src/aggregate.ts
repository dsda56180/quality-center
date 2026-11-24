/**
 * 同文件聚合：把同一规则在同一文件里的多处低噪声命中合并成一条，
 * 避免「一个文件 20 行 System.out」把面板/报告刷满。
 *
 * 只合并 medium 及以下：高危问题必须逐条可见，不能被合并隐藏。
 */
import { Issue, Severity } from './model';

const MERGEABLE: Severity[] = ['medium', 'low', 'info'];

export interface AggregateOutcome {
  issues: Issue[];
  merged: number;
}

export function aggregateIssues(issues: Issue[], threshold = 3): AggregateOutcome {
  const buckets = new Map<string, Issue[]>();
  const order: string[] = [];
  for (const issue of issues) {
    const key = `${issue.source}|${issue.rule}|${issue.file ?? ''}|${issue.severity}`;
    const list = buckets.get(key);
    if (list) {
      list.push(issue);
    } else {
      buckets.set(key, [issue]);
      order.push(key);
    }
  }
  if (threshold <= 1) {
    return { issues, merged: 0 };
  }
  const kept = new Map<IssueKey, Issue>();
  let merged = 0;
  for (const key of order) {
    const [first, ...rest] = buckets.get(key) ?? [];
    if (!first) {
      continue;
    }
    if (!MERGEABLE.includes(first.severity) || rest.length + 1 < threshold) {
      kept.set(first, first);
      for (const issue of rest) {
        kept.set(issue, issue);
      }
      continue;
    }
    merged += rest.length;
    kept.set(first, {
      ...first,
      occurrences: rest.length + 1,
      message: `${first.message}（同文件共 ${rest.length + 1} 处，已聚合展示）`
    });
  }
  const result = issues
    .map((issue) => kept.get(issue))
    .filter((issue): issue is Issue => !!issue);
  return { issues: result, merged };
}

type IssueKey = Issue;
