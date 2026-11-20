import { exec, execSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** 正在运行的子进程，用于「终止扫描」时把它们连同子进程一起杀掉 */
const running = new Set<ChildProcess>();

export function killRunningCommands(): void {
  for (const child of running) {
    const pid = child.pid;
    if (!pid) {
      continue;
    }
    try {
      if (process.platform === 'win32') {
        // /T 连同 JVM 等子进程一起结束
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
    const child = exec(
      line,
      {
        cwd,
        timeout,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...env }
      },
      (err, stdout, stderr) => {
        running.delete(child);
        const code = err && typeof (err as { code?: number }).code === 'number'
          ? (err as unknown as { code: number }).code
          : err
            ? 1
            : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    );
    running.add(child);
  });
}
