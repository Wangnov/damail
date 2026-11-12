/**
 * 解析类 Gmail 搜索语法：
 *   from:alice to:bob subject:发票 account:qq folder:inbox
 *   is:unread is:read is:starred is:answered has:attachment
 *   after:2026-01-01 before:2026-02-01 "精确短语" -排除词 其他关键词
 *   after:today after:yesterday after:7d after:2w after:3m after:1y（相对日期，按服务器时区算）
 *   category:finance priority:high is:needs-reply has:code（依赖 AI 分析结果）
 *   label:券商交易通知 label:"带空格的名字"（标签名，不区分大小写）
 */
export type ParsedQuery = {
  terms: string[];
  excludes: string[];
  from: string[];
  to: string[];
  subject: string[];
  account: string[];
  folder: string[];
  category: string[];
  priority: string[];
  label: string[];
  /** -label:xxx */
  notLabel: string[];
  needsReply?: boolean;
  hasCode?: boolean;
  isUnread?: boolean;
  isStarred?: boolean;
  isAnswered?: boolean;
  hasAttachment?: boolean;
  after?: Date;
  before?: Date;
};

const TOKEN = /(-?)(?:(\w+):)?(?:"([^"]*)"|(\S+))/g;

/**
 * 相对日期，都从某天零点算：today 今天，yesterday 昨天；
 * Nd / Nw 是含今天在内的最近 N 天 / N 周（after:7d 从 6 天前开始），Nm / Ny 是 N 个月 / N 年前的同一天。
 * before:today 是今天以前。
 */
function relativeDate(value: string, now: Date): Date | undefined {
  const v = value.toLowerCase();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (v === 'today') return d;
  if (v === 'yesterday') {
    d.setDate(d.getDate() - 1);
    return d;
  }
  const m = /^(\d{1,4})([dwmy])$/.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (m[2] === 'd') d.setDate(d.getDate() - Math.max(n - 1, 0));
  else if (m[2] === 'w') d.setDate(d.getDate() - Math.max(n * 7 - 1, 0));
  else if (m[2] === 'm') d.setMonth(d.getMonth() - n);
  else d.setFullYear(d.getFullYear() - n);
  return d;
}

function parseDate(value: string, now: Date): Date | undefined {
  const rel = relativeDate(value, now);
  if (rel) return rel;
  const d = new Date(/^\d{4}-\d{1,2}-\d{1,2}$/.test(value) ? `${value}T00:00:00` : value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** now 只给测试用，用来固定「今天」 */
export function parseSearchQuery(input: string | undefined | null, now = new Date()): ParsedQuery {
  const q: ParsedQuery = { terms: [], excludes: [], from: [], to: [], subject: [], account: [], folder: [], category: [], priority: [], label: [], notLabel: [] };
  if (!input) return q;
  for (const m of input.matchAll(TOKEN)) {
    const negate = m[1] === '-';
    const key = m[2]?.toLowerCase();
    const value = (m[3] ?? m[4] ?? '').trim();
    if (!value) continue;
    switch (key) {
      case 'from':
      case 'to':
      case 'subject':
      case 'account':
      case 'folder':
        q[key].push(value);
        break;
      case 'category':
      case 'priority':
        q[key].push(value.toLowerCase());
        break;
      case 'label':
        (negate ? q.notLabel : q.label).push(value);
        break;
      case 'is': {
        const v = value.toLowerCase();
        if (v === 'unread') q.isUnread = !negate;
        else if (v === 'read') q.isUnread = negate;
        else if (v === 'starred' || v === 'flagged') q.isStarred = !negate;
        else if (v === 'answered' || v === 'replied') q.isAnswered = !negate;
        else if (v === 'needs-reply' || v === 'needsreply') q.needsReply = !negate;
        break;
      }
      case 'has':
        if (/^attachments?$/i.test(value)) q.hasAttachment = !negate;
        else if (/^codes?$/i.test(value)) q.hasCode = !negate;
        break;
      case 'after':
      case 'since':
        q.after = parseDate(value, now) ?? q.after;
        break;
      case 'before':
        q.before = parseDate(value, now) ?? q.before;
        break;
      default: {
        // 未知前缀按普通关键词处理（例如时间 10:30）
        const term = key ? `${m[2]}:${value}` : value;
        (negate ? q.excludes : q.terms).push(term);
      }
    }
  }
  return q;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
