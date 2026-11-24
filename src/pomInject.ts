/**
 * 往 pom.xml 里注入插件配置的极简实现。
 *
 * 背景：spotbugs-maven-plugin 的 `plugins` 参数在 plugin.xml 里没有 userProperty，
 * `-Dspotbugs.plugins=...` 传不进去（实测无效），所以 FindSecBugs 只能写进 pom 的
 * `<build><plugins>` 才生效。为了不改用户仓库里的 pom，这里复制一份到同目录临时文件
 * （basedir 不变，target 路径不变），注入后 `mvn -f` 跑，跑完删除。
 *
 * 只做结构定位，不做完整 XML 解析：按标签扫描维护元素路径栈，找到
 * project/build/plugins、project/build、project 的闭合位置。
 */

export interface InjectionResult {
  text: string;
  injected: boolean;
  reason?: string;
}

interface OpenElement {
  name: string;
  path: string;
}

const TAG =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<[^>]+>/g;

const indentOf = (text: string, index: number): string => {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const prefix = text.slice(lineStart, index);
  const match = /^[ \t]*/.exec(prefix);
  return match ? match[0] : '';
};

/** 在 `<build>` 下插入或追加 `<plugins>`；没有 `<build>` 就整块补上 */
export function injectPluginIntoBuild(pomText: string, pluginXml: string): InjectionResult {
  const stack: OpenElement[] = [];
  const closes: Record<string, { index: number; indent: string }> = {};
  TAG.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TAG.exec(pomText)) !== null) {
    const raw = match[0];
    if (raw.startsWith('<!') || raw.startsWith('<?')) {
      continue;
    }
    const nameMatch = /^<\s*(\/?)\s*([\w:.-]+)/.exec(raw);
    if (!nameMatch) {
      continue;
    }
    const closing = nameMatch[1] === '/';
    const name = nameMatch[2];
    const selfClosing = /\/\s*>$/.test(raw);

    if (closing) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name === name) {
          closes[stack[i].path] = { index: match.index, indent: indentOf(pomText, match.index) };
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (selfClosing) {
      continue;
    }
    const parentPath = stack.length > 0 ? stack[stack.length - 1].path : '';
    stack.push({ name, path: parentPath ? `${parentPath}/${name}` : name });
  }

  if (!closes.project) {
    return { text: pomText, injected: false, reason: '看起来不是 pom.xml' };
  }

  const pluginBlock = pluginXml.trim();

  const pluginsClose = closes['project/build/plugins'];
  if (pluginsClose) {
    const indent = `${pluginsClose.indent}  `;
    const block = `${indent}${pluginBlock}\n`;
    return {
      text: `${pomText.slice(0, pluginsClose.index)}${block}${pomText.slice(pluginsClose.index)}`,
      injected: true
    };
  }

  const buildClose = closes['project/build'];
  if (buildClose) {
    const indent = `${buildClose.indent}  `;
    const inner = `${indent}  `;
    const block = `${indent}<plugins>\n${inner}${pluginBlock}\n${indent}</plugins>\n`;
    return {
      text: `${pomText.slice(0, buildClose.index)}${block}${pomText.slice(buildClose.index)}`,
      injected: true
    };
  }

  const projectClose = closes.project;
  const indent = `${projectClose.indent}  `;
  const block =
    `${indent}<build>\n${indent}  <plugins>\n${indent}    ${pluginBlock}\n` +
    `${indent}  </plugins>\n${indent}</build>\n`;
  return {
    text: `${pomText.slice(0, projectClose.index)}${block}${pomText.slice(projectClose.index)}`,
    injected: true
  };
}
