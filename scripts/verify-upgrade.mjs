#!/usr/bin/env node
/**
 * 升级流程的端到端自检：不依赖任何编辑器的 AI，只用 CLI / MCP 协议验证确定性部分。
 *
 * 覆盖：
 * 1) plan 只读、产物齐全（plan.json / pom.diff）
 * 2) 哈希不符拒绝落盘
 * 3) --write 后 pom 与计划一致，patch 可被 git apply
 * 4) upgrade check 通过
 * 5) integrate 幂等 + 漂移检测
 * 6) MCP tools/list 含升级工具，错误哈希返回 isError
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'out', 'cli.js');

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sha256(text) {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...options });
  return { code: result.status ?? 2, out: result.stdout ?? '', err: result.stderr ?? '' };
}

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>2.4.2</version>
    <relativePath/>
  </parent>
  <groupId>com.example</groupId>
  <artifactId>demo-upgrade</artifactId>
  <version>1.0.0</version>
  <properties>
    <java.version>8</java.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.alibaba</groupId>
      <artifactId>fastjson</artifactId>
      <version>1.2.83</version>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
</project>
`;

const ISSUES = {
  schemaVersion: '2',
  generatedAt: new Date().toISOString(),
  issues: [
    {
      source: 'trivy',
      severity: 'high',
      rule: 'CVE-2024-22262',
      message: 'spring-web URL 解析漏洞',
      packageName: 'org.springframework:spring-web',
      installedVersion: '5.3.9',
      fixedVersion: '5.3.39'
    },
    {
      source: 'trivy',
      severity: 'critical',
      rule: 'CVE-2023-45648',
      message: 'tomcat 请求走私',
      packageName: 'org.apache.tomcat.embed:tomcat-embed-core',
      installedVersion: '9.0.41',
      fixedVersion: '9.0.83'
    },
    {
      source: 'trivy',
      severity: 'high',
      rule: 'CVE-2022-25845',
      message: 'fastjson 反序列化',
      packageName: 'com.alibaba:fastjson',
      installedVersion: '1.2.83',
      fixedVersion: '2.0.25'
    }
  ],
  ignored: [],
  errors: [],
  skipped: [],
  suggestions: []
};

function prepare() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-upgrade-'));
  fs.writeFileSync(path.join(dir, 'pom.xml'), POM, 'utf8');
  fs.mkdirSync(path.join(dir, '.quality-center'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.quality-center', 'issues.json'), JSON.stringify(ISSUES, null, 2), 'utf8');
  return dir;
}

function mcpClient(cwd) {
  const proc = spawn(process.execPath, [CLI, 'mcp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const waiters = new Map();
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const waiter = waiters.get(msg.id);
        if (waiter) {
          waiters.delete(msg.id);
          waiter(msg);
        }
      } catch {
        /* 忽略非协议输出 */
      }
    }
  });
  let nextId = 1;
  return {
    request(method, params) {
      const id = nextId++;
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`MCP 请求超时：${method}`));
        }, 20000);
        waiters.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    close() {
      proc.stdin.end();
      proc.kill();
    }
  };
}

