import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { portableToolsDir, resolveBinary } from './exec';

/** 插件依赖、但不会随插件分发的外部可执行文件 */
export type ToolId = 'mvn' | 'gitleaks' | 'trivy';

export type PlatformKind = 'windows' | 'macos' | 'linux';

export interface ExternalTool {
  /** 可执行文件名 / 命令名 */
  bin: string;
  label: string;
  /** 缺失时受影响的功能，用于提示文案 */
  purpose: string;
  /** winget 包 ID（Windows），已在 winget 源中核对过 */
  winget?: string;
  /** Chocolatey 包名（Windows） */
  choco?: string;
  /** Scoop 包名（Windows） */
  scoop?: string;
  /** Homebrew 包名（macOS / Linuxbrew） */
  brew?: string;
  /** 发行版仓库包名（Linux，需要 sudo） */
  apt?: string;
  dnf?: string;
  pacman?: string;
  /** 官方安装文档 */
  docs: string;
  /** 界面里展示的手动安装命令 */
  hint: string;
}

export const EXTERNAL_TOOLS: Record<ToolId, ExternalTool> = {
  mvn: {
    bin: 'mvn',
    label: 'Maven',
    purpose: '代码质量（Checkstyle）与静态缺陷（SpotBugs）扫描',
    // winget 源里没有官方 Maven 包，Windows 走 choco / scoop 或便携目录
    choco: 'maven',
    scoop: 'maven',
    brew: 'maven',
    apt: 'maven',
    dnf: 'maven',
    pacman: 'maven',
    docs: 'https://maven.apache.org/install.html',
    hint: '下载 apache-maven-*-bin.zip 解压后把 bin 目录加入 PATH'
  },
  gitleaks: {
    bin: 'gitleaks',
    label: 'Gitleaks',
    purpose: '密钥泄露扫描',
    winget: 'Gitleaks.Gitleaks',
    choco: 'gitleaks',
    scoop: 'gitleaks',
    brew: 'gitleaks',
    docs: 'https://github.com/gitleaks/gitleaks#installing',
    hint: 'winget install --id Gitleaks.Gitleaks -e'
  },
  trivy: {
    bin: 'trivy',
    label: 'Trivy',
    purpose: '依赖漏洞（CVE）扫描',
    winget: 'AquaSecurity.Trivy',
    choco: 'trivy',
    scoop: 'trivy',
    brew: 'trivy',
    docs: 'https://trivy.dev/latest/docs/installation/',
    hint: 'winget install --id AquaSecurity.Trivy -e'
  }
};

export function currentPlatform(): PlatformKind {
  if (process.platform === 'win32') {
    return 'windows';
  }
  if (process.platform === 'darwin') {
    return 'macos';
  }
  return 'linux';
}

/**
 * 定位 winget。
 * winget 默认装在 %LOCALAPPDATA%\Microsoft\WindowsApps，通常不在 PATH 里，
 * 因此 where 找不到时再按固定路径兜底。
 */
export function wingetPath(): string | undefined {
  const found = resolveBinary('winget');
  if (found) {
    return found;
  }
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) {
    return undefined;
  }
  const dir = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps');
  const candidate = path.join(dir, 'winget.exe');
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  // winget.exe 是「应用执行别名」（0 字节 reparse point），
  // existsSync 跟随符号链接时可能判定不存在，因此再核对一次目录项。
  try {
    const entry = fs.readdirSync(dir).find((name) => name.toLowerCase() === 'winget.exe');
    if (entry) {
      return path.join(dir, entry);
    }
  } catch {
    // WindowsApps 不可读时按未安装处理
  }
  return undefined;
}

export interface InstallPlan {
  tool: ExternalTool;
  platform: PlatformKind;
  /** winget / choco / scoop / brew / portable / distro / manual */
  kind: string;
  /** 可直接执行的单行命令 */
  command?: string;
  /** 多行脚本：写入临时文件后交给对应 shell 执行 */
  script?: string;
  scriptShell?: 'powershell' | 'bash';
  /** 需要管理员权限，插件不自动执行，只提供复制 */
  requiresRoot?: boolean;
  /** 备用安装方式（说明用） */
  alternative?: string;
  /** 弹窗正文里的一句话说明 */
  describe: string;
  docs: string;
  hint: string;
}

