const IDENT = '[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*';

/**
 * 把布尔字面量比较改写为等价表达式：
 *   false == x / x == false / true != x / x != true  →  !x
 *   true  == x / x == true  / false != x / x != false →  x
 * 只处理单行内、不含字符串与注释的语句，其余交给人工或 AI。
 */
export function simplifyBooleanLine(line: string): string | undefined {
  if (/["'`]/.test(line) || line.includes('//') || line.includes('/*')) {
    return undefined;
  }

  let out = line;
  // 字面量在左
  out = out.replace(
    new RegExp(`\\bfalse\\s*==\\s*(!?)(${IDENT})`, 'g'),
    (_m, neg: string, ident: string) => (neg ? ident : `!${ident}`)
  );
  out = out.replace(
    new RegExp(`\\btrue\\s*==\\s*(!?)(${IDENT})`, 'g'),
    (_m, neg: string, ident: string) => (neg ? `!${ident}` : ident)
  );
  out = out.replace(
    new RegExp(`\\bfalse\\s*!=\\s*(!?)(${IDENT})`, 'g'),
    (_m, neg: string, ident: string) => (neg ? `!${ident}` : ident)
  );
  out = out.replace(
    new RegExp(`\\btrue\\s*!=\\s*(!?)(${IDENT})`, 'g'),
    (_m, neg: string, ident: string) => (neg ? ident : `!${ident}`)
  );
  // 字面量在右
  out = out.replace(
    new RegExp(`(${IDENT})\\s*==\\s*false\\b`, 'g'),
    (_m, ident: string) => `!${ident}`
  );
  out = out.replace(
    new RegExp(`(${IDENT})\\s*==\\s*true\\b`, 'g'),
    (_m, ident: string) => ident
  );
  out = out.replace(
    new RegExp(`(${IDENT})\\s*!=\\s*false\\b`, 'g'),
    (_m, ident: string) => ident
  );
  out = out.replace(
    new RegExp(`(${IDENT})\\s*!=\\s*true\\b`, 'g'),
    (_m, ident: string) => `!${ident}`
  );
  // 双否定合并：!!flag → flag
  out = out.replace(/!!(?=[A-Za-z_$(])/g, '');

  return out === line ? undefined : out;
}
