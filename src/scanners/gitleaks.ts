import * as fs from 'fs';
import * as path from 'path';
import { Issue } from '../model';
import { resolveBinary, run, tailMessage } from '../exec';
import { localizeGitleaks } from '../zh';

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
    // 找得到文件但跑不起来（架构不匹配、被杀软拦截等），算错误而不是“未安装”
    const detail = tailMessage(`${version.stderr}\n${version.stdout}`, 3);
    return {
      issues: [],
      error:
        `gitleaks 无法执行（退出码 ${version.code}）：${detail || exe}` +
        '。请检查 qualityCenter.gitleaks.path 是否指向正确的可执行文件，或重新安装。'
    };
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
    const detail = tailMessage(result.stderr, 3);
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
    return localizeGitleaks({
      source: 'gitleaks',
      severity: 'high',
      file: rel ? path.resolve(root, rel) : undefined,
      line: finding.StartLine || 1,
      column: finding.StartColumn || 1,
      rule: finding.RuleID || 'secret',
      message: finding.Description || '检测到疑似硬编码凭证'
    });
  });

  return { issues };
}