/** 便携安装目录：Windows 在 %LOCALAPPDATA%\quality-center\tools，其余在 ~/.quality-center/tools */
function portableTarget(tool: ExternalTool): string {
  return path.join(portableToolsDir(), tool.bin === 'mvn' ? 'maven' : tool.bin);
}

function psQuote(value: string): string {
  return value.replace(/'/g, "''");
}

/** Windows 无 winget/choco/scoop 时，直接下官方产物到便携目录（不改 PATH） */
function windowsPortable(tool: ExternalTool): { script: string; describe: string } | undefined {
  const target = psQuote(portableTarget(tool));
  if (tool.bin === 'mvn') {
    const ver = '3.9.9';
    return {
      describe: `下载 apache-maven-${ver} 便携版到 ${portableTarget(tool)}（不修改 PATH）`,
      script: `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ver = '${ver}'
$dir = '${target}'
$zip = Join-Path $env:TEMP 'apache-maven.zip'
$url = "https://archive.apache.org/dist/maven/maven-3/$ver/binaries/apache-maven-$ver-bin.zip"
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Expand-Archive -Force -Path $zip -DestinationPath $dir
Remove-Item $zip -Force
$inner = Join-Path $dir "apache-maven-$ver"
if (Test-Path $inner) {
  Get-ChildItem $inner | Move-Item -Destination $dir -Force
  Remove-Item $inner -Recurse -Force
}
& (Join-Path $dir 'bin\\mvn.cmd') -v
`
    };
  }
  if (tool.bin === 'gitleaks') {
    return {
      describe: `下载 gitleaks 最新版到 ${portableTarget(tool)}（不修改 PATH）`,
      script: `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tag = (Invoke-RestMethod 'https://api.github.com/repos/gitleaks/gitleaks/releases/latest' -Headers @{ 'User-Agent' = 'quality-center' }).tag_name
$ver = $tag.TrimStart('v')
$dir = '${target}'
$zip = Join-Path $env:TEMP 'gitleaks.zip'
$url = "https://github.com/gitleaks/gitleaks/releases/download/$tag/gitleaks_" + $ver + "_windows_x64.zip"
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Expand-Archive -Force -Path $zip -DestinationPath $dir
Remove-Item $zip -Force
& (Join-Path $dir 'gitleaks.exe') --version
`
    };
  }
  return {
    describe: `下载 trivy 最新版到 ${portableTarget(tool)}（不修改 PATH）`,
    script: `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tag = (Invoke-RestMethod 'https://api.github.com/repos/aquasecurity/trivy/releases/latest' -Headers @{ 'User-Agent' = 'quality-center' }).tag_name
$ver = $tag.TrimStart('v')
$dir = '${target}'
$zip = Join-Path $env:TEMP 'trivy.zip'
$url = "https://github.com/aquasecurity/trivy/releases/download/$tag/trivy_" + $ver + "_windows-64bit.zip"
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Expand-Archive -Force -Path $zip -DestinationPath $dir
Remove-Item $zip -Force
& (Join-Path $dir 'trivy.exe') --version
`
  };
}

/** macOS / Linux 无 Homebrew 时，用官方脚本或 release 产物装到便携目录（无需 sudo） */
function posixPortable(tool: ExternalTool): { script: string; describe: string } | undefined {
  const target = portableTarget(tool);
  const header = `set -eu
command -v curl > /dev/null 2>&1 || { echo "需要 curl 才能自动安装" >&2; exit 3; }
`;
  if (tool.bin === 'mvn') {
    return {
      describe: `下载 apache-maven-3.9.9 便携版到 ${target}（不修改 PATH）`,
      script: `${header}ver=3.9.9
dir="$HOME/.quality-center/tools/maven"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/maven.tgz" "https://archive.apache.org/dist/maven/maven-3/$ver/binaries/apache-maven-$ver-bin.tar.gz"
mkdir -p "$dir"
tar -xzf "$tmp/maven.tgz" -C "$dir" --strip-components=1
"$dir/bin/mvn" -v
`
    };
  }
  if (tool.bin === 'gitleaks') {
    return {
      describe: `下载 gitleaks 最新版到 ${target}（不修改 PATH）`,
      script: `${header}os=$(uname -s)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "不支持的系统：$os" >&2; exit 2 ;;
esac
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "不支持的架构：$arch" >&2; exit 2 ;;
esac
tag=$(curl -fsSL "https://api.github.com/repos/gitleaks/gitleaks/releases/latest" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$tag" ] || { echo "无法获取 gitleaks 最新版本" >&2; exit 4; }
ver=\${tag#v}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/gitleaks.tgz" "https://github.com/gitleaks/gitleaks/releases/download/$tag/gitleaks_\${ver}_\${os}_\${arch}.tar.gz"
tar -xzf "$tmp/gitleaks.tgz" -C "$tmp" gitleaks 2>/dev/null || tar -xzf "$tmp/gitleaks.tgz" -C "$tmp"
mkdir -p "$HOME/.quality-center/tools/gitleaks"
cp "$tmp/gitleaks" "$HOME/.quality-center/tools/gitleaks/gitleaks"
chmod 755 "$HOME/.quality-center/tools/gitleaks/gitleaks"
"$HOME/.quality-center/tools/gitleaks/gitleaks" --version
`
    };
  }
  return {
    describe: `用 trivy 官方脚本安装到 ${target}（不修改 PATH）`,
    script: `${header}curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b "$HOME/.quality-center/tools/trivy"
"$HOME/.quality-center/tools/trivy/trivy" --version
`
  };
}

/** Linux 发行版仓库安装命令（需要 sudo，只作为备用说明） */
function linuxRepoCommand(tool: ExternalTool): string | undefined {
  if (tool.apt && resolveBinary('apt-get')) {
    return `sudo apt-get install -y ${tool.apt}`;
  }
  if (tool.dnf && resolveBinary('dnf')) {
    return `sudo dnf install -y ${tool.dnf}`;
  }
  if (tool.pacman && resolveBinary('pacman')) {
    return `sudo pacman -S --noconfirm ${tool.pacman}`;
  }
  return undefined;
}

/**
 * 按当前系统选择安装方式，优先级：
 * Windows: winget → Chocolatey → Scoop → 便携目录（官方产物）
 * macOS:   Homebrew → 便携目录（官方产物）
 * Linux:   Homebrew → 便携目录（无需 sudo，官方产物/官方脚本），apt/dnf/pacman 作为备用说明
 */
export function installPlan(tool: ExternalTool): InstallPlan {
  const platform = currentPlatform();
  const base: InstallPlan = {
    tool,
    platform,
    kind: 'manual',
    describe: `${tool.label} 需要手动安装`,
    docs: tool.docs,
    hint: tool.hint
  };

  if (platform === 'windows') {
    const winget = wingetPath();
    if (tool.winget && winget) {
      return {
        ...base,
        kind: 'winget',
        describe: `用 winget 安装 ${tool.winget}`,
        command:
          `"${winget}" install --id ${tool.winget} -e --source winget ` +
          '--accept-source-agreements --accept-package-agreements'
      };
    }
    const choco = resolveBinary('choco');
    if (tool.choco && choco) {
      return {
        ...base,
        kind: 'choco',
        describe: `用 Chocolatey 安装 ${tool.choco}`,
        command: `"${choco}" install -y ${tool.choco}`
      };
    }
    const scoop = resolveBinary('scoop');
    if (tool.scoop && scoop) {
      return {
        ...base,
        kind: 'scoop',
        describe: `用 Scoop 安装 ${tool.scoop}`,
        command: `"${scoop}" install ${tool.scoop}`
      };
    }
    const portable = windowsPortable(tool);
    if (portable) {
      return {
        ...base,
        kind: 'portable',
        describe: portable.describe,
        script: portable.script,
        scriptShell: 'powershell'
      };
    }
    return base;
  }

  const brew = resolveBinary('brew');
  if (tool.brew && brew) {
    return {
      ...base,
      kind: 'brew',
      describe: `用 Homebrew 安装 ${tool.brew}`,
      command: `"${brew}" install ${tool.brew}`
    };
  }

  const portable = posixPortable(tool);
  const alternative = platform === 'linux' ? linuxRepoCommand(tool) : undefined;
  if (portable) {
    return {
      ...base,
      kind: 'portable',
      describe: portable.describe,
      script: portable.script,
      scriptShell: 'bash',
      alternative
    };
  }
  if (alternative) {
    return {
      ...base,
      kind: 'distro',
      requiresRoot: true,
      describe: '用系统包管理器安装（需要 sudo）',
      command: alternative,
      alternative
    };
  }

  return base;
}

/** 便携安装的落地位置，用于日志与提示 */
export function installLocation(tool: ExternalTool, plan: InstallPlan): string | undefined {
  return plan.kind === 'portable' ? portableTarget(tool) : undefined;
}
