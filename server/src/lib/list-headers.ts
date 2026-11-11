import type { ListInfo } from '../db/schema.js';

// 邮件头最多看这么多，正常邮件头远小于这个
const HEAD_BYTES = 128 * 1024;

/** 取出原始邮件的头部并展开折行 */
function headerBlock(source: Buffer) {
  const head = source.subarray(0, HEAD_BYTES).toString('latin1');
  const end = head.search(/\r?\n\r?\n/);
  return (end >= 0 ? head.slice(0, end) : head).replace(/\r?\n[ \t]+/g, ' ');
}

function header(block: string, name: string) {
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(block);
  return m?.[1]?.trim() ?? null;
}

/**
 * 邮件列表相关的头：List-Unsubscribe（退订地址）、List-Unsubscribe-Post（RFC 8058 一键退订）、List-Id。
 * 没有这些头时返回空对象。
 */
export function parseListHeaders(source: Buffer): ListInfo {
  const block = headerBlock(source);
  const info: ListInfo = {};

  const unsub = header(block, 'List-Unsubscribe');
  if (unsub) {
    for (const [, raw] of unsub.matchAll(/<([^>]{1,2000})>/g)) {
      const uri = raw!.trim();
      if (/^https:\/\//i.test(uri)) info.http = info.http?.startsWith('https:') ? info.http : uri;
      else if (/^http:\/\//i.test(uri)) info.http ??= uri;
      else if (/^mailto:/i.test(uri)) info.mailto ??= uri;
    }
    const post = header(block, 'List-Unsubscribe-Post');
    if (post && /List-Unsubscribe=One-Click/i.test(post) && info.http?.startsWith('https:')) info.oneClick = true;
  }

  const listId = header(block, 'List-Id');
  if (listId) {
    const id = /<([^>]{1,255})>/.exec(listId)?.[1] ?? listId.split(/\s+/).pop();
    if (id) info.id = id.trim().toLowerCase();
    // 只保留不需要解码的纯文本名字
    const name = listId
      .replace(/<[^>]*>/, '')
      .replace(/^"|"$/g, '')
      .trim();
    if (name && !name.includes('=?') && /^[\x20-\x7e]+$/.test(name)) info.name = name.slice(0, 120);
  }
  return info;
}
