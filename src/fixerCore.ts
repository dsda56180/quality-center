/**
 * 确定性修复的纯函数实现：不依赖 vscode，IDE 面板与 CLI/MCP 共用。
 *
 * 面板走 vscode 的 TextEdit + 保存，CLI 直接改写文件内容；
 * 两边的「哪一行怎么改」都由 planLineFix 决定，避免规则实现分叉。
 */
import { reorderModifiers } from './modifiers';
import { simplifyBooleanLine } from './booleans';
import { Issue } from './model';

/** 可确定性修复的规则：删导入、调整修饰符顺序、简化布尔字面量比较 */
export const FIXABLE_RULES = new Set([
  'UnusedImports',
  'RedundantImport',
  'ModifierOrder',
  'SimplifyBooleanExpression'
]);

export type LinePlan =
  | { type: 'replace'; text: string }
  | { type: 'delete' }
  | null;

/**
 * 单行修复计划；返回 null 表示这一行不改（规则不支持或替换后无变化）。
 * 删除类规则只删真正的 import 行，避免行号漂移时误删代码。
 */
export function planLineFix(rule: string, lineText: string): LinePlan {
  if (!FIXABLE_RULES.has(rule)) {
    return null;
  }
  if (rule === 'ModifierOrder') {
    const fixed = reorderModifiers(lineText);
    return fixed && fixed !== lineText ? { type: 'replace', text: fixed } : null;
  }
  if (rule === 'SimplifyBooleanExpression') {
    const fixed = simplifyBooleanLine(lineText);
    return fixed && fixed !== lineText ? { type: 'replace', text: fixed } : null;
  }
  return /^\s*import\s/.test(lineText) && !/^\s*import\s*;/i.test(lineText)
    ? { type: 'delete' }
    : null;
}

export interface ContentChange {
  /** 1 基行号 */
  line: number;
  rule: string;
  kind: 'replace' | 'delete';
}

export interface ContentFixResult {
  content: string;
  applied: number;
  skipped: number;
  changes: ContentChange[];
}

/**
 * 按 issues 改写整份文件内容。
 * 同一行只处理一次（去重），行号越界或规则不适配的行计入 skipped。
 */
export function applyFixesToContent(content: string, issues: Issue[]): ContentFixResult {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const changes: ContentChange[] = [];
  const deleted = new Set<number>();
  const touched = new Set<number>();
  let applied = 0;
  let skipped = 0;

  const ordered = [...issues].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  for (const issue of ordered) {
    const index = (issue.line ?? 0) - 1;
    if (index < 0 || index >= lines.length || touched.has(index)) {
      skipped += 1;
      continue;
    }
    const plan = planLineFix(issue.rule, lines[index]);
    if (!plan) {
      skipped += 1;
      continue;
    }
    if (plan.type === 'replace') {
      lines[index] = plan.text;
      changes.push({ line: index + 1, rule: issue.rule, kind: 'replace' });
    } else {
      deleted.add(index);
      changes.push({ line: index + 1, rule: issue.rule, kind: 'delete' });
    }
    touched.add(index);
    applied += 1;
  }

  const next =
    deleted.size === 0
      ? lines
      : lines.filter((_line, index) => !deleted.has(index));

  return { content: next.join(eol), applied, skipped, changes };
}
