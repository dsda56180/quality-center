const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  discoverProjectsInRoot,
  readWorkspaceManifest,
  projectForPath,
  assignUniqueLabels
} = require('../out/projectDiscovery.js');

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qc-projects-'));
}

function write(file, body = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

const root = temp();
write(path.join(root, 'a', 'pom.xml'), '<project/>');
write(path.join(root, 'a', 'module', 'pom.xml'), '<project/>');
write(path.join(root, 'b', 'build.gradle'), 'plugins {}');
write(path.join(root, 'target', 'ignored', 'pom.xml'), '<project/>');
write(path.join(root, 'src', 'ignored', 'pom.xml'), '<project/>');
write(path.join(root, 'node_modules', 'ignored', 'pom.xml'), '<project/>');

const nested = discoverProjectsInRoot(root);
if (nested.length !== 2) {
  throw new Error(`嵌套项目应发现 2 个，实际 ${nested.length}: ${nested.map((p) => p.root).join(',')}`);
}
if (!nested.some((p) => p.kind === 'maven') || !nested.some((p) => p.kind === 'gradle')) {
  throw new Error('应同时识别 Maven 与 Gradle');
}

const singleRoot = temp();
write(path.join(singleRoot, 'pom.xml'), '<project/>');
write(path.join(singleRoot, 'child', 'pom.xml'), '<project/>');
if (discoverProjectsInRoot(singleRoot).length !== 1) {
  throw new Error('根目录有 pom 时应只保留根项目，不拆子模块');
}

const manifestRoot = temp();
write(path.join(manifestRoot, 'quality-center.workspace.json'), JSON.stringify({
  projects: [{ path: 'a', label: '项目 A' }, { path: 'b', kind: 'generic' }]
}));
write(path.join(manifestRoot, 'a', 'pom.xml'), '<project/>');
fs.mkdirSync(path.join(manifestRoot, 'b'), { recursive: true });
const manifest = readWorkspaceManifest(manifestRoot);
if (!manifest || manifest.length !== 2 || manifest[0].label !== '项目 A') {
  throw new Error('显式清单读取失败');
}

const labels = assignUniqueLabels([
  { id: 'one', label: 'backend', root: path.join(root, 'x', 'backend'), kind: 'maven' },
  { id: 'two', label: 'backend', root: path.join(root, 'y', 'backend'), kind: 'maven' }
]);
if (new Set(labels.map((p) => p.label)).size !== 2) {
  throw new Error('同名项目标签未去重');
}

const owner = projectForPath(nested, path.join(nested.find((p) => p.kind === 'maven').root, 'src', 'A.java'));
if (!owner || owner.kind !== 'maven') {
  throw new Error('文件归属项目匹配失败');
}

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(singleRoot, { recursive: true, force: true });
fs.rmSync(manifestRoot, { recursive: true, force: true });
console.log('多项目发现检查通过');
