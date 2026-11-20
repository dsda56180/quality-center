import * as fs from 'fs';
import * as path from 'path';

export interface ProjectProfile {
  javaVersion?: number;
  springBootVersion?: string;
}

function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      return match[1].trim();
    }
  }
  return undefined;
}

function normalizeJava(raw?: string): number | undefined {
  if (!raw) {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (value.startsWith('1.')) {
    return Number(value.slice(2)) || undefined;
  }
  const major = Number(value.replace(/[^\d]/g, ''));
  return major || undefined;
}

/** 解析项目根 pom，识别 Java 与 Spring Boot 版本；失败时返回空画像 */
export function detectProjectProfile(root: string): ProjectProfile {
  const pomPath = path.join(root, 'pom.xml');
  let text = '';
  try {
    text = fs.readFileSync(pomPath, 'utf8');
  } catch {
    return {};
  }

  // 先展开简单属性占位符，便于识别 ${java.version} 这类写法
  text = text.replace(/\$\{([^}]+)\}/g, (all, name: string) => {
    const prop = new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(text);
    return prop ? prop[1] : all;
  });

  const javaRaw = firstMatch(text, [
    /<java\.version>\s*([^<]+?)\s*<\/java\.version>/i,
    /<maven\.compiler\.source>\s*([^<]+?)\s*<\/maven\.compiler\.source>/i,
    /<maven\.compiler\.target>\s*([^<]+?)\s*<\/maven\.compiler\.target>/i,
    /<source>\s*([^<]+?)\s*<\/source>/i,
    /<target>\s*([^<]+?)\s*<\/target>/i
  ]);
  const springBootVersion = firstMatch(text, [
    /<artifactId>\s*spring-boot-starter-parent\s*<\/artifactId>\s*<version>\s*([^<]+?)\s*<\/version>/i,
    /<artifactId>\s*spring-boot-dependencies\s*<\/artifactId>\s*<version>\s*([^<]+?)\s*<\/version>/i
  ]);

  return {
    javaVersion: normalizeJava(javaRaw),
    springBootVersion
  };
}

/** 根据项目画像给出配方与升级提示；低风险配方已由插件自动启用 */
export function recipeAdvice(profile: ProjectProfile): string[] {
  const advice: string[] = [];
  if (profile.javaVersion && profile.javaVersion >= 8) {
    advice.push(
      '低风险配方已自动启用（清理无用导入、简化布尔表达式、去除多余括号等），无需手动配置 Maven 坐标，可在面板「设置」中调整'
    );
  }
  const [major, minor] = (profile.springBootVersion ?? '').split('.').map((part) => Number(part));
  if (major === 2 && minor < 7) {
    advice.push(
      `检测到 Spring Boot ${profile.springBootVersion}（已停止维护）：可在「升级依赖」中一次升级到 2.7.18，再执行代码级迁移`
    );
  } else if (major === 3) {
    advice.push('Spring Boot 3.x：可在设置里手动启用代码迁移配方（高风险，默认不勾选）');
  }
  return advice;
}
