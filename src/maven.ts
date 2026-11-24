import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Maven Central 在国内网络下经常很慢或不可达。
 * 用户没有自己的 ~/.m2/settings.xml 时，生成一份仅包含阿里云公共仓库镜像的
 * settings.xml，并通过 `-s` 传给 mvn；用户已有 settings.xml（企业私服、代理等）时不干预。
 *
 * 这里不直接 import vscode：CLI / agent 场景在纯 Node 进程里跑，
 * 只有真在编辑器里时才去读用户设置。
 */
let storageDir: string | undefined;

const SETTINGS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.0.0 https://maven.apache.org/xsd/settings-1.0.0.xsd">
  <mirrors>
    <mirror>
      <id>aliyun-public</id>
      <name>Aliyun Maven Public</name>
      <url>https://maven.aliyun.com/repository/public</url>
      <mirrorOf>central</mirrorOf>
    </mirror>
  </mirrors>
</settings>
`;

export function initMaven(extensionStorage?: string): void {
  storageDir = extensionStorage;
}

function userSettingsPath(): string {
  return path.join(os.homedir(), '.m2', 'settings.xml');
}

/** 读取「是否使用国内镜像」：编辑器内用用户设置，纯 Node 环境默认开启 */
function mirrorEnabled(): boolean {
  try {
    // 运行在扩展宿主里时该模块存在；CLI / CI 里会抛 MODULE_NOT_FOUND，按默认值处理
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode') as {
      workspace: { getConfiguration(section: string): { get<T>(key: string, def: T): T } };
    };
    return vscode.workspace.getConfiguration('qualityCenter').get<boolean>('maven.useChinaMirror', true);
  } catch {
    return true;
  }
}

/**
 * 返回需要追加到 mvn 命令行的参数。
 * 已有用户级 settings.xml 或关闭镜像开关时返回空数组。
 */
export function mavenMirrorArgs(enabled?: boolean): string[] {
  if (!(enabled ?? mirrorEnabled())) {
    return [];
  }
  // 用户已有自己的 Maven 配置时不动它，避免覆盖私服、代理或本地仓库设置
  if (fs.existsSync(userSettingsPath())) {
    return [];
  }

  const dir = storageDir ?? path.join(os.tmpdir(), 'quality-center');
  const file = path.join(dir, 'maven-settings.xml');
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, SETTINGS_XML, 'utf8');
    }
    return ['-s', file];
  } catch {
    return [];
  }
}
