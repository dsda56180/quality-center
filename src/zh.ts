import { Issue } from './model';

export interface RuleText {
  name: string;
  explain: string;
  advice: string;
}

/** Checkstyle 常见规则的中文说明与修复建议 */
const CHECKSTYLE_ZH: Record<string, RuleText> = {
  UnusedImports: {
    name: '无用导入',
    explain: '导入了从未使用的类，增加编译负担并干扰阅读。',
    advice: '删除该 import 语句。可使用面板的「一键修复」自动处理。'
  },
  RedundantImport: {
    name: '重复导入',
    explain: '同一类被重复导入，或导入了 java.lang 等默认包。',
    advice: '删除多余 import。可用「一键修复」自动处理。'
  },
  ModifierOrder: {
    name: '修饰符顺序不规范',
    explain: '修饰符顺序不符合 Java 规范推荐顺序（可见性 → static → final → 其它）。',
    advice: '按规范重排，例如 static public final 改为 public static final。可用「一键修复」自动处理。'
  },
  SimplifyBooleanExpression: {
    name: '布尔表达式可简化',
    explain: '存在 x == true、!false 这类冗余布尔判断，逻辑绕且易读错。',
    advice: '直接使用布尔变量或用 ! 取反，例如 if (flag)。面板的「一键修复」可自动改写这类字面量比较。'
  },
  EmptyStatement: {
    name: '空语句',
    explain: '存在多余的分号，通常是逻辑遗漏或误输入。',
    advice: '删除多余分号；若是条件分支误写，需要补充真正的分支逻辑。'
  },
  DefaultComesLast: {
    name: 'default 分支位置不当',
    explain: 'switch 的 default 分支不在最后，影响可读性，也容易漏改。',
    advice: '把 default 分支移到 switch 末尾。'
  },
  StringLiteralEquality: {
    name: '字符串用 == 比较',
    explain: '使用 == 比较字符串实际上比较的是对象引用，而不是内容，容易得到错误结果。',
    advice: '改用 equals()，例如 "x".equals(value)，并注意调用方的空值处理。'
  },
  OneTopLevelClass: {
    name: '单文件多个顶层类',
    explain: '一个文件定义了多个顶层类，职责不清晰，不利于维护。',
    advice: '拆分到独立文件，保持一个文件一个顶层类。'
  },
  EqualsHashCode: {
    name: 'equals 与 hashCode 不匹配',
    explain: '重写了 equals 却没有重写 hashCode，对象放进 HashMap/HashSet 会出现异常行为。',
    advice: '同时重写 hashCode，保证 equals 相等的对象哈希值一致。'
  },
  IllegalImport: {
    name: '禁止的导入',
    explain: '导入了不推荐使用的包（例如 sun.* 内部 API），跨 JDK 版本不稳定。',
    advice: '替换为标准 API 或公开的第三方库。'
  }
};

