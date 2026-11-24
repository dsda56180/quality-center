/**
 * 一屏状态：工具就绪、最近扫描、升级计划进度、pom 哈希。
 *
 * 动机：AI 判断「要不要重扫 / 计划走到哪」原本要分别调 tools_status、report、check 三次，
 * 每次都带一份不小的返回体；这里合成一次调用，减少往返与重复 token。
 */
import * as fs from 'fs';
import * as path from 'path';
import { toolsStatusPayload } from './agentOps';
import { checkUpgradePlan, hashText } from './upgradePlanFile';
import { readDigest } from './scanDigest';

export interface ProjectStatus {
  tools: { id: string; found: boolean; path: string; installable: boolean }[];
  scan: Record<string, unknown>;
  upgradePlan: Record<string, unknown> | null;
  pom: { file: string; hash: string };
  nextStep: string;
}

export function projectStatus(root: string): ProjectStatus {
  const tools = toolsStatusPayload().tools.map((tool) => ({
    id: tool.id,
    found: tool.found,
    path: tool.path,
    installable: tool.installable
  }));

  const issuesFile = path.join(root, '.quality-center', 'issues.json');
  let scan: Record<string, unknown> = { hasResult: false };
  if (fs.existsSync(issuesFile)) {
    try {
      const payload = JSON.parse(fs.readFileSync(issuesFile, 'utf8')) as {
        generatedAt?: string;
        issues?: unknown[];
        summary?: unknown;
      };
      scan = {
        hasResult: true,
        generatedAt: payload.generatedAt,
        total: Array.isArray(payload.issues) ? payload.issues.length : 0,
        summary: payload.summary,
        issuesFile: path.relative(root, issuesFile)
      };
    } catch {
      scan = { hasResult: false, error: 'issues.json 无法解析，建议重新扫描' };
    }
  }
  scan.deltaBaseline = readDigest(root)?.generatedAt ?? null;

  let upgradePlan: Record<string, unknown> | null = null;
  try {
    const check = checkUpgradePlan(root);
    upgradePlan = {
      planId: check.planId,
      state: check.state,
      appliedCount: check.appliedCount,
      total: check.total,
      nextGroup: check.nextGroup
    };
  } catch {
    upgradePlan = null;
  }

  let pomHash = '';
  try {
    pomHash = hashText(fs.readFileSync(path.join(root, 'pom.xml'), 'utf8'));
  } catch {
    pomHash = '';
  }

  return {
    tools,
    scan,
    upgradePlan,
    pom: { file: 'pom.xml', hash: pomHash },
    nextStep: upgradePlan
      ? `计划 ${String(upgradePlan.planId)} 处于 ${String(upgradePlan.state)}；按 groups 顺序推进，别重新 plan`
      : '还没有升级计划：先 quality_upgrade_plan 生成计划，再 apply'
  };
}
