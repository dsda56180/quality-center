export type RecipeRisk = 'low' | 'medium' | 'high';

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
}

/**
 * 插件内置配方库。
 * 用户不再需要自己查 Maven 坐标：所有配方及其依赖包都由插件提供，
 * 设置面板里只按风险分组勾选是否启用。
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
    id: 'org.openrewrite.staticanalysis.SimplifyBooleanExpression',
    label: '简化布尔表达式',
    risk: 'low',
    description: '合并冗余的布尔判断，等价改写',
    artifact: 'org.openrewrite.recipe:rewrite-static-analysis:2.10.0'
  },
  {
    id: 'org.openrewrite.staticanalysis.UnnecessaryParentheses',
    label: '去除多余括号',
    risk: 'low',
    description: '删除不影响优先级的括号，等价改写',
    artifact: 'org.openrewrite.recipe:rewrite-static-analysis:2.10.0'
  },
  {
    id: 'org.openrewrite.java.spring.boot2.UpgradeSpringBoot_2_7',
    label: 'Spring Boot 2.7 代码迁移',
    risk: 'high',
    description: '升级到 Spring Boot 2.7 所需的配置与 API 适配，会产生业务代码改动',
    artifact: 'org.openrewrite.recipe:rewrite-spring:6.0.2',
    pluginVersion: '6.0.5'
  }
];

/** 自动启用的低风险配方（打开「自动启用低风险配方」后生效） */
export const AUTO_RECIPES = RECIPE_LIBRARY.filter((recipe) => recipe.risk === 'low').map(
  (recipe) => recipe.id
);

export const RISK_LABEL: Record<RecipeRisk, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险'
};

export function recipeDefinition(id: string): RecipeDefinition | undefined {
  return RECIPE_LIBRARY.find((recipe) => recipe.id === id);
}

export function recipeLabel(id: string): string {
  return recipeDefinition(id)?.label ?? id;
}

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
