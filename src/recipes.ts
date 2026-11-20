import { ProjectProfile } from './projectProfile';

export type RecipeRisk = 'low' | 'medium' | 'high';

/**
 * 配方的适用条件，全部为普通数据，便于随快照下发给 Webview 做项目级过滤。
 * 未声明的条件视为不限制；声明了条件但项目画像缺失时按「不适用」处理。
 */
export interface RecipeCondition {
  /** 仅当 Java 版本 >= 该值 */
  javaMin?: number;
  /** 仅当 Java 版本 <= 该值 */
  javaMax?: number;
  /** 仅当 Spring Boot 为该主版本 */
  springBootMajor?: number;
  /** 仅当 Spring Boot 版本低于该值（如 2.7） */
  springBootBelow?: string;
  /** 仅当项目直接使用 JUnit 4 */
  junit4?: boolean;
}

export interface RecipeDefinition {
  /** OpenRewrite 配方全名 */
  id: string;
  label: string;
  risk: RecipeRisk;
  description: string;
  /** 配方所在包；插件会在运行时通过 -Drewrite.recipeArtifactCoordinates 临时引入 */
  artifact?: string;
  /** 该配方要求的最低 rewrite-maven-plugin 版本 */
  pluginVersion?: string;
  /** 项目满足条件时才在设置里展示 */
  appliesTo?: RecipeCondition;
}

const STATIC_ANALYSIS = 'org.openrewrite.recipe:rewrite-static-analysis:2.1.0';
const REWRITE_SPRING = 'org.openrewrite.recipe:rewrite-spring:6.0.2';
const MIGRATE_JAVA = 'org.openrewrite.recipe:rewrite-migrate-java:3.1.0';
const TESTING_FRAMEWORKS = 'org.openrewrite.recipe:rewrite-testing-frameworks:3.1.0';
/** 以上配方包都基于 rewrite 8.44.1，对应插件 6.0.5，混用不会出现类路径冲突 */
const PLUGIN_FOR_LIBRARY = '6.0.5';

/**
 * 插件内置配方库。
 * 配方会按项目画像过滤：例如 Spring Boot 迁移只在检测到对应版本时出现，
 * Java 升级只在当前 Java 版本低于目标时出现，JUnit 迁移只在用 JUnit 4 时出现。
 */
export const RECIPE_LIBRARY: RecipeDefinition[] = [
  {
    id: 'org.openrewrite.java.RemoveUnusedImports',
    label: '清理无用导入',
    risk: 'low',
    description: '删除未被引用的 import，不改变运行行为'
  },
  {
    id: 'org.openrewrite.java.RemoveObjectsIsNull',
    label: 'Objects.isNull 改为 == null',
    risk: 'low',
    description: '等价改写，便于阅读，不改变语义'
  },
  {
    id: 'org.openrewrite.java.ShortenFullyQualifiedTypeReferences',
    label: '缩短全限定类名',
    risk: 'low',
    description: '把已 import 的全限定类名替换为简单类名'
  },
  {
    id: 'org.openrewrite.java.OrderImports',
    label: '整理 import 顺序',
    risk: 'low',
    description: '按统一顺序排列 import，纯格式改动'
  },
  {
    id: 'org.openrewrite.staticanalysis.SimplifyBooleanExpression',
    label: '简化布尔表达式',
    risk: 'low',
    description: '合并冗余的布尔判断，等价改写',
    artifact: STATIC_ANALYSIS,
    pluginVersion: PLUGIN_FOR_LIBRARY
  },
  {
    id: 'org.openrewrite.staticanalysis.UnnecessaryParentheses',
    label: '去除多余括号',
    risk: 'low',
    description: '删除不影响优先级的括号，等价改写',
    artifact: STATIC_ANALYSIS,
    pluginVersion: PLUGIN_FOR_LIBRARY
  },
  {
    id: 'org.openrewrite.staticanalysis.RemoveExtraSemicolons',
    label: '去除多余分号',
    risk: 'low',
    description: '删除空语句分号，等价改写',
    artifact: STATIC_ANALYSIS,
    pluginVersion: PLUGIN_FOR_LIBRARY
  },
  {
    id: 'org.openrewrite.staticanalysis.UseDiamondOperator',
    label: '使用菱形泛型',
    risk: 'low',
    description: '把重复的泛型参数简化为 <>，等价改写',
    artifact: STATIC_ANALYSIS,
    pluginVersion: PLUGIN_FOR_LIBRARY
  },
  {
    id: 'org.openrewrite.java.format.AutoFormat',
    label: '统一代码格式',
    risk: 'medium',
    description: '按项目或默认风格重排缩进、空格与换行，只改格式'
  },
  {
    id: 'org.openrewrite.staticanalysis.EqualsAvoidsNull',
    label: 'equals 常量左置',
    risk: 'medium',
    description: '把字面量放到 equals 左侧，避免潜在空指针',
    artifact: STATIC_ANALYSIS,
    pluginVersion: PLUGIN_FOR_LIBRARY
  },
  {
    id: 'org.openrewrite.staticanalysis.SimplifyBooleanReturn',
    label: '简化布尔返回',
    risk: 'medium',
    description: '把 if-return true/false 改写为直接返回条件',
    artifact: STATIC_ANALYSIS,
    pluginVersion: PLUGIN_FOR_LIBRARY
  },
  {
    id: 'org.openrewrite.staticanalysis.ReplaceLambdaWithMethodReference',
    label: 'Lambda 改为方法引用',
    risk: 'medium',
    description: '把可直接引用的 Lambda 改写为方法引用',
    artifact: STATIC_ANALYSIS,
    pluginVersion: PLUGIN_FOR_LIBRARY
  },
  {
    id: 'org.openrewrite.staticanalysis.UseStandardCharset',
    label: '使用 StandardCharsets',
    risk: 'medium',
    description: '用 StandardCharsets 常量替换按名称获取字符集',
    artifact: STATIC_ANALYSIS,
    pluginVersion: PLUGIN_FOR_LIBRARY
  },
  {
    id: 'org.openrewrite.staticanalysis.SimplifyConstantIfBranchExecution',
    label: '简化常量条件分支',
    risk: 'medium',
    description: '折叠条件恒定的 if 分支，减少无效代码',
    artifact: STATIC_ANALYSIS,
    pluginVersion: PLUGIN_FOR_LIBRARY
  },
  {
    id: 'org.openrewrite.java.spring.boot2.UpgradeSpringBoot_2_7',
    label: 'Spring Boot 2.7 代码迁移',
    risk: 'high',
    description: '升级到 Spring Boot 2.7 所需的配置与 API 适配，会产生业务代码改动',
    artifact: REWRITE_SPRING,
    pluginVersion: PLUGIN_FOR_LIBRARY,
    appliesTo: { springBootMajor: 2, springBootBelow: '2.7' }
  },
  {
    id: 'org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_0',
    label: 'Spring Boot 3.0 代码迁移',
    risk: 'high',
    description: '升级到 Spring Boot 3.x：javax→jakarta、配置项与 API 适配，需 Java 17',
    artifact: REWRITE_SPRING,
    pluginVersion: PLUGIN_FOR_LIBRARY,
    appliesTo: { springBootMajor: 2, javaMin: 17 }
  },
  {
    id: 'org.openrewrite.java.migrate.Java8toJava11',
    label: 'Java 8 → 11 迁移',
    risk: 'high',
    description: '升级编译目标与移除的 JDK API，同时更新构建配置',
    artifact: MIGRATE_JAVA,
    pluginVersion: PLUGIN_FOR_LIBRARY,
    appliesTo: { javaMax: 8 }
  },
  {
    id: 'org.openrewrite.java.migrate.UpgradeToJava17',
    label: '升级代码到 Java 17',
    risk: 'high',
    description: '升级编译目标并适配 Java 17 的 API 与语言变化',
    artifact: MIGRATE_JAVA,
    pluginVersion: PLUGIN_FOR_LIBRARY,
    appliesTo: { javaMin: 11, javaMax: 16 }
  },
  {
    id: 'org.openrewrite.java.testing.junit5.JUnit4to5Migration',
    label: 'JUnit 4 → JUnit 5 迁移',
    risk: 'high',
    description: '重写注解、断言与测试运行器，改为 JUnit 5',
    artifact: TESTING_FRAMEWORKS,
    pluginVersion: PLUGIN_FOR_LIBRARY,
    appliesTo: { junit4: true }
  }
];

