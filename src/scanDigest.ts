/**
 * 扫描结果的「喂给 AI」视图：默认只给摘要与 Top N，明细留在 issues.json。
 *
 * 动机：一个真实项目一次扫出 700+ 条问题，全量塞进对话就是几万 token，
 * 而 AI 决策真正需要的是「按来源/严重度的计数 + 最该看的几条 + 与上次相比新增/消失」。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AgentIssue, AgentPayload } from './agentApi';

export interface ScanDigest {
  generatedAt: string;
  total: number;
  keys: string[];
}

const DIGEST_REL = path.join('.quality-center', 'scan-digest.json');

function issueKey(issue: AgentIssue): string {
  return [issue.source, issue.rule, issue.package ?? '', issue.file ?? '', issue.line ?? 0].join('|');
}

export function readDigest(root: string): ScanDigest | undefined {
  try {
    const file = path.join(root, DIGEST_REL);
    if (!fs.existsSync(file)) {
      return undefined;
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ScanDigest;
    return Array.isArray(parsed.keys) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeDigest(root: string, payload: AgentPayload): void {
  const file = path.join(root, DIGEST_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        generatedAt: payload.generatedAt,
        total: payload.issues.length,
        keys: payload.issues.map(issueKey)
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

function brief(issue: AgentIssue, limit = 80): Record<string, unknown> {
  const text = (issue.zhSummary || issue.message || '').replace(/\s+/g, ' ').slice(0, limit);
  return {
    id: issue.id,
    source: issue.source,
    severity: issue.severity,
    rule: issue.rule,
    package: issue.package,
    installedVersion: issue.installedVersion,
    fixedVersion: issue.fixedVersion,
    file: issue.file,
    line: issue.line,
    summary: text
  };
}

export interface DigestOptions {
  /** summary（默认）只给计数 + Top N；full 给全量 issues */
  detail?: 'summary' | 'full';
  /** Top N 条（默认 10，上限 50） */
  top?: number;
  /** 与上一次扫描比较，给出新增/消失 */
  delta?: boolean;
}

export interface DigestResult {
  body: Record<string, unknown>;
  /** 写入 digest 之后的统计，便于调用方回显 */
  total: number;
  added: number;
  removed: number;
}

export function digestScan(root: string, payload: AgentPayload, options: DigestOptions = {}): DigestResult {
  const previous = readDigest(root);
  const currentKeys = payload.issues.map(issueKey);
  const prevSet = new Set(previous?.keys ?? []);
  const currentSet = new Set(currentKeys);

  const added: AgentIssue[] = [];
  const removedKeys: string[] = [];
  if (options.delta && previous) {
    payload.issues.forEach((issue, index) => {
      if (!prevSet.has(currentKeys[index])) {
        added.push(issue);
      }
    });
    for (const key of previous.keys) {
      if (!currentSet.has(key)) {
        removedKeys.push(key);
      }
    }
  }

  writeDigest(root, payload);

  const top = Math.min(Math.max(options.top ?? 10, 1), 50);
  const body: Record<string, unknown> = {
    schemaVersion: payload.schemaVersion,
    generatedAt: payload.generatedAt,
    projectRoot: payload.projectRoot,
    summary: payload.summary,
    issueCount: payload.issues.length,
    ignoredCount: payload.ignored.length,
    errors: payload.errors,
    skipped: payload.skipped,
    missingTools: payload.missingTools,
    buildHint: payload.buildHint,
    files: payload.files,
    nextActions: payload.nextActions,
    top: payload.issues.slice(0, top).map((issue) => brief(issue)),
    detailHint: `默认只给 Top ${top}；要全量传 detail=full，或直接读 ${payload.files?.issuesJson ?? '.quality-center/issues.json'}`
  };

  if (options.detail === 'full') {
    body.issues = payload.issues;
    body.ignored = payload.ignored;
    body.suggestions = payload.suggestions;
  }

  if (options.delta) {
    body.delta = {
      baseline: previous ? previous.generatedAt : null,
      added: added.length,
      removed: removedKeys.length,
      addedTop: added.slice(0, 10).map((issue) => brief(issue)),
      removedTop: removedKeys.slice(0, 10)
    };
  }

  return { body, total: payload.issues.length, added: added.length, removed: removedKeys.length };
}
