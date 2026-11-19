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

/** SpotBugs 缺陷类别中文名 */
export const SPOTBUGS_CATEGORY_LABEL: Record<string, string> = {
  SECURITY: '安全漏洞',
  CORRECTNESS: '逻辑正确性',
  MALICIOUS_CODE: '可变对象暴露',
  BAD_PRACTICE: '不良实践',
  PERFORMANCE: '性能问题',
  STYLE: '可疑代码',
  I18N: '国际化'
};

/**
 * SpotBugs / FindSecBugs 常见缺陷类型的中文说明与修复建议。
 * 未收录的类型回退到类别说明 + 原始英文短描述，避免丢失信息。
 */
const SPOTBUGS_ZH: Record<string, RuleText> = {
  EI_EXPOSE_REP: {
    name: '返回可变内部对象引用',
    explain: 'getter 直接返回了内部可变对象（如 List、Date、数组），外部修改会绕过封装破坏对象状态。',
    advice: '返回防御性拷贝（new ArrayList<>(list)、date.clone()）或不可变视图（Collections.unmodifiableList）。'
  },
  EI_EXPOSE_REP2: {
    name: '保存了外部可变对象引用',
    explain: '构造器或 setter 直接保存了外部传入的可变对象，调用方后续修改会影响本对象内部状态。',
    advice: '保存前做防御性拷贝，或改用不可变类型（List.copyOf / ImmutableList）。'
  },
  SE_NO_SERIALVERSIONID: {
    name: '缺少 serialVersionUID',
    explain: '类实现了 Serializable 但没有显式声明 serialVersionUID，类结构微调就会导致反序列化失败。',
    advice: '显式声明 private static final long serialVersionUID = 1L;（或按实际版本号维护）。'
  },
  REC_CATCH_EXCEPTION: {
    name: '捕获过于宽泛的异常',
    explain: '捕获了 Exception，会把编程错误（空指针、类型转换）也一并吞掉，问题被隐藏。',
    advice: '只捕获确实会抛出的具体异常，其余异常向上抛出。'
  },
  DE_MIGHT_IGNORE: {
    name: '异常被静默忽略',
    explain: 'catch 块中没有做任何处理，异常被吞掉，出错时无从排查。',
    advice: '至少记录日志，或转换为业务异常抛出，不要留空 catch。'
  },
  NP_NULL_ON_SOME_PATH_FROM_RETURN_VALUE: {
    name: '返回值可能为空',
    explain: '调用了可能返回 null 的方法，随后直接解引用，存在空指针风险。',
    advice: '使用前判空、用 Optional 包裹返回值，或在方法签名上明确 @NonNull/@Nullable。'
  },
  NP_NULL_ON_SOME_PATH_EXCEPTION: {
    name: '异常路径空指针',
    explain: '在异常处理路径上存在空指针解引用，异常发生时可能引发二次异常。',
    advice: '异常分支中同样要做空值判断，并避免在 finally 中访问可能未初始化的对象。'
  },
  HRS_REQUEST_PARAMETER_TO_HTTP_HEADER: {
    name: 'HTTP 响应头注入',
    explain: '把请求参数直接写入 HTTP 响应头，攻击者可注入 CRLF 实施响应拆分、会话固定或缓存投毒。',
    advice: '对写入响应头的值做白名单校验并剔除 \\r\\n，必要时改用 URL 重定向并做目标校验。'
  },
  RCN_REDUNDANT_NULLCHECK_OF_NONNULL_VALUE: {
    name: '冗余空值判断',
    explain: '对已知非空的值做了判空，说明代码对方法契约理解有误，容易掩盖真实缺陷。',
    advice: '删除冗余判空，或在方法上补全 @Nullable 注解让检查保持有效。'
  },
  NM_CONFUSING: {
    name: '方法名易混淆',
    explain: '存在仅大小写或极相似的方法名，容易误调用，阅读时难以区分。',
    advice: '重命名其中一个方法，使名称语义可区分。'
  },
  DM_CONVERT_CASE: {
    name: '大小写转换未指定 Locale',
    explain: '未指定 Locale 的大小写转换在土耳其语等环境会产生错误结果（i/I 转换异常）。',
    advice: '使用 toUpperCase(Locale.ROOT) / toLowerCase(Locale.ROOT)。'
  },
  UWF_FIELD_NOT_INITIALIZED_IN_CONSTRUCTOR: {
    name: '字段可能未初始化',
    explain: '字段没有在构造器中初始化，却被直接解引用，运行期可能空指针。',
    advice: '在构造器或声明处初始化该字段，使用前补空值判断。'
  },
  URF_UNREAD_FIELD: {
    name: '字段从未被读取',
    explain: '字段只写不读，通常是被废弃的残留代码，也可能是漏写了使用逻辑。',
    advice: '确认无用后删除；若原本打算使用，补全相关逻辑。'
  },
  DP_DO_INSIDE_DO_PRIVILEGED: {
    name: '特权操作缺少 doPrivileged',
    explain: '在启用 SecurityManager 的环境下，敏感操作应在 AccessController.doPrivileged 中执行。',
    advice: '用 AccessController.doPrivileged 包裹敏感操作；JDK 17+ 已弃用 SecurityManager，可评估直接移除相关依赖。'
  },
  OS_OPEN_STREAM_EXCEPTION_PATH: {
    name: '异常路径未关闭流',
    explain: '方法在异常路径上可能没有关闭打开的流，长期运行会耗尽文件句柄。',
    advice: '改用 try-with-resources 管理所有 Closeable 资源。'
  },
  RV_RETURN_VALUE_IGNORED_BAD_PRACTICE: {
    name: '忽略了有意义的返回值',
    explain: '方法返回值表示操作结果（如 File.delete、File.mkdir），忽略后无法感知失败。',
    advice: '检查并处理返回值，失败时记录日志或抛出异常。'
  },
  UPM_UNCALLED_PRIVATE_METHOD: {
    name: '私有方法未被调用',
    explain: '私有方法没有任何调用点，属于死代码，可能是重构遗留。',
    advice: '确认后删除；若为预留能力，应补充调用方或改为可见性更明确的 API。'
  },
  SIO_SUPERFLUOUS_INSTANCEOF: {
    name: '多余的 instanceof',
    explain: '对已确定类型的对象再做 instanceof，判断永远为真，属于无效代码。',
    advice: '删除该判断，直接使用对象。'
  },
  WMI_WRONG_MAP_ITERATOR: {
    name: 'Map 迭代方式低效',
    explain: '用 keySet 遍历后再 get(key)，每次都要再次查找，大 Map 下性能损耗明显。',
    advice: '改用 entrySet() 遍历，或 Java 8 的 forEach。'
  },
  UC_USELESS_OBJECT: {
    name: '创建了未使用的对象',
    explain: '对象创建后未被使用，属于无效开销，也可能是漏调用。',
    advice: '删除无用的对象创建；若本就该使用，补全调用逻辑。'
  },
  DLS_DEAD_LOCAL_STORE: {
    name: '局部变量赋值后未使用',
    explain: '局部变量赋值后没有被读取，后面的赋值覆盖了它，属于死存储。',
    advice: '删除无用赋值，保留真正生效的赋值。'
  },
  ICAST_INTEGER_MULTIPLY_CAST_TO_LONG: {
    name: '乘法溢出后才转 long',
    explain: '先做 int 乘法再转 long，乘法阶段就可能溢出，结果错误。',
    advice: '在乘法前就把操作数转为 long，例如 (long) a * b。'
  },
  ST_WRITE_TO_STATIC_FROM_INSTANCE_METHOD: {
    name: '实例方法写静态字段',
    explain: '实例方法修改静态字段，多实例场景下会产生共享状态竞争，行为难以推理。',
    advice: '改为静态方法或通过依赖注入管理状态，避免实例方法写静态可变字段。'
  },
  SIC_INNER_SHOULD_BE_STATIC_ANON: {
    name: '匿名内部类可改为静态',
    explain: '匿名内部类没有引用外部实例，可以改为静态内部类，避免隐式持有外部引用。',
    advice: '提取为 private static 的具名内部类。'
  },
  SQL_INJECTION: {
    name: 'SQL 注入',
    explain: 'SQL 语句通过字符串拼接引入外部输入，攻击者可篡改查询逻辑。',
    advice: '改用 PreparedStatement 参数化查询，禁止拼接用户输入。'
  },
  COMMAND_INJECTION: {
    name: '命令注入',
    explain: '外部输入被拼接进系统命令，攻击者可执行任意命令。',
    advice: '避免调用 shell，改用参数数组并做白名单校验，禁止拼接用户输入。'
  },
  PATH_TRAVERSAL_IN: {
    name: '路径穿越',
    explain: '外部输入直接参与文件路径拼接，攻击者可用 ../ 读取任意文件。',
    advice: '对路径做规范化（getCanonicalPath）并校验必须位于允许的基目录之内。'
  },
  XSS_SERVLET: {
    name: '跨站脚本（XSS）',
    explain: '未编码的用户输入被写回页面，攻击者可注入脚本窃取会话。',
    advice: '输出前做 HTML 编码，或使用框架自带的转义机制，避免直接拼接 HTML。'
  },
  XXE_XMLSTREAMREADER: {
    name: 'XML 外部实体注入（XXE）',
    explain: '解析 XML 时未禁用外部实体，攻击者可读取本地文件或发起内网请求。',
    advice: '禁用 DTD 与外部实体（setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)）。'
  },
  HARD_CODE_PASSWORD: {
    name: '硬编码密码',
    explain: '代码中直接写入了密码，源码泄露即凭证泄露。',
    advice: '迁移到环境变量或配置中心，并立即轮换已暴露的密码。'
  },
  CRLF_INJECTION_LOGS: {
    name: '日志注入',
    explain: '未过滤的外部输入写入日志，攻击者可伪造日志行，干扰审计。',
    advice: '记录前剔除 \\r\\n 等换行字符。'
  }
};