export const RISK_LABEL: Record<RecipeRisk, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险'
};

function compareVersion(a: string, b: string): number {
  const pa = a.split(/[.\-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(/[.\-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** 判断配方是否适用于当前项目；画像缺失时，带条件的配方不展示 */
export function recipeApplies(recipe: RecipeDefinition, profile: ProjectProfile): boolean {
  const condition = recipe.appliesTo;
  if (!condition) {
    return true;
  }
  const java = profile.javaVersion;
  if (condition.javaMin !== undefined && (!java || java < condition.javaMin)) {
    return false;
  }
  if (condition.javaMax !== undefined && (!java || java > condition.javaMax)) {
    return false;
  }
  const boot = profile.springBootVersion;
  if (condition.springBootMajor !== undefined) {
    if (!boot || Number(boot.split('.')[0]) !== condition.springBootMajor) {
      return false;
    }
  }
  if (condition.springBootBelow !== undefined) {
    if (!boot || compareVersion(boot, condition.springBootBelow) >= 0) {
      return false;
    }
  }
  if (condition.junit4 && profile.junit !== 'junit4') {
    return false;
  }
  return true;
}

/** 当前项目可用的配方 */
export function applicableRecipes(profile: ProjectProfile): RecipeDefinition[] {
  return RECIPE_LIBRARY.filter((recipe) => recipeApplies(recipe, profile));
}

/** 自动启用的低风险配方（按项目过滤后） */
export function autoRecipeIds(profile: ProjectProfile): string[] {
  return applicableRecipes(profile)
    .filter((recipe) => recipe.risk === 'low')
    .map((recipe) => recipe.id);
}

export function recipeDefinition(id: string): RecipeDefinition | undefined {
  return RECIPE_LIBRARY.find((recipe) => recipe.id === id);
}

export function recipeLabel(id: string): string {
  return recipeDefinition(id)?.label ?? id;
}

/** 选中的配方里要求最高的 rewrite-maven-plugin 版本，保证配方可加载 */
export function requiredPluginVersion(recipeIds: string[]): string | undefined {
  let required: string | undefined;
  for (const id of recipeIds) {
    const version = recipeDefinition(id)?.pluginVersion;
    if (!version) {
      continue;
    }
    if (!required || compareVersion(version, required) > 0) {
      required = version;
    }
  }
  return required;
}

/** 选中配方所需的额外配方包坐标（去重，按配方库顺序） */
export function artifactsForRecipes(recipeIds: string[]): string[] {
  const artifacts: string[] = [];
  for (const id of recipeIds) {
    const artifact = recipeDefinition(id)?.artifact;
    if (artifact && !artifacts.includes(artifact)) {
      artifacts.push(artifact);
    }
  }
  return artifacts;
}