async function main() {
  console.log(`quality-center 升级自检 · ${ROOT}\n`);
  const dir = prepare();
  const pomFile = path.join(dir, 'pom.xml');
  const original = fs.readFileSync(pomFile, 'utf8');

  console.log('1) plan：只读、产物齐全');
  const planRun = run(['upgrade', 'plan', dir, '--json']);
  check('plan 退出码 0', planRun.code === 0, planRun.err.trim());
  const plan = planRun.code === 0 ? JSON.parse(planRun.out) : {};
  check('schemaVersion = 3', plan.schemaVersion === '3', String(plan.schemaVersion));
  check('pomHash 与当前 pom 一致', plan.pomHash === sha256(original));
  check('框架目标由策略推导（2.7.18）', plan.project?.frameworkTarget === '2.7.18', String(plan.project?.frameworkTarget));
  check(
    'Spring Boot 候选存在',
    Array.isArray(plan.candidates) &&
      plan.candidates.some((item) => item.groupId === 'org.springframework.boot' && item.mode === 'parent')
  );
  const reuseRun = run(['upgrade', 'plan', dir, '--reuse', '--json']);
  check('plan --reuse 复用同 hash 的计划', JSON.parse(reuseRun.out).planId === plan.planId);

  const duplicateRun = run(['upgrade', 'plan', dir, '--json']);
  check(
    '已有进行中计划时拒绝再生成第二个',
    duplicateRun.code === 2 && /已有进行中的升级计划/.test(`${duplicateRun.out}${duplicateRun.err}`),
    `${duplicateRun.out}${duplicateRun.err}`.trim()
  );

  // 同一批问题、只是扫描时间变了：仍应命中复用（issuesHash 不含 generatedAt）
  const issuesFile = path.join(dir, '.quality-center', 'issues.json');
  const repayload = JSON.parse(fs.readFileSync(issuesFile, 'utf8'));
  repayload.generatedAt = new Date(Date.now() + 3600_000).toISOString();
  fs.writeFileSync(issuesFile, JSON.stringify(repayload, null, 2), 'utf8');
  const reuseAgain = run(['upgrade', 'plan', dir, '--reuse', '--json']);
  check('重扫时间戳变化不影响复用', JSON.parse(reuseAgain.out).planId === plan.planId, reuseAgain.out.slice(0, 200));

  // 0 候选：不生成计划目录，避免留下 0/0 空计划
  const { createUpgradePlan } = await import(pathToFileURL(path.join(ROOT, 'out', 'upgradePlanFile.js')).href);
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-empty-'));
  fs.writeFileSync(path.join(emptyDir, 'pom.xml'), POM, 'utf8');
  const emptyPlan = createUpgradePlan(emptyDir, []);
  check('0 候选不生成计划', emptyPlan.plan.candidates.length === 0 && emptyPlan.planPath === '');
  check('0 候选不写目录', !fs.existsSync(path.join(emptyDir, '.quality-center', 'upgrade')));
  fs.rmSync(emptyDir, { recursive: true, force: true });
  check('pom 未被改动', fs.readFileSync(pomFile, 'utf8') === original);
  check('pom.diff 已生成', fs.existsSync(path.join(dir, '.quality-center', 'upgrade', plan.planId, 'pom.diff')));
  check(
    'plan 带分组与推进顺序',
    Array.isArray(plan.groups) &&
      plan.groups.length >= 2 &&
      plan.groups[0].name === 'framework' &&
      plan.candidates.every((item) => typeof item.group === 'string'),
    JSON.stringify(plan.groups?.map((group) => group.name))
  );

  const managedDir = prepare();
  const managedPom = POM.replace(
    '<java.version>8</java.version>',
    '<java.version>8</java.version>\n    <okhttp.version>4.1.0</okhttp.version>'
  ).replace(
    '</dependencies>',
    [
      '  <dependency>',
      '    <groupId>com.squareup.okhttp3</groupId>',
      '    <artifactId>okhttp</artifactId>',
      '    <version>${okhttp.version}</version>',
      '  </dependency>',
      '</dependencies>'
    ].join('\n')
  );
  fs.writeFileSync(path.join(managedDir, 'pom.xml'), managedPom, 'utf8');
  fs.writeFileSync(
    path.join(managedDir, '.quality-center', 'issues.json'),
    JSON.stringify(
      {
        ...ISSUES,
        issues: [
          ...ISSUES.issues,
          {
            source: 'trivy',
            severity: 'high',
            rule: 'CVE-2023-0833',
            message: 'okhttp 漏洞',
            packageName: 'com.squareup.okhttp3:okhttp',
            installedVersion: '4.1.0',
            fixedVersion: '4.9.2'
          }
        ]
      },
      null,
      2
    ),
    'utf8'
  );
  const managedPlan = JSON.parse(run(['upgrade', 'plan', managedDir, '--json']).out);
  const managedCandidate = managedPlan.candidates?.find(
    (item) => item.packageName === 'com.squareup.okhttp3:okhttp'
  );
  check(
    '框架 BOM 属性覆盖依赖并入 framework 组',
    managedCandidate?.group === 'framework',
    JSON.stringify({ group: managedCandidate?.group, property: managedCandidate?.property })
  );
  const patch = fs.existsSync(path.join(dir, '.quality-center', 'upgrade', plan.planId, 'pom.diff'))
    ? fs.readFileSync(path.join(dir, '.quality-center', 'upgrade', plan.planId, 'pom.diff'), 'utf8')
    : '';
  check('patch 带统一 diff 头', patch.startsWith('--- a/pom.xml'));

  console.log('2) apply：哈希保护');
  const badHash = run(['upgrade', 'apply', dir, '--plan', plan.planId, '--hash', 'sha256:deadbeef']);
  check('错误哈希被拒绝（退出码 2）', badHash.code === 2);
  check('拒绝后 pom 未变化', fs.readFileSync(pomFile, 'utf8') === original);

  console.log('3) apply：预览 → 落盘');
  const preview = run(['upgrade', 'apply', dir, '--plan', plan.planId, '--hash', plan.pomHash, '--allow-cross-line']);
  check('预览退出码 0', preview.code === 0, preview.err.trim());
  check('预览输出 patch', preview.out.includes('--- a/pom.xml'));
  check('预览不落盘', fs.readFileSync(pomFile, 'utf8') === original);

  const applied = run([
    'upgrade',
    'apply',
    dir,
    '--plan',
    plan.planId,
    '--hash',
    plan.pomHash,
    '--write',
    '--allow-cross-line'
  ]);
  check('落盘退出码 0', applied.code === 0, applied.err.trim());
  const after = fs.readFileSync(pomFile, 'utf8');
  check('pom 已变化', after !== original);
  check('落盘结果哈希与计划一致', sha256(after) === plan.pomHashAfter);
  check('Spring Boot 版本已升到 2.7.18', after.includes('<version>2.7.18</version>'));

  console.log('4) patch 可被 git apply 复现');
  const probe = path.join(os.tmpdir(), `qc-patch-${process.pid}`);
  fs.rmSync(probe, { recursive: true, force: true });
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, 'pom.xml'), original, 'utf8');
  spawnSync('git', ['init', '-q'], { cwd: probe });
  fs.writeFileSync(path.join(probe, 'pom.diff'), patch, 'utf8');
  const gitArgs = ['-c', 'core.autocrlf=false', 'apply'];
  const gitApply = spawnSync('git', [...gitArgs, '--check', 'pom.diff'], { cwd: probe, encoding: 'utf8' });
  check('git apply --check 通过', gitApply.status === 0, gitApply.stderr?.trim());
  const gitApplyReal = spawnSync('git', [...gitArgs, 'pom.diff'], { cwd: probe, encoding: 'utf8' });
  check('git apply 后内容与落盘一致', gitApplyReal.status === 0 && fs.readFileSync(path.join(probe, 'pom.xml'), 'utf8') === after);

  console.log('5) check 门禁');
  const checkRun = run(['upgrade', 'check', dir, '--plan', plan.planId]);
  check('check 退出码 0', checkRun.code === 0, checkRun.out.trim());
  check('状态为 applied', checkRun.out.includes('applied'));

  console.log('6) integrate：生成、幂等、漂移');
  const plainDir = prepare();
  const autoRun = run(['integrate', plainDir]);
  check('默认 auto 退出码 0', autoRun.code === 0, autoRun.err.trim());
  check('默认不生成 AGENTS.md', !fs.existsSync(path.join(plainDir, 'AGENTS.md')));
  check('默认不生成根 .mcp.json', !fs.existsSync(path.join(plainDir, '.mcp.json')));
  check('默认仍生成数据目录', fs.existsSync(path.join(plainDir, '.quality-center/upgrade-policy.json')));
  check('默认自带忽略清单', fs.existsSync(path.join(plainDir, '.quality-center/.gitignore')));

  const integrateRun = run(['integrate', dir, '--all', '--fallback']);
  check('integrate 退出码 0', integrateRun.code === 0, integrateRun.err.trim());
  for (const rel of [
    '.quality-center/upgrade-policy.json',
    '.quality-center/.gitignore',
    '.quality-center/bin/qc.cjs',
    '.quality-center/skills/quality-center-java-upgrade/SKILL.md',
    '.trae/rules/quality-center.md',
    '.trae/mcp.json',
    '.cursor/rules/quality-center.mdc',
    '.cursor/mcp.json',
    '.vscode/mcp.json',
    '.github/instructions/quality-center.instructions.md',
    '.mcp.json',
    'AGENTS.md'
  ]) {
    check(`生成 ${rel}`, fs.existsSync(path.join(dir, rel)));
  }
  check('数据目录自带忽略清单', fs.readFileSync(path.join(dir, '.quality-center/.gitignore'), 'utf8').includes('upgrade/'));
  const traeMcp = JSON.parse(fs.readFileSync(path.join(dir, '.trae/mcp.json'), 'utf8'));
  const traeEntry = traeMcp.mcpServers?.['quality-center'];
  check(
    'Trae MCP 使用项目内绝对启动器路径',
    traeEntry?.args?.[0] === path.join(dir, '.quality-center', 'bin', 'qc.cjs') &&
      traeEntry?.cwd === path.resolve(dir) &&
      !JSON.stringify(traeEntry).includes('${workspaceFolder}')
  );
  const vscodeMcp = JSON.parse(fs.readFileSync(path.join(dir, '.vscode/mcp.json'), 'utf8'));
  check('VS Code 用 servers + type=stdio', vscodeMcp.servers?.['quality-center']?.type === 'stdio');

  const checkClean = run(['integrate', dir, '--all', '--fallback', '--check']);
  check('--check 干净时退出码 0', checkClean.code === 0, checkClean.out.trim());

  const policyFile = path.join(dir, '.quality-center', 'upgrade-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  policy.forbiddenPackages = ['com.alibaba:fastjson'];
  fs.writeFileSync(policyFile, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
  const drift = run(['integrate', dir, '--all', '--fallback', '--check']);
  check('策略变更后 --check 仍为 0（适配器不内嵌策略）', drift.code === 0, drift.out.trim());

  const ruleFile = path.join(dir, '.trae/rules/quality-center.md');
  const MARK = '<!-- 用户手改 -->';
  fs.writeFileSync(ruleFile, `${fs.readFileSync(ruleFile, 'utf8')}\n${MARK}\n`, 'utf8');
  const drift2 = run(['integrate', dir, '--all', '--fallback', '--check']);
  check('规则被手改后 --check 报漂移（退出码 1）', drift2.code === 1);

  const again = run(['integrate', dir, '--all', '--fallback']);
  check('重新生成退出码 0', again.code === 0);
  check('--check 恢复 0', run(['integrate', dir, '--all', '--fallback', '--check']).code === 0);
  check('手改内容被覆盖', !fs.readFileSync(ruleFile, 'utf8').includes(MARK));

  console.log('7) MCP：工具可见 + 哈希拒绝');
  const client = mcpClient(dir);
  const init = await client.request('initialize', { protocolVersion: '2024-11-05' });
  check('initialize 返回 serverInfo', init.result?.serverInfo?.name === 'quality-center');
  const list = await client.request('tools/list', {});
  const names = (list.result?.tools ?? []).map((tool) => tool.name);
  check('tools/list 含 quality_upgrade_plan', names.includes('quality_upgrade_plan'));
  check('tools/list 含 quality_upgrade_apply', names.includes('quality_upgrade_apply'));
  check('tools/list 含 quality_upgrade_check', names.includes('quality_upgrade_check'));
  check('tools/list 含 quality_upgrade_revert', names.includes('quality_upgrade_revert'));
  check('tools/list 含 quality_next', names.includes('quality_next'));
  check('tools/list 含 quality_agent_brief', names.includes('quality_agent_brief'));
  check('tools/list 含 quality_explain', names.includes('quality_explain'));
  const briefCall = await client.request('tools/call', {
    name: 'quality_agent_brief',
    arguments: { path: dir }
  });
  const brief = JSON.parse(briefCall.result?.content?.[0]?.text ?? '{}');
  check(
    'MCP brief 返回完整驱动指令与状态',
    brief.prompt?.includes('启动前确认') && typeof brief.next?.state === 'string',
    JSON.stringify({ state: brief.next?.state, promptLength: brief.prompt?.length })
  );
  const autopilotCall = await client.request('tools/call', {
    name: 'quality_agent_brief',
    arguments: { path: dir, mode: 'autopilot' }
  });
  const autopilot = JSON.parse(autopilotCall.result?.content?.[0]?.text ?? '{}');
  check(
    'MCP autopilot 只做一次目标确认并连续执行',
    autopilot.prompt?.includes('目标确认') &&
      autopilot.prompt?.includes('确认后连续执行到收尾') &&
      autopilot.prompt?.includes('不要每完成一组就停下来') &&
      autopilot.prompt?.includes('quality_scan') === true,
    JSON.stringify({ length: autopilot.prompt?.length })
  );
  const badCall = await client.request('tools/call', {
    name: 'quality_upgrade_apply',
    arguments: { path: dir, planId: plan.planId, pomHash: 'sha256:deadbeef', write: false }
  });
  check('MCP 错误哈希返回 isError', badCall.result?.isError === true);
  const checkCall = await client.request('tools/call', {
    name: 'quality_upgrade_check',
    arguments: { path: dir, planId: plan.planId }
  });
  check('MCP check 返回 applied', checkCall.result?.content?.[0]?.text?.includes('"state": "applied"'));

  const statusCall = await client.request('tools/call', { name: 'quality_status', arguments: { path: dir } });
  const status = JSON.parse(statusCall.result?.content?.[0]?.text ?? '{}');
  check('MCP status 带工具状态', Array.isArray(status.tools) && status.tools.length > 0);
  check('MCP status 带扫描计数', status.scan?.hasResult === true && status.scan?.total === 3);
  check('MCP status 带计划进度', status.upgradePlan?.state === 'applied');
  check('MCP status 带运行态（事件快照）', typeof status.run?.runId === 'string' && status.run?.status === 'running');
  check(
    'MCP 工具包含 quality_finalize',
    names.includes('quality_finalize') && names.includes('quality_fix_rollback')
  );

  const baselineDigest = {
    generatedAt: new Date().toISOString(),
    total: ISSUES.issues.length,
    summary: { total: ISSUES.issues.length, trivy: ISSUES.issues.length, high: 2, critical: 1 },
    keys: ISSUES.issues.map((issue) => [issue.source, issue.rule, issue.package ?? '', issue.file ?? '', issue.line ?? 0].join('|'))
  };
  fs.writeFileSync(
    path.join(dir, '.quality-center', 'scan-baseline.json'),
    JSON.stringify(baselineDigest, null, 2),
    'utf8'
  );
  const finalizeCall = await client.request('tools/call', {
    name: 'quality_finalize',
    arguments: { path: dir }
  });
  const finalized = JSON.parse(finalizeCall.result?.content?.[0]?.text ?? '{}');
  check(
    'finalize 由插件算基线/最终计数',
    finalized.ok === true && finalized.baseline?.total === 3 && finalized.current?.total === 3,
    JSON.stringify({ ok: finalized.ok, baseline: finalized.baseline?.total, current: finalized.current?.total, reason: finalized.reason })
  );
  check(
    'finalize 落盘 final-report.json / md',
    fs.existsSync(path.join(dir, '.quality-center', 'final-report.json')) &&
      fs.existsSync(path.join(dir, '.quality-center', 'final-report.md'))
  );

  // 旧扫描结果不得收尾：否则 AI 改完文件直接 finalize，面板永远看不到复扫
  const issuesPath = path.join(dir, '.quality-center', 'issues.json');
  const staleIssues = JSON.parse(fs.readFileSync(issuesPath, 'utf8'));
  staleIssues.generatedAt = '2020-01-01T00:00:00.000Z';
  fs.writeFileSync(issuesPath, JSON.stringify(staleIssues, null, 2), 'utf8');
  const staleFinalize = await client.request('tools/call', { name: 'quality_finalize', arguments: { path: dir } });
  const staleResult = JSON.parse(staleFinalize.result?.content?.[0]?.text ?? '{}');
  check('finalize 拒绝早于源码变更的旧扫描', staleResult.ok === false && String(staleResult.reason).includes('扫描结果早于源码'));
  fs.writeFileSync(issuesPath, JSON.stringify(ISSUES, null, 2), 'utf8');

  const grouped = await client.request('tools/call', {
    name: 'quality_upgrade_plan',
    arguments: { path: dir, group: 'framework', reuse: true, top: 1 }
  });
  const groupedPlan = JSON.parse(grouped.result?.content?.[0]?.text ?? '{}');
  if (groupedPlan.empty) {
    check(
      'MCP plan 无可升级项时返回 empty（不生成第二个计划）',
      groupedPlan.candidateCount === 0 && typeof groupedPlan.hint === 'string',
      JSON.stringify(groupedPlan)
    );
  } else {
    check(
      'MCP plan 默认按组返回',
      groupedPlan.groupShown === 'framework' &&
        Array.isArray(groupedPlan.candidates) &&
        groupedPlan.candidates.every((item) => item.group === 'framework') &&
        groupedPlan.patchPreview === undefined,
      JSON.stringify({ group: groupedPlan.groupShown, n: groupedPlan.candidates?.length })
    );
  }
  client.close();

  console.log('8) 分组推进：跨线拒绝 → 逐组落盘 → 回滚');
  const dir2 = prepare();
  const plan2 = JSON.parse(run(['upgrade', 'plan', dir2, '--json']).out);
  const pom2 = path.join(dir2, 'pom.xml');
  const original2 = fs.readFileSync(pom2, 'utf8');
  check('计划里存在跨大版本候选', plan2.candidates.some((item) => item.crossLine));
  const deny = run([
    'upgrade',
    'apply',
    dir2,
    '--plan',
    plan2.planId,
    '--hash',
    plan2.pomHash,
    '--write',
    '--group',
    'cross-line'
  ]);
  check('跨线组默认被拒绝（退出码 2）', deny.code === 2, deny.out.trim());
  check('拒绝后 pom 未变化', fs.readFileSync(pom2, 'utf8') === original2);

  const fw = run([
    'upgrade',
    'apply',
    dir2,
    '--plan',
    plan2.planId,
    '--hash',
    plan2.pomHash,
    '--write',
    '--group',
    'framework',
    '--json'
  ]);
  const fwResult = fw.code === 0 ? JSON.parse(fw.out) : {};
  check('框架组落盘成功', fw.code === 0, fw.err.trim());
  check('只落了框架组（partial + nextGroup）', fwResult.partial === true && !!fwResult.nextGroup, JSON.stringify(fwResult.nextGroup));
  check('框架组后 Spring Boot = 2.7.18', fs.readFileSync(pom2, 'utf8').includes('<version>2.7.18</version>'));
  const partialCheck = run(['upgrade', 'check', dir2, '--plan', plan2.planId]);
  check('check 报 partial', partialCheck.code === 1 && partialCheck.out.includes('partial'), partialCheck.out.trim());

  const rev = run(['upgrade', 'revert', dir2, '--plan', plan2.planId]);
  check('回滚退出码 0', rev.code === 0, rev.err.trim());
  check('回滚后 pom 与计划前一致', fs.readFileSync(pom2, 'utf8') === original2);
  const afterRevert = run(['upgrade', 'check', dir2, '--plan', plan2.planId]);
  check('回滚后 check 回到 pending', afterRevert.out.includes('pending'), afterRevert.out.trim());
  check('pending 用进度符号而不是失败叉号', !afterRevert.out.trimStart().startsWith('✗') && afterRevert.out.includes('待落盘'), afterRevert.out.trim());

  const replay = run([
    'upgrade',
    'apply',
    dir2,
    '--plan',
    plan2.planId,
    '--hash',
    plan2.pomHash,
    '--write',
    '--group',
    'framework'
  ]);
  check('回滚后可重新推进', replay.code === 0, replay.err.trim());

  console.log('9) scan 摘要：默认不带全量、delta 只比变化');
  const { digestScan } = await import(pathToFileURL(path.join(ROOT, 'out', 'scanDigest.js')).href);
  const baseIssue = (over) => ({
    id: 1,
    source: 'trivy',
    severity: 'high',
    severityLabel: '高危',
    rule: 'CVE-2024-0001',
    file: '',
    abs: '',
    line: 0,
    column: 0,
    message: 'm',
    zhSummary: '说明',
    advice: '',
    fixable: false,
    package: 'a:b',
    installedVersion: '1.0.0',
    fixedVersion: '1.0.1',
    cvss: 7.5,
    cwe: [],
    ...over
  });
  const dir3 = prepare();
  const payloadA = {
    schemaVersion: '2',
    generatedAt: '2026-01-01T00:00:00.000Z',
    projectRoot: dir3,
    summary: { total: 3 },
    issues: [baseIssue({ id: 1 }), baseIssue({ id: 2, rule: 'CVE-2' }), baseIssue({ id: 3, rule: 'CVE-3' })],
    ignored: [],
    suggestions: [],
    errors: [],
    skipped: [],
    missingTools: [],
    buildHint: '',
    files: { issuesJson: '.quality-center/issues.json' },
    nextActions: []
  };
  const digestA = digestScan(dir3, payloadA, { top: 2 });
  check('summary 不带全量 issues', digestA.body.issues === undefined);
  check('summary 只给 Top N', digestA.body.top.length === 2 && digestA.body.issueCount === 3);
  check('摘要提示明细位置', typeof digestA.body.detailHint === 'string' && digestA.body.files?.issuesJson);

  const payloadB = {
    ...payloadA,
    generatedAt: '2026-01-02T00:00:00.000Z',
    summary: { total: 3 },
    issues: [baseIssue({ id: 1 }), baseIssue({ id: 4, rule: 'CVE-4' }), baseIssue({ id: 5, rule: 'CVE-5' })]
  };
  const digestB = digestScan(dir3, payloadB, { delta: true });
  check('delta 统计新增/消失', digestB.body.delta.added === 2 && digestB.body.delta.removed === 2, JSON.stringify(digestB.body.delta));
  check('delta 带基线时间', digestB.body.delta.baseline === payloadA.generatedAt);

  const { projectStatus } = await import(pathToFileURL(path.join(ROOT, 'out', 'status.js')).href);
  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-status-'));
  fs.writeFileSync(path.join(statusDir, 'pom.xml'), '<project/>');
  const projectStat = projectStatus(statusDir);
  check('status 一屏给出 pom 哈希', typeof projectStat.pom.hash === 'string' && projectStat.pom.hash.startsWith('sha256:'));
  check('status 列出三个工具', projectStat.tools.length === 3);
  check('status 未扫描时 hasResult=false', projectStat.scan.hasResult === false);
  check('status 未扫描时引导先扫描', projectStat.nextStep.includes('扫描'), projectStat.nextStep);
  fs.rmSync(statusDir, { recursive: true, force: true });

  console.log('10) 下一动作状态机 + 交接文件 + 失败翻译');
  const nextDir = prepare();
  const next1 = JSON.parse(run(['next', nextDir, '--json']).out);
  check(
    '未计划时 next 指向 plan',
    next1.state === 'no-plan' && next1.action === 'plan' && next1.command.includes('upgrade plan'),
    JSON.stringify({ state: next1.state, action: next1.action })
  );
  check('next 刷新 handoff.md', fs.existsSync(path.join(nextDir, '.quality-center', 'handoff.md')));
  const handoff = fs.readFileSync(path.join(nextDir, '.quality-center', 'handoff.md'), 'utf8');
  check('handoff 含下一步与硬性规则', handoff.includes('## 下一步') && handoff.includes('一次只推进一组'));

  run(['upgrade', 'plan', nextDir, '--reuse', '--json']);
  const next2 = JSON.parse(run(['next', nextDir, '--json']).out);
  check(
    '计划后 next 只指向 framework 组',
    next2.action === 'apply' &&
      next2.plan?.nextGroup === 'framework' &&
      next2.command.includes('--group framework') &&
      next2.command.includes('--write'),
    JSON.stringify({ action: next2.action, group: next2.plan?.nextGroup })
  );
  check('next 命令带当前 pomHash', next2.command.includes(next2.pom.hash));

  const overrideDir = prepare();
  fs.writeFileSync(
    path.join(overrideDir, 'pom.xml'),
    POM.replace('<java.version>8</java.version>', '<java.version>8</java.version>\n    <okhttp.version>4.1.0</okhttp.version>'),
    'utf8'
  );
  run(['upgrade', 'plan', overrideDir, '--reuse', '--json']);
  const overrideNext = JSON.parse(run(['next', overrideDir, '--json']).out);
  check(
    '框架组落盘前预检属性覆盖',
    overrideNext.warnings?.some((item) => item.code === 'property-override' && item.message.includes('okhttp.version')),
    JSON.stringify(overrideNext.warnings)
  );

  const explainDir = prepare();
  fs.writeFileSync(
    path.join(explainDir, '.quality-center', 'build.log'),
    [
      '[INFO] BUILD FAILURE',
      '[ERROR] Non-resolvable import POM: Could not find artifact com.squareup.okhttp3:okhttp-bom:pom:4.1.0 in central',
      '[ERROR] @ org.springframework.boot:spring-boot-dependencies:2.7.18'
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(explainDir, 'pom.xml'),
    POM.replace('<java.version>8</java.version>', '<java.version>8</java.version>\n    <okhttp.version>4.1.0</okhttp.version>'),
    'utf8'
  );
  const explain = JSON.parse(run(['explain', explainDir, '--json']).out);
  check(
    'explain 识别属性覆盖 BOM',
    explain.kind === 'property-collision' && explain.cause.includes('okhttp.version') && explain.suggestion.includes('family'),
    JSON.stringify({ kind: explain.kind, cause: explain.cause })
  );

  const failureFindDir = prepare();
  fs.writeFileSync(
    path.join(failureFindDir, '.quality-center', 'build.log'),
    [
      '[INFO] BUILD FAILURE',
      '[ERROR] Non-resolvable import POM: Failure to find com.squareup.okhttp3:okhttp-bom:pom:4.1.0 in https://maven.aliyun.com/repository/public/ was cached in the local repository',
      '[ERROR] @ org.springframework.boot:spring-boot-dependencies:2.7.18'
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(failureFindDir, 'pom.xml'),
    POM.replace('<java.version>8</java.version>', '<java.version>8</java.version>\n    <okhttp.version>4.1.0</okhttp.version>'),
    'utf8'
  );
  const failureFind = JSON.parse(run(['explain', failureFindDir, '--json']).out);
  check(
    'explain 识别 Maven Failure to find',
    failureFind.kind === 'property-collision' && failureFind.cause.includes('okhttp.version'),
    JSON.stringify({ kind: failureFind.kind, cause: failureFind.cause })
  );

  const failureDir = prepare();
  const failurePlan = JSON.parse(run(['upgrade', 'plan', failureDir, '--json']).out);
  run([
    'upgrade',
    'apply',
    failureDir,
    '--plan',
    failurePlan.planId,
    '--hash',
    failurePlan.pomHash,
    '--write',
    '--allow-cross-line'
  ]);
  fs.writeFileSync(
    path.join(failureDir, '.quality-center', 'build-result.json'),
    JSON.stringify({
      ok: false,
      code: 1,
      at: new Date().toISOString(),
      seconds: 1,
      pomHash: sha256(fs.readFileSync(path.join(failureDir, 'pom.xml'), 'utf8'))
    }),
    'utf8'
  );
  const nextFail = JSON.parse(run(['next', failureDir, '--json']).out);
  check(
    '构建失败时 next 先给 explain',
    nextFail.state === 'build-failed' && nextFail.action === 'explain',
    JSON.stringify({ state: nextFail.state, action: nextFail.action })
  );

  const verifyDir = prepare();
  const verifyPlan = JSON.parse(run(['upgrade', 'plan', verifyDir, '--json']).out);
  run([
    'upgrade',
    'apply',
    verifyDir,
    '--plan',
    verifyPlan.planId,
    '--hash',
    verifyPlan.pomHash,
    '--write',
    '--allow-cross-line'
  ]);
  fs.writeFileSync(
    path.join(verifyDir, '.quality-center', 'build-result.json'),
    JSON.stringify({
      ok: true,
      code: 0,
      at: new Date().toISOString(),
      seconds: 1,
      pomHash: sha256(fs.readFileSync(path.join(verifyDir, 'pom.xml'), 'utf8'))
    }),
    'utf8'
  );
  const nextVerify = JSON.parse(run(['next', verifyDir, '--json']).out);
  check(
    '构建通过后 next 指向复扫验收',
    nextVerify.state === 'verify' && nextVerify.action === 'rescan',
    JSON.stringify({ state: nextVerify.state, action: nextVerify.action })
  );

  const promptRun = run(['prompt', nextDir, '--drive']);
  const drivePrompt = promptRun.out;
  check('CLI prompt 输出全权推进指令', promptRun.code === 0 && drivePrompt.includes('你已被授权驱动'));
  check('全权推进包含循环与退出条件', drivePrompt.includes('执行循环') && drivePrompt.includes('退出条件'));
  check('全权推进要求逐轮重取状态', drivePrompt.includes('每轮都重新 qc next') && drivePrompt.includes('原样执行 next 返回的 command'));
  check('全权推进禁止手改 pom 与跳测试', drivePrompt.includes('禁止手改') && drivePrompt.includes('跳过测试'));
  check(
    '全权推进启动前先确认 JDK 与门禁',
    drivePrompt.includes('启动前确认') &&
      drivePrompt.includes('JDK') &&
      drivePrompt.includes('buildGate') &&
      drivePrompt.includes('未回答不得执行 apply'),
    drivePrompt.slice(0, 300)
  );
  check(
    '回答冲突时调整策略并重新生成计划',
    drivePrompt.includes('用户回答与当前计划冲突') &&
      drivePrompt.includes('upgrade-policy.json') &&
      drivePrompt.includes('targetJavaVersion') &&
      drivePrompt.includes('qc upgrade plan .') &&
      drivePrompt.includes('不要 `--reuse`'),
    drivePrompt.slice(0, 900)
  );

  console.log('\n11) 源码升 JDK：策略改 targetJavaVersion 后生成新计划');
  const java17Dir = prepare();
  fs.writeFileSync(
    path.join(java17Dir, '.quality-center', 'upgrade-policy.json'),
    JSON.stringify(
      {
        schemaVersion: '1',
        frameworkTargets: { '8': '2.7.18', '17': '3.2.12' },
        targetJavaVersion: '17',
        allowNextFrameworkLine: true,
        forbiddenPackages: [],
        buildGate: 'package',
        mavenArgs: [],
        runTestsOnNextLine: true
      },
      null,
      2
    ),
    'utf8'
  );
  const java17PlanRun = run(['upgrade', 'plan', java17Dir, '--json']);
  const java17Plan = java17PlanRun.code === 0 ? JSON.parse(java17PlanRun.out) : {};
  check('Java 17 计划生成成功', java17PlanRun.code === 0, java17PlanRun.err.trim());
  check('计划目标 Java = 17', java17Plan.project?.javaVersion === '17', String(java17Plan.project?.javaVersion));
  check('计划框架目标 = 3.2.12', java17Plan.project?.frameworkTarget === '3.2.12', String(java17Plan.project?.frameworkTarget));
  check(
    '计划包含 java.version 属性迁移',
    Array.isArray(java17Plan.candidates) &&
      java17Plan.candidates.some(
        (item) => item.packageName === 'java.version' && item.mode === 'project-property' && item.to === '17'
      ),
    JSON.stringify(java17Plan.candidates?.map((item) => item.packageName) ?? [])
  );
  check(
    'java.version 与框架同组落盘',
    java17Plan.groups?.find((group) => group.name === 'framework')?.candidates.includes('java.version') === true,
    JSON.stringify(java17Plan.groups ?? [])
  );
  check(
    '授权的 Boot 3 父 POM 与 Java 版本同组，不再要求跨线确认',
    java17Plan.groups?.find((group) => group.name === 'framework')?.candidates.includes('org.springframework.boot:spring-boot-starter-parent') === true &&
      java17Plan.candidates?.find((item) => item.packageName === 'java.version')?.crossLine === false,
    JSON.stringify(java17Plan.candidates ?? [])
  );
  const java17Diff = fs.readFileSync(path.join(java17Dir, '.quality-center', 'upgrade', java17Plan.planId, 'pom.diff'), 'utf8');
  check('pom.diff 含 8 → 17', java17Diff.includes('-    <java.version>8</java.version>') && java17Diff.includes('+    <java.version>17</java.version>'));

  console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
  if (failures.length) {
    failures.forEach((item) => console.log(`  ✗ ${item}`));
    process.exitCode = 1;
  }
}

const RULE_INSTRUCTION_HEAD = '用户手改';

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});