/** SpotBugs 英文短描述不足时，按类别给出兜底中文解释 */
const SPOTBUGS_CATEGORY_ADVICE: Record<string, string> = {
  SECURITY:
    '该问题由 FindSecBugs 在字节码层识别为安全风险，请确认外部输入是否可控；' +
    '若可控，优先按建议做输入校验与编码处理，不确定时把该条详情复制给 AI 评估。',
  CORRECTNESS: '该问题可能导致运行时错误或结果不正确，建议结合上下文确认条件分支与空值处理。',
  MALICIOUS_CODE: '该问题会暴露可变内部状态，建议做防御性拷贝或改用不可变集合。',
  BAD_PRACTICE: '该写法在特定场景下会引发问题（资源未释放、异常被吞、序列化不兼容等），建议按提示修正。',
  PERFORMANCE: '该写法存在不必要的开销，代码量不大时建议顺手优化。',
  STYLE: '该写法可读性差或属于死代码，建议清理。',
  I18N: '该写法在非英文语言环境下可能得到错误结果，建议显式指定 Locale。'
};

/** 为 SpotBugs 问题补充中文字段 */
export function localizeSpotbugs(issue: Issue): Issue {
  const text = SPOTBUGS_ZH[issue.rule];
  const categoryZh = SPOTBUGS_CATEGORY_LABEL[issue.category || ''] || '静态缺陷';
  const name = text?.name || issue.rule;
  return {
    ...issue,
    title: name,
    zhSummary: text ? `${name}：${text.explain}` : `${categoryZh}：${issue.message}`,
    advice:
      text?.advice ||
      SPOTBUGS_CATEGORY_ADVICE[issue.category || ''] ||
      '建议结合代码上下文确认后修正；无把握时把该条问题复制给 AI 评估。'
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
