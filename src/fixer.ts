import * as vscode from 'vscode';
import { Issue } from './model';
import { reorderModifiers } from './modifiers';
import { simplifyBooleanLine } from './booleans';

/** 可确定性修复的规则：删导入、调整修饰符顺序、简化布尔字面量比较 */
export const FIXABLE_RULES = new Set([
  'UnusedImports',
  'RedundantImport',
  'ModifierOrder',
  'SimplifyBooleanExpression'
]);

const IDENT = '[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*';

export interface FixOutcome {
  applied: number;
  skipped: number;
  files: number;
}

export function isFixable(issue: Issue): boolean {
  return FIXABLE_RULES.has(issue.rule) && !!issue.file && !!issue.line;
}

/**
 * 批量应用确定性修复。
 * 同一文件中按行去重，避免重复删除导致编辑区间重叠。
 */
export async function applyAutoFixes(issues: Issue[]): Promise<FixOutcome> {
  const targets = issues.filter(isFixable);
  const byFile = new Map<string, Issue[]>();
  for (const issue of targets) {
    const key = issue.file!;
    if (!byFile.has(key)) {
      byFile.set(key, []);
    }
    byFile.get(key)!.push(issue);
  }

  const outcome: FixOutcome = { applied: 0, skipped: 0, files: 0 };

  for (const [file, list] of byFile) {
    const uri = vscode.Uri.file(file);
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      outcome.skipped += list.length;
      continue;
    }

    const edits: vscode.TextEdit[] = [];
    const touchedLines = new Set<number>();

    for (const issue of list) {
      const line = (issue.line ?? 0) - 1;
      if (line < 0 || line >= document.lineCount || touchedLines.has(line)) {
        outcome.skipped += 1;
        continue;
      }
      const text = document.lineAt(line).text;

      if (issue.rule === 'ModifierOrder') {
        const fixed = reorderModifiers(text);
        if (!fixed) {
          outcome.skipped += 1;
          continue;
        }
        edits.push(
          vscode.TextEdit.replace(new vscode.Range(line, 0, line, text.length), fixed)
        );
      } else if (issue.rule === 'SimplifyBooleanExpression') {
        const fixed = simplifyBooleanLine(text);
        if (!fixed) {
          outcome.skipped += 1;
          continue;
        }
        edits.push(
          vscode.TextEdit.replace(new vscode.Range(line, 0, line, text.length), fixed)
        );
      } else {
        // 删除整行导入（含换行）
        const start = new vscode.Position(line, 0);
        const end =
          line + 1 < document.lineCount
            ? new vscode.Position(line + 1, 0)
            : new vscode.Position(line, text.length);
        edits.push(vscode.TextEdit.delete(new vscode.Range(start, end)));
      }

      touchedLines.add(line);
      outcome.applied += 1;
    }

    if (edits.length === 0) {
      continue;
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.set(uri, edits);
    const ok = await vscode.workspace.applyEdit(workspaceEdit);
    if (!ok) {
      outcome.applied -= edits.length;
      outcome.skipped += edits.length;
      continue;
    }
    outcome.files += 1;
    try {
      await document.save();
    } catch {
      // 保存失败不影响已应用的编辑
    }
  }

  return outcome;
}
