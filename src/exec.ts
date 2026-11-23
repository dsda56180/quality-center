import { execSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 正在运行的子进程，用于「终止扫描」时把它们连同子进程一起杀掉 */
const running = new Set<ChildProcess>();

/** 结束整棵进程树：Windows 用 taskkill /T，类 Unix 杀进程组 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore', windowsHide: true });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // 进程已自行退出
  }
}

export function killRunningCommands(): void {
  for (const child of running) {
    killTree(child);
  }
  running.clear();
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * JVM 启动时会把自己捡到的环境变量打到 stderr，例如：
 * `Picked up JAVA_TOOL_OPTIONS: -Dfile.encoding=UTF-8`
 * 这类日志和真正的失败原因混在一起，会把关键信息挤掉，展示前先过滤。
 */
const JVM_NOISE = [
  /^Picked up (?:JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS)/i,
  /^OpenJDK (?:64|32)-Bit Server VM warning/i,
  /^Java HotSpot\(TM\) .*warning/i
];

export function stripJvmNoise(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !JVM_NOISE.some((pattern) => pattern.test(line.trim())))
    .join('\n');
}

/**
 * 取输出末尾若干行作为错误详情：先去噪、去空行、去重复，
 * 避免只剩下 `Picked up JAVA_TOOL_OPTIONS` 这种无用信息。
 */
export function tailMessage(text: string, limit = 5): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of stripJvmNoise(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || seen.has(line)) {
      continue;
    }
    seen.add(line);
    lines.push(line);
  }
  return lines.slice(-limit).join('\n');
}

/** 命令不存在时 shell 给出的典型提示，用于区分「没装」和「跑失败了」 */
export function isMissingCommand(text: string): boolean {
  return /is not recognized as an internal or external command|不是内部或外部命令|command not found|: not found|ENOENT/i.test(
    text
  );
}

/**
 * 直接扫 PATH 定位可执行文件。
 * 某些精简环境里连 `where` 都不在 PATH 中，靠 shell 查找会直接失败，
 * 而 PATH 本身在进程里是可靠的，所以先自己找一遍。
 */
function fromPath(name: string): string | undefined {
  const dirs = (process.env.PATH || '')
    .split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  // Windows 上可执行文件带扩展名；PATHEXT 偶有缺失，因此始终补上常见后缀
  const exts =
    process.platform === 'win32'
      ? Array.from(
          new Set([
            'EXE',
            'CMD',
            'BAT',
            'COM',
            ...(process.env.PATHEXT || '')
              .split(';')
              .filter(Boolean)
              .map((ext) => ext.trim().replace(/^\./, ''))
          ])
        )
      : [];
  const names = [name, ...exts.map((ext) => `${name}.${ext}`)];
  for (const dir of dirs) {
    for (const candidateName of names) {
      const candidate = path.join(dir, candidateName);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // 该目录下没有这个文件，继续下一个
      }
    }
  }
  return undefined;
}

/** 插件自己管理的工具目录：不写 PATH，装完直接在这里找 */
export function portableToolsDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), 'quality-center', 'tools');
  }
  return path.join(os.homedir(), '.quality-center', 'tools');
}

/** 在便携工具目录里按 <tools>/<name>/** 布局查找可执行文件（最多下探 3 层） */
function fromPortableTools(name: string): string | undefined {
  const root = portableToolsDir();
  if (!fs.existsSync(root)) {
    return undefined;
  }
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  const wanted = exts.map((ext) => `${name}${ext}`.toLowerCase());
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 3) {
          stack.push({ dir: full, depth: current.depth + 1 });
        }
        continue;
      }
      if (entry.isFile() && wanted.includes(entry.name.toLowerCase())) {
        return full;
      }
    }
  }
  return undefined;
}

/**
 * 定位可执行文件。
 * IDE 进程可能在工具安装前就已启动，导致 process.env.PATH 过期，
 * 因此依次尝试：显式配置 → PATH → 便携工具目录 → where/which → WinGet → Chocolatey → Scoop。
 */
export function resolveBinary(name: string, configured?: string): string | undefined {
  if (configured) {
    return configured;
  }

  const direct = fromPath(name);
  if (direct) {
    return direct;
  }

  // 插件自己装的工具不需要进 PATH，扫一遍便携目录即可
  const portable = fromPortableTools(name);
  if (portable) {
    return portable;
  }

  try {
    const command = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
    const lines = execSync(command, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const hit = lines.find((line) => fs.existsSync(line));
    if (hit) {
      return hit;
    }
  } catch {
    // 继续尝试常见安装目录
  }

  if (process.platform !== 'win32') {
    return undefined;
  }

  const candidates: string[] = [];
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', `${name}.exe`));
  }
  candidates.push(path.join('C:', 'ProgramData', 'chocolatey', 'bin', `${name}.exe`));
  if (process.env.USERPROFILE) {
    candidates.push(path.join(process.env.USERPROFILE, 'scoop', 'shims', `${name}.exe`));
  }

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function quote(arg: string): string {
  if (!/[\s"&|<>^()]/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * 以 shell 方式执行命令。
 * Windows 上 mvn / gitleaks / trivy 多为 .cmd 或需要 PATHEXT 解析，
 * 因此统一走 shell，并对含空格参数加引号。
 */
export function run(
  command: string,
  args: string[],
  cwd: string,
  timeout = 180_000,
  env?: NodeJS.ProcessEnv
): Promise<RunResult> {
  const line = [command, ...args.map(quote)].join(' ');
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let stdout = '';
    let stderr = '';
    const child = spawn(line, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ...env }
    });
    running.add(child);

    const finish = (code: number, extra?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      running.delete(child);
      resolve({
        code,
        stdout,
        stderr: extra ? `${stderr}${stderr ? '\n' : ''}${extra}` : stderr
      });
    };

    // exec 的 timeout 只结束外层 shell，mvn / trivy 等子进程仍会存活并占住输出流，
    // 导致调用方永远等不到结果。这里到点直接结束整棵进程树并立即返回。
    timer = setTimeout(() => {
      killTree(child);
      finish(124, `命令执行超过 ${Math.round(timeout / 1000)} 秒，已终止`);
    }, timeout);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish(1, error.message));
    child.on('close', (code) => finish(code ?? 1));
  });
}
