export const MODIFIER_ORDER = [
  'public',
  'protected',
  'private',
  'abstract',
  'static',
  'final',
  'transient',
  'volatile',
  'synchronized',
  'native',
  'strictfp',
  'default'
];

const MODIFIER_LINE = new RegExp(
  '^(\\s*)((?:(?:' + MODIFIER_ORDER.join('|') + ')\\b\\s*)+)([\\s\\S]*)$'
);

/**
 * 按 JLS 建议顺序重排行首修饰符。
 * 无法安全判断（未匹配、单个修饰符、顺序已正确）时返回 undefined。
 */
export function reorderModifiers(line: string): string | undefined {
  const match = MODIFIER_LINE.exec(line);
  if (!match) {
    return undefined;
  }
  const [, indent, modifierText, rest] = match;
  const modifiers = modifierText.trim().split(/\s+/);
  if (modifiers.length < 2) {
    return undefined;
  }
  if (modifiers.some((item) => MODIFIER_ORDER.indexOf(item) < 0)) {
    return undefined;
  }
  const sorted = [...modifiers].sort(
    (a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b)
  );
  if (sorted.join(' ') === modifiers.join(' ')) {
    return undefined;
  }
  const tail = rest.trimStart();
  return tail ? `${indent}${sorted.join(' ')} ${tail}` : `${indent}${sorted.join(' ')}`;
}
