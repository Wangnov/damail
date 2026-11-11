import { isTag, isText, type AnyNode } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import type { ListInfo } from '../db/schema.js';

/**
 * 从邮件正文里找退订链接，给没有 List-Unsubscribe 头（不符合 RFC 2369 / 8058）的营销邮件用。
 * 只认 http(s) 链接，只会交给用户在浏览器里打开，不会自动请求。
 *
 * 判断依据（从强到弱）：
 * - 链接文字是「退订 / Unsubscribe / 配信停止 …」
 * - 链接地址里带 unsubscribe / opt-out
 * - 链接文字是「点击这里 / here」，前后文字说的是退订
 * - 链接文字或地址是「管理订阅 / 邮件偏好」，且正文其他地方提到了退订
 */

// 各语言里「退订」的说法
const STRONG =
  /unsubscri|un-subscri|opt[\s_-]?out|no longer (wish|want) to receive|stop receiving|remove (yourself|me) from|退订|退訂|取消订阅|取消訂閱|退阅|不再接收|不想再收到|不再收到|désabonn|désinscri|abbestell|abmeld|darse de baja|cancelar (la )?suscripci|desuscrib|disiscriv|uitschrijv|отписа|配信停止|配信解除|購読解除|登録解除|수신\s?거부|구독\s?취소/i;
// 「管理订阅 / 偏好设置」这类，单独出现时不一定是退订
const WEAK =
  /(manage|update|change|edit)\s+(your\s+)?(email\s+|mail\s+|subscription\s+|notification\s+)?(preferences|subscriptions?|settings)|email preferences|subscription (preferences|settings|center|centre)|preference cent(er|re)|管理订阅|订阅设置|邮件偏好|邮件设置|訂閱設定|配信設定/i;
const HREF_STRONG = /unsubscri|opt[-_]?out|optout|\/unsub\b|[?&]unsub/i;
// 地址里单独的 subscription 不算：常见的是付费订阅管理页（如 App Store 订阅），不是退订
const HREF_WEAK = /preferences|manage[-_]?(email|sub)/i;
// 只写了「点这里」的链接文字，要结合前后文判断
const GENERIC = /^(click\s+)?here\.?$|^(this\s+)?link\.?$|^点击(这里|此处)?$|^(这里|此处|点此)$|^ここ$|^여기$/i;

const MAX_HTML = 512 * 1024;
const CONTEXT = 120;

type Candidate = { url: string; score: number; pos: number };

const isWebUrl = (u: string) => /^https?:\/\/[^\s"'<>]+$/i.test(u) && u.length <= 2000;

function pick(cands: Candidate[]) {
  // 分数相同取靠后的：退订链接一般在页脚；同分同位置时 https 优先
  let best: Candidate | null = null;
  for (const c of cands) {
    if (!best || c.score > best.score || (c.score === best.score && c.pos >= best.pos)) best = c;
  }
  return best;
}

function fromHtml(html: string): Candidate[] {
  const doc = parseDocument(html.slice(0, MAX_HTML));
  let text = '';
  const anchors: { href: string; label: string; start: number; end: number }[] = [];

  const walk = (nodes: AnyNode[]) => {
    for (const n of nodes) {
      if (isText(n)) text += n.data;
      else if (isTag(n)) {
        if (n.name === 'script' || n.name === 'style' || n.name === 'head') continue;
        if (n.name === 'br' || n.name === 'p' || n.name === 'div' || n.name === 'tr' || n.name === 'li') text += '\n';
        if (n.name === 'a' && n.attribs.href) {
          const start = text.length;
          walk(n.children);
          anchors.push({ href: n.attribs.href.trim(), label: text.slice(start).replace(/\s+/g, ' ').trim(), start, end: text.length });
          continue;
        }
        // 图片按钮的退订：用 alt / title 当文字
        if (n.name === 'img' && (n.attribs.alt || n.attribs.title)) text += ` ${n.attribs.alt || n.attribs.title} `;
        walk(n.children);
      }
    }
  };
  walk(doc.children);

  const mentionsUnsub = STRONG.test(text);
  const out: Candidate[] = [];
  for (const a of anchors) {
    if (!isWebUrl(a.href)) continue;
    const around = text.slice(Math.max(0, a.start - CONTEXT), a.start) + ' ' + text.slice(a.end, a.end + CONTEXT / 2);
    let score = 0;
    if (STRONG.test(a.label)) score = 100;
    else if (HREF_STRONG.test(a.href)) score = 80;
    else if (GENERIC.test(a.label) && STRONG.test(around)) score = 60;
    else if (mentionsUnsub && (WEAK.test(a.label) || HREF_WEAK.test(a.href))) score = 30;
    if (score) out.push({ url: a.href, score: score + (a.href.startsWith('https:') ? 1 : 0), pos: a.start });
  }
  return out;
}

function fromText(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of text.slice(0, MAX_HTML).matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (!isWebUrl(url)) continue;
    const before = text.slice(Math.max(0, m.index - CONTEXT), m.index);
    let score = 0;
    if (HREF_STRONG.test(url)) score = 80;
    else if (STRONG.test(before)) score = 60;
    if (score) out.push({ url, score: score + (url.startsWith('https:') ? 1 : 0), pos: m.index });
  }
  return out;
}

/** 回复、转发的邮件可能引用了别人的营销邮件，不从里面找 */
const REPLY_SUBJECT = /^\s*(re|fw|fwd|aw|wg|sv|回复|回覆|答复|转发|轉寄|轉發)\s*[:：]/i;

export function findBodyUnsubscribe(m: { subject?: string | null; inReplyTo?: string | null; htmlBody?: string | null; textBody?: string | null }) {
  if (m.inReplyTo || REPLY_SUBJECT.test(m.subject ?? '')) return null;
  const cands = m.htmlBody ? fromHtml(m.htmlBody) : m.textBody ? fromText(m.textBody) : [];
  return pick(cands)?.url ?? null;
}

// 识别规则改进后加一，旧邮件会按新规则重新找一遍
export const BODY_SCAN_VERSION = 2;

export type BodyFields = { subject?: string | null; inReplyTo?: string | null; htmlBody?: string | null; textBody?: string | null };

/** 邮件头里没有退订方式时，用正文里找到的退订链接补上（标记 source: 'body'）；有邮件头的以邮件头为准 */
export function withBodyUnsubscribe(info: ListInfo, m: BodyFields): ListInfo {
  // 之前从正文找到的链接按当前规则重新找，先去掉
  const { http, source, bodyScan: _, ...rest } = info;
  const base: ListInfo = source === 'body' ? rest : { ...rest, ...(http ? { http } : {}) };
  if (base.http || base.mailto) return info;
  const url = findBodyUnsubscribe(m);
  return url ? { ...base, http: url, source: 'body', bodyScan: BODY_SCAN_VERSION } : { ...base, bodyScan: BODY_SCAN_VERSION };
}

/** 邮件头里没有退订方式（或者退订链接是从正文找到的），且还没按当前规则找过正文 */
export const needsBodyScan = (info: ListInfo | null | undefined) =>
  Boolean(info && (info.source === 'body' || (!info.http && !info.mailto)) && (info.bodyScan ?? 0) < BODY_SCAN_VERSION);
