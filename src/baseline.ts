import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Issue } from './model';

interface BaselineEntry {
  source: string;
  rule: string;
  file?: string;
  message: string;
  createdAt: string;
}

interface BaselineFile {
  version: number;
  ignored: Record<string, BaselineEntry>;
}

function baselinePath(root: string): string {
  return path.join(root, '.quality-center', 'baseline.json');
}

/** 稳定的问题指纹：不包含行号，代码移动后仍能匹配 */
export function issueKey(issue: Issue): string {
  if (issue.source === 'trivy') {
    return ['trivy', issue.rule, issue.packageName ?? '', issue.installedVersion ?? ''].join('|');
  }
  const fingerprint =
    issue.source === 'gitleaks'
      ? crypto.createHash('sha1').update(issue.message).digest('hex').slice(0, 16)
      : issue.message.replace(/\s+/g, ' ').trim();
  return [issue.source, issue.rule, issue.file ?? '', fingerprint].join('|');
}

function loadBaseline(root: string): BaselineFile {
  try {
    const raw = fs.readFileSync(baselinePath(root), 'utf8');
    const parsed = JSON.parse(raw) as BaselineFile;
    if (parsed && typeof parsed.ignored === 'object') {
      return { version: parsed.version ?? 1, ignored: parsed.ignored };
    }
  } catch {
    // 文件不存在或损坏时从空基线开始
  }
  return { version: 1, ignored: {} };
}

function saveBaseline(root: string, data: BaselineFile): void {
  const file = baselinePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

export function splitByBaseline(
  root: string,
  issues: Issue[]
): { active: Issue[]; ignored: Issue[] } {
  const data = loadBaseline(root);
  const active: Issue[] = [];
  const ignored: Issue[] = [];
  for (const issue of issues) {
    if (data.ignored[issueKey(issue)]) {
      ignored.push(issue);
    } else {
      active.push(issue);
    }
  }
  return { active, ignored };
}

export function addToBaseline(root: string, issue: Issue): void {
  const data = loadBaseline(root);
  data.ignored[issueKey(issue)] = {
    source: issue.source,
    rule: issue.rule,
    file: issue.file,
    message: issue.message,
    createdAt: new Date().toISOString()
  };
  saveBaseline(root, data);
}

export function removeFromBaseline(root: string, issue: Issue): void {
  const data = loadBaseline(root);
  const key = issueKey(issue);
  if (!data.ignored[key]) {
    return;
  }
  delete data.ignored[key];
  saveBaseline(root, data);
}
