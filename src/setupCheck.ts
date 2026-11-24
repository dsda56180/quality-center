/**
 * 接入状态检测：判断当前项目是否已经把「策略 + 启动器 + Skill + 各编辑器规则/MCP」配齐。
 *
 * 只做只读比对，不落盘；检测与生成共用 integrate 的同一套判定，避免两处口径漂移。
 */
import { integrate } from './integrate';

export interface SetupState {
  configured: boolean;
  missing: string[];
  /** 已检测到的编辑器适配器，用于提示文案 */
  adapters: string[];
}

export function detectSetup(root: string): SetupState {
  const result = integrate(root, { mode: 'auto', check: true });
  const missing = result.files
    .filter((item) => item.action === 'missing' || item.action === 'drift')
    .map((item) => item.file);
  const adapters = result.files
    .map((item) => item.file)
    .filter((file) => !file.startsWith('.quality-center/'))
    .map((file) => file.split('/')[0]);
  return { configured: missing.length === 0, missing, adapters };
}
