import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type ProjectKind = 'maven' | 'gradle' | 'generic';

export interface DiscoveredProject {
  id: string;
  label: string;
  root: string;
  kind: ProjectKind;
}

const BUILD_MARKERS: { file: string; kind: ProjectKind }[] = [
  { file: 'pom.xml', kind: 'maven' },
  { file: 'build.gradle', kind: 'gradle' },
  { file: 'build.gradle.kts', kind: 'gradle' }
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'build',
  'out',
  'dist',
  '.gradle',
  '.idea',
  '.vscode',
  '.trae',
  '.cursor',
  '.quality-center',
  'src',
  'test',
  'docs'
]);

const MAX_DEPTH = 3;
const MAX_PROJECTS = 50;

function detectKind(dir: string): ProjectKind | undefined {
  for (const marker of BUILD_MARKERS) {
    if (fs.existsSync(path.join(dir, marker.file))) {
      return marker.kind;
    }
  }
  return undefined;
}

function slug(value: string): string {
  const text = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return text || 'project';
}

/** 项目 ID 只依赖绝对路径，重命名目录后仍可对应到新目录，但不能因为扫描顺序变化而漂移 */
export function stableProjectId(root: string): string {
  const base = slug(path.basename(root));
  const hash = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}

function makeProject(root: string, kind: ProjectKind): DiscoveredProject {
  return {
    id: stableProjectId(root),
    label: path.basename(root) || root,
    root: path.resolve(root),
    kind
  };
}

function walk(root: string, depth: number, out: DiscoveredProject[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_PROJECTS) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_PROJECTS) {
      return;
    }
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(root, entry.name);
    const kind = detectKind(full);
    if (kind) {
      // 找到一个项目根后不再向下拆：Maven 子模块交给 Maven reactor 处理，避免重复计数
      out.push(makeProject(full, kind));
      continue;
    }
    walk(full, depth + 1, out);
  }
}

/** 扫描单个工作区目录：根目录自身是项目时只保留根；否则向下找独立项目 */
export function discoverProjectsInRoot(root: string): DiscoveredProject[] {
  const resolved = path.resolve(root);
  const rootKind = detectKind(resolved);
  if (rootKind) {
    return [makeProject(resolved, rootKind)];
  }
  const out: DiscoveredProject[] = [];
  walk(resolved, 1, out);
  return out;
}

/** 同名项目用父目录区分；仍有冲突时追加短哈希 */
export function assignUniqueLabels(projects: DiscoveredProject[]): DiscoveredProject[] {
  const counts = new Map<string, number>();
  for (const project of projects) {
    counts.set(project.label, (counts.get(project.label) ?? 0) + 1);
  }
  const used = new Set<string>();
  return projects.map((project) => {
    let label = project.label;
    if ((counts.get(label) ?? 0) > 1) {
      const parent = path.basename(path.dirname(project.root));
      label = parent ? `${parent}/${project.label}` : project.label;
    }
    if (used.has(label)) {
      label = `${label} · ${project.id.slice(-6)}`;
    }
    used.add(label);
    return { ...project, label };
  });
}

interface ManifestProject {
  path?: string;
  label?: string;
  kind?: ProjectKind;
}

interface WorkspaceManifest {
  projects?: (string | ManifestProject)[];
}

/**
 * 显式清单优先。清单允许把工作区里不方便自动识别的项目、排除项和展示名固定下来，
 * 自动发现只作为没有清单时的建议。
 */
export function readWorkspaceManifest(workspaceRoot: string): DiscoveredProject[] | undefined {
  const file = path.join(workspaceRoot, 'quality-center.workspace.json');
  if (!fs.existsSync(file)) {
    return undefined;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkspaceManifest;
    if (!Array.isArray(data.projects)) {
      return undefined;
    }
    const result: DiscoveredProject[] = [];
    for (const item of data.projects) {
      const rel = typeof item === 'string' ? item : item.path;
      if (!rel) {
        continue;
      }
      const root = path.resolve(workspaceRoot, rel);
      if (!fs.existsSync(root)) {
        continue;
      }
      const kind = (typeof item === 'string' ? undefined : item.kind) ?? detectKind(root) ?? 'generic';
      const base = makeProject(root, kind);
      result.push({
        ...base,
        label: typeof item === 'string' ? base.label : item.label || base.label
      });
    }
    return result;
  } catch {
    return undefined;
  }
}

function normalize(file: string): string {
  return process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
}

/** 文件属于哪个项目：按最长前缀匹配，避免父项目抢走嵌套项目的文件 */
export function projectForPath(
  projects: DiscoveredProject[],
  file: string
): DiscoveredProject | undefined {
  const target = normalize(file);
  let best: DiscoveredProject | undefined;
  for (const project of projects) {
    const root = normalize(project.root);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      continue;
    }
    if (!best || root.length > normalize(best.root).length) {
      best = project;
    }
  }
  return best;
}
