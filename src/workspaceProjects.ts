import * as vscode from 'vscode';
import {
  assignUniqueLabels,
  DiscoveredProject,
  discoverProjectsInRoot,
  readWorkspaceManifest,
  stableProjectId
} from './projectDiscovery';

/** 工作区可能是一个项目、多个根项目、或一个父目录下多个独立项目，统一收敛成项目列表 */
export function discoverWorkspaceProjects(): DiscoveredProject[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const projects: DiscoveredProject[] = [];
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    const manifest = readWorkspaceManifest(root);
    if (manifest && manifest.length > 0) {
      projects.push(...manifest);
      continue;
    }
    const discovered = discoverProjectsInRoot(root);
    if (discovered.length > 0) {
      projects.push(...discovered);
      continue;
    }
    // 没有识别到构建文件时保持旧行为：把工作区根当成普通目录继续扫描
    projects.push({
      id: stableProjectId(root),
      label: folder.name,
      root,
      kind: 'generic'
    });
  }
  return assignUniqueLabels(projects);
}
