import * as fs from 'fs';
import * as path from 'path';
import { Issue } from '../model';
import { resolveBinary, run } from '../exec';

export interface GitleaksResult {
  issues: Issue[];
  error?: string;
  missing?: boolean;
}

interface GitleaksFinding {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  StartColumn?: number;
}

export async function scanGitleaks(
  root: string,
  executable: string,
  reportFile: string,
  configFile?: string
): Promise<GitleaksResult> {
  const exe = resolveBinary('gitleaks', executable);
  if (!exe) {
    return { issues: [], missing: true };
  }

  const version = await run(exe, ['--version'], root, 20_000);
  if (version.code !== 0) {
    return { issues: [], missing: true };
  }

  try {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    if (fs.existsSync(reportFile)) {
      fs.unlinkSync(reportFile);
    }
  } catch {
    // 忽略，交由下方判断
  }

  const args = [
    'detect',
    '--no-git',
    '--source',
    root,
    '--redact',
    '--report-format',
    'json',
    '--report-path',
    reportFile
  ];
  if (configFile && fs.existsSync(configFile)) {
    args.push('--config', configFile);
  }

  const result = await run(exe, args, root, 300_000);

  // gitleaks: 0 无问题，1 发现问题，其它为运行错误
  if (result.code !== 0 && result.code !== 1) {
    const detail = result.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join('\n');
    return { issues: [], error: detail || `gitleaks 退出码 ${result.code}` };
  }

  if (!fs.existsSync(reportFile)) {
    return { issues: [] };
  }

  let findings: GitleaksFinding[] = [];
  try {
    const raw = fs.readFileSync(reportFile, 'utf8').trim();
    findings = raw ? (JSON.parse(raw) as GitleaksFinding[]) : [];
  } catch (err) {
    return { issues: [], error: `解析 gitleaks 报告失败：${(err as Error).message}` };
  }

  const issues = findings.map<Issue>((finding) => {
    const rel = finding.File || '';
    return {
      source: 'gitleaks',
      severity: 'high',
      file: rel ? path.resolve(root, rel) : undefined,
      line: finding.StartLine || 1,
      column: finding.StartColumn || 1,
      rule: finding.RuleID || 'secret',
      message: finding.Description || '检测到疑似硬编码凭证'
    };
  });

  return { issues };
}