/** Gitleaks 常见规则的中文说明 */
const GITLEAKS_ZH: Record<string, RuleText> = {
  'generic-api-key': {
    name: '疑似 API 密钥',
    explain: '代码中出现形似 API Key 的字符串，可能被第三方服务直接使用。',
    advice: '立即轮换该密钥，迁移到环境变量或配置中心，代码中只保留占位符；已提交到版本库的密钥应视为已泄露。'
  },
  'private-key': {
    name: '私钥文件内容',
    explain: '检测到私钥内容被直接写入代码或配置，泄露后攻击者可冒充服务身份。',
    advice: '立即作废并重新生成密钥对，私钥改由密钥管理服务或运行环境注入。'
  },
  'aws-access-token': {
    name: 'AWS 访问凭证',
    explain: '检测到 AWS Access Key，泄露后可能被用于操作云上资源并产生费用。',
    advice: '到 IAM 控制台禁用并轮换该凭证，改用实例角色或临时凭证，并检查是否已有异常调用记录。'
  },
  'github-pat': {
    name: 'GitHub 个人访问令牌',
    explain: '检测到 GitHub PAT，泄露后可读写仓库内容。',
    advice: '立即在 GitHub 设置中撤销该 Token，改用细粒度权限的 Token 或 GitHub App。'
  },
  'gitlab-pat': {
    name: 'GitLab 个人访问令牌',
    explain: '检测到 GitLab PAT，泄露后可访问私有仓库与 API。',
    advice: '立即在 GitLab 中吊销该 Token，并检查近期操作日志。'
  },
  'slack-access-token': {
    name: 'Slack 访问令牌',
    explain: '检测到 Slack Token，泄露后可读取消息或冒充机器人发言。',
    advice: '在 Slack 后台撤销该 Token 并重新签发。'
  },
  jwt: {
    name: 'JSON Web Token',
    explain: '代码中硬编码了 JWT，可能携带长期有效的身份凭证。',
    advice: '确认该 Token 的签发与过期策略，迁移到运行时注入，并缩短有效期。'
  },
  password: {
    name: '硬编码密码',
    explain: '代码中直接写入了密码，任何能读代码的人都能获取。',
    advice: '立即修改该密码，改为从环境变量或配置中心读取。'
  }
};

function fallbackGitleaks(rule: string): RuleText {
  const text = rule.toLowerCase();
  if (text.includes('key') || text.includes('token') || text.includes('secret')) {
    return {
      name: '疑似凭证泄露',
      explain: '代码中出现疑似密钥或令牌的字符串，可能被用于访问外部服务。',
      advice: '确认该值是否为真实凭证；如是，请立即轮换并迁移到环境变量或配置中心。'
    };
  }
  return {
    name: '疑似敏感信息',
    explain: '代码中出现可能不该提交到版本库的敏感内容。',
    advice: '确认内容性质，必要时移除并轮换相关凭证。'
  };
}

/** Checkstyle 的英文消息做常见模式的中文替换，无法识别时回退到规则说明 */
function translateCheckstyleMessage(rule: string, message: string): string {
  const patterns: [RegExp, (match: RegExpExecArray) => string][] = [
    [/^Unused import - (.+)$/i, (m) => `未使用的导入：${m[1]}`],
    [/^Redundant import from the same package - (.+)$/i, (m) => `同包内的冗余导入：${m[1]}`],
    [/^Duplicate import - (.+)$/i, (m) => `重复导入：${m[1]}`],
    [/^Unused import(?:s)? - (.+)$/i, (m) => `未使用的导入：${m[1]}`],
    [/^'(.+)' should be declared prior to the '(.+)' modifier\.?$/i, (m) => `修饰符顺序不当：${m[1]} 应位于 ${m[2]} 之前`],
    [/^Empty statement\.?$/i, () => '存在多余的空语句（分号）'],
    [/^default should be last\.?$/i, () => 'default 分支应放在最后']
  ];
  for (const [pattern, format] of patterns) {
    const match = pattern.exec(message);
    if (match) {
      return format(match);
    }
  }
  return CHECKSTYLE_ZH[rule]?.explain || message;
}

/** 为 Checkstyle 问题补充中文字段 */
export function localizeCheckstyle(issue: Issue): Issue {
  const text = CHECKSTYLE_ZH[issue.rule];
  const detail = translateCheckstyleMessage(issue.rule, issue.message);
  return {
    ...issue,
    title: text?.name || issue.rule,
    zhSummary: `${text?.name || issue.rule}：${detail}`,
    advice: text?.advice || '建议根据规则说明调整代码；无把握时可将该问题复制给 AI 处理。'
  };
}

/** 为 Gitleaks 问题补充中文字段 */
export function localizeGitleaks(issue: Issue): Issue {
  const text = GITLEAKS_ZH[issue.rule] || fallbackGitleaks(issue.rule);
  return {
    ...issue,
    title: text.name,
    zhSummary: `${text.name}：${text.explain}`,
    advice: text.advice
  };
}
