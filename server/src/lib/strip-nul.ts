/**
 * PostgreSQL 的 text / jsonb 不能存 U+0000：邮件里解码出的字符串带 NUL 时整条插入会失败。
 * 递归去掉字符串里的 NUL；Date、Buffer 等非普通对象原样保留。
 */
export function stripNul<T>(value: T): T {
  if (typeof value === 'string') return (value.includes('\u0000') ? value.replaceAll('\u0000', '') : value) as T;
  if (Array.isArray(value)) return value.map(stripNul) as T;
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripNul(v);
    return out as T;
  }
  return value;
}
