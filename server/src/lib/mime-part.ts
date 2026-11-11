import libmime from 'libmime';
import libqp from 'libqp';

/**
 * 在原始邮件里定位第 N 个附件并只解码这一个部分。
 * 下载附件、显示正文内嵌图片时不必把整封邮件（包括其它几十 MB 附件）全部解析一遍。
 * 附件的计数规则与 mailparser 保持一致，调用方还要用入库时记录的大小核对，不一致就退回完整解析。
 */

const TEXT_TYPES = new Set(['text/plain', 'text/html', 'message/delivery-status']);
const MAX_DEPTH = 32;

type Leaf = {
  contentType: string;
  disposition: string | null;
  filename: string | null;
  cid: string | null;
  encoding: string;
  start: number;
  end: number;
};

export type AttachmentPart = { contentType: string; filename: string | null; cid: string | null; content: Buffer };

function headerEnd(buf: Buffer, start: number, end: number): { headerStop: number; bodyStart: number } {
  for (let i = start; i < end; i++) {
    if (buf[i] !== 0x0a) continue;
    // 空行：\n\n 或 \n\r\n
    if (buf[i + 1] === 0x0a) return { headerStop: i, bodyStart: Math.min(i + 2, end) };
    if (buf[i + 1] === 0x0d && buf[i + 2] === 0x0a) return { headerStop: i, bodyStart: Math.min(i + 3, end) };
  }
  // 只有头部没有正文；没有头部（第一行就是空行）也在这里处理
  if (buf[start] === 0x0a) return { headerStop: start, bodyStart: start + 1 };
  if (buf[start] === 0x0d && buf[start + 1] === 0x0a) return { headerStop: start, bodyStart: start + 2 };
  return { headerStop: end, bodyStart: end };
}

function parseHeaders(text: string) {
  const map = new Map<string, string>();
  for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    // 同名头部只取第一个，和 mailparser 一致
    if (!map.has(key)) map.set(key, line.slice(i + 1).trim());
  }
  return map;
}

const decodeWords = (s: string) => {
  try {
    return libmime.decodeWords(s);
  } catch {
    return s;
  }
};

/** 找到下一条位于行首的分隔线 --boundary，返回分隔线起点 */
function findDelimiter(buf: Buffer, delim: Buffer, from: number, end: number, bodyStart: number) {
  let i = from;
  while (i < end) {
    const idx = buf.indexOf(delim, i);
    if (idx < 0 || idx >= end) return -1;
    const atLineStart = idx === bodyStart || buf[idx - 1] === 0x0a;
    const after = buf[idx + delim.length];
    // 分隔线后面只能是 --、空白或换行，避免把更长的同前缀边界当成这一条
    const clean = after === undefined || after === 0x2d || after === 0x0d || after === 0x0a || after === 0x20 || after === 0x09;
    if (atLineStart && clean) return idx;
    i = idx + 1;
  }
  return -1;
}

/** 去掉分隔线前面的换行（属于分隔线，不属于正文） */
function trimBeforeDelimiter(buf: Buffer, idx: number, start: number) {
  let e = idx;
  if (e > start && buf[e - 1] === 0x0a) e--;
  if (e > start && buf[e - 1] === 0x0d) e--;
  return e;
}

function walk(buf: Buffer, start: number, end: number, out: Leaf[], depth: number) {
  if (depth > MAX_DEPTH) throw new Error('MIME 嵌套过深');
  const { headerStop, bodyStart } = headerEnd(buf, start, end);
  const headers = parseHeaders(buf.toString('utf8', start, headerStop));
  // 缺少 Content-Type 时按 RFC 2045 视为 text/plain
  const ct = libmime.parseHeaderValue(headers.get('content-type') ?? 'text/plain');
  const contentType = (ct.value || 'text/plain').toLowerCase();
  const boundary = ct.params.boundary;

  if (contentType.startsWith('multipart/') && boundary) {
    const delim = Buffer.from(`--${boundary}`, 'latin1');
    let idx = findDelimiter(buf, delim, bodyStart, end, bodyStart);
    while (idx >= 0) {
      if (buf[idx + delim.length] === 0x2d && buf[idx + delim.length + 1] === 0x2d) break;
      const lineEnd = buf.indexOf(0x0a, idx + delim.length);
      if (lineEnd < 0 || lineEnd >= end) break;
      const partStart = lineEnd + 1;
      const next = findDelimiter(buf, delim, partStart, end, bodyStart);
      const partEnd = next < 0 ? end : trimBeforeDelimiter(buf, next, partStart);
      walk(buf, partStart, partEnd, out, depth + 1);
      idx = next;
    }
    return;
  }

  const disposition = headers.has('content-disposition') ? libmime.parseHeaderValue(headers.get('content-disposition')!) : null;
  const filename = disposition?.params.filename ?? ct.params.name ?? null;
  const cid = headers.get('content-id') ?? null;
  out.push({
    contentType,
    disposition: disposition?.value?.toLowerCase() || null,
    filename: filename ? decodeWords(filename) : null,
    cid: cid ? cid.trim() : null,
    encoding: (headers.get('content-transfer-encoding') ?? '').trim().toLowerCase(),
    start: bodyStart,
    end,
  });
}

/** mailparser 的规则：非正文类型，或者处置方式不是 inline 的，都算附件 */
function isAttachment(leaf: Leaf) {
  let disposition = leaf.disposition;
  if (disposition && disposition !== 'attachment' && disposition !== 'inline') disposition = 'attachment';
  if (!disposition) disposition = TEXT_TYPES.has(leaf.contentType) ? 'inline' : 'attachment';
  return !TEXT_TYPES.has(leaf.contentType) || disposition !== 'inline';
}

function decodeBody(buf: Buffer, leaf: Leaf): Buffer {
  const raw = buf.subarray(leaf.start, leaf.end);
  if (leaf.encoding === 'base64') return Buffer.from(raw.toString('latin1'), 'base64');
  if (leaf.encoding === 'quoted-printable') return libqp.decode(raw.toString('latin1'));
  return Buffer.from(raw);
}

export function findAttachmentPart(raw: Buffer, index: number): AttachmentPart | null {
  const leaves: Leaf[] = [];
  walk(raw, 0, raw.length, leaves, 0);
  // 转发的整封邮件（message/rfc822）mailparser 会展开处理，规则复杂，交给完整解析
  if (leaves.some((l) => l.contentType === 'message/rfc822')) return null;
  const leaf = leaves.filter(isAttachment)[index];
  if (!leaf) return null;
  return { contentType: leaf.contentType, filename: leaf.filename, cid: leaf.cid, content: decodeBody(raw, leaf) };
}
