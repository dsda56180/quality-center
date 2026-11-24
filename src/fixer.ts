import * as vscode from 'vscode';
import { Issue } from './model';
import { FIXABLE_RULES, planLineFix } from './fixerCore';

export { FIXABLE_RULES };

export interface FixOutcome {
  applied: number;
  skipped: number;
  files: number;
}

export function isFixable(issue: Issue): boolean {
  return FIXABLE_RULES.has(issue.rule) && !!issue.file && !!issue.line;
}

/**
 * 批量应用确定性修复（IDE 面板用）。
 * 同一文件中按行去重，避免重复删除导致编辑区间重叠；
 * 「哪一行怎么改」与 CLI/MCP 共用 fixerCore.planLineFix。
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
      const plan = planLineFix(issue.rule, text);
      if (!plan) {
        outcome.skipped += 1;
        continue;
      }

      if (plan.type === 'replace') {
        edits.push(vscode.TextEdit.replace(new vscode.Range(line, 0, line, text.length), plan.text));
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
