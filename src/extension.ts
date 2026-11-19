import * as vscode from 'vscode';
import { QualityViewProvider, openIssue } from './panel/QualityViewProvider';
import { ScanRunner } from './scanner';

export function activate(context: vscode.ExtensionContext): void {
  const runner = new ScanRunner(context);
  const provider = new QualityViewProvider(runner);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(QualityViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('qualityCenter.scan', () => provider.scanAndPush()),
    vscode.commands.registerCommand('qualityCenter.autoFix', () => provider.fixAll()),
    vscode.commands.registerCommand('qualityCenter.deepFix', () => provider.deepFix()),
    vscode.commands.registerCommand('qualityCenter.copyMarkdown', () => provider.copyMarkdown()),
    vscode.commands.registerCommand('qualityCenter.writeReport', () => provider.exportReport()),
    vscode.commands.registerCommand('qualityCenter.openIssue', (file?: string, line?: number) => {
      if (file) {
        return openIssue(file, line ?? 0);
      }
      return undefined;
    }),
    vscode.commands.registerCommand('qualityCenter.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'qualityCenter')
    )
  );

  let timer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      const config = vscode.workspace.getConfiguration('qualityCenter');
      if (!config.get<boolean>('scanOnSave', true)) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void provider.scanAndPush();
      }, 1500);
    })
  );

  if (vscode.workspace.getConfiguration('qualityCenter').get<boolean>('scanOnStartup', true)) {
    setTimeout(() => {
      void provider.scanAndPush();
    }, 1500);
  }
}

export function deactivate(): void {
  // 无需清理：所有资源已注册到 context.subscriptions
}
