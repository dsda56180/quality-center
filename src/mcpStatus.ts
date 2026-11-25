import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type McpState = 'checking' | 'missing' | 'configured' | 'ready' | 'broken';

export interface McpStatus {
  state: McpState;
  /** 面板一行状态：MCP 未配置 / MCP 已就绪 */
  label: string;
  /** 给用户看的下一步 */
  detail: string;
  /** 配置文件（相对项目根） */
  configFile?: string;
  /** 识别到的编辑器：Trae / Cursor / VS Code / 通用 */
  editor?: string;
  /** 自检发现的工具数 */
  tools?: number;
}

const CONFIG_CANDIDATES: Array<{ file: string; editor: string; key: 'mcpServers' | 'servers' }> = [
  { file: '.trae/mcp.json', editor: 'Trae', key: 'mcpServers' },
  { file: '.cursor/mcp.json', editor: 'Cursor', key: 'mcpServers' },
  { file: '.vscode/mcp.json', editor: 'VS Code', key: 'servers' },
  { file: '.mcp.json', editor: '通用', key: 'mcpServers' }
];

interface ConfigHit {
  file: string;
  editor: string;
  registered: boolean;
}

function inspectConfig(root: string): ConfigHit | undefined {
  for (const candidate of CONFIG_CANDIDATES) {
    const file = path.join(root, candidate.file);
    if (!fs.existsSync(file)) {
      continue;
    }
    let registered = false;
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const servers = (doc[candidate.key] ?? doc.mcpServers ?? doc.servers) as Record<string, unknown> | undefined;
      for (const [name, value] of Object.entries(servers ?? {})) {
        const text = JSON.stringify(value);
        if (name.toLowerCase().includes('quality-center') || /qc\.c?js/.test(text)) {
          registered = true;
          break;
        }
      }
    } catch {
      registered = false;
    }
    return { file: candidate.file, editor: candidate.editor, registered };
  }
  return undefined;
}

function probeServer(root: string, launcher: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const child = spawn('node', [launcher, 'mcp'], {
      cwd: root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let settled = false;
    let tools: number | undefined;
    const finish = (count?: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      tools = count;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // 进程可能已经退出
      }
      resolve(tools);
    };
    const timer = setTimeout(() => finish(undefined), 6000);
    const send = (payload: unknown): void => {
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch {
        finish(undefined);
      }
    };
    child.on('error', () => finish(undefined));
    child.stdin.on('error', () => finish(undefined));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        try {
          const message = JSON.parse(line) as { id?: number; result?: { tools?: unknown[] } };
          if (message.id === 1) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          } else if (message.id === 2) {
            const list = message.result?.tools;
            finish(Array.isArray(list) ? list.length : undefined);
          }
        } catch {
          // 忽略 stderr / 非 JSON 行
        }
      }
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'quality-center-panel', version: '0.1' }
      }
    });
  });
}

/** 检测项目 MCP 配置 + 启动服务做一次 tools/list 自检 */
export async function probeMcp(root: string): Promise<McpStatus> {
  if (!root || !fs.existsSync(root)) {
    return {
      state: 'missing',
      label: 'MCP 未配置',
      detail: '还没有打开项目，无法检测。'
    };
  }
  const hit = inspectConfig(root);
  const launcher = path.join(root, '.quality-center', 'bin', 'qc.cjs');
  const hasLauncher = fs.existsSync(launcher);

  if (!hit) {
    return {
      state: 'missing',
      label: 'MCP 未配置',
      detail: '点「接入」生成编辑器 MCP 配置；生成后还需在 IDE 里启用项目级 MCP 并信任。'
    };
  }
  if (!hit.registered) {
    return {
      state: 'broken',
      label: 'MCP 配置异常',
      detail: `${hit.file} 存在，但没有注册 quality-center 服务。点「修复」重新生成。`,
      configFile: hit.file,
      editor: hit.editor
    };
  }
  if (!hasLauncher) {
    return {
      state: 'broken',
      label: 'MCP 启动器缺失',
      detail: '.quality-center/bin/qc.cjs 不存在。点「修复」重新接入。',
      configFile: hit.file,
      editor: hit.editor
    };
  }

  const tools = await probeServer(root, launcher);
  if (tools && tools > 0) {
    // Trae 的项目级 MCP 默认需要手动启用/信任，插件无法通过公开 API 读取这个开关；
    // 服务自检通过只能说明“已配置”，不能替 IDE 宣称“AI 已能搜到工具”。
    const needsClientEnable = hit.editor === 'Trae';
    return {
      state: needsClientEnable ? 'configured' : 'ready',
      label: `${needsClientEnable ? 'MCP 已配置' : 'MCP 已就绪'} · ${tools} 个工具`,
      detail: needsClientEnable
        ? `${hit.file} 已配置，本地 MCP 服务自检通过。Trae 还需在“设置 → MCP 服务器”启用项目级 MCP 并信任；AI 能搜到 quality_* 后即为真正就绪。`
        : `${hit.editor} 的 ${hit.file} 已配置，MCP 服务自检通过，共 ${tools} 个工具。`,
      configFile: hit.file,
      editor: hit.editor,
      tools
    };
  }
  return {
    state: 'broken',
    label: 'MCP 服务无响应',
    detail: `${hit.editor} 的 ${hit.file} 已配置，但 qc.cjs mcp 没有返回工具列表。点「修复」或查看日志。`,
    configFile: hit.file,
    editor: hit.editor
  };
}
