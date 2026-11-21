import { execSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
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
 * 定位可执行文件。
 * IDE 进程可能在工具安装前就已启动，导致 process.env.PATH 过期，
 * 因此依次尝试：显式配置 → where/which → WinGet → Chocolatey → Scoop。
 */
export function resolveBinary(name: string, configured?: string): string | undefined {
  if (configured) {
    return configured;
  }

  try {
    const command = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
    const lines = execSync(command, { encoding: 'utf8', windowsHide: true })
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
