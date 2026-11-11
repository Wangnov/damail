/**
 * 解析类 Gmail 搜索语法：
 *   from:alice to:bob subject:发票 account:qq folder:inbox
 *   is:unread is:read is:starred is:answered has:attachment
 *   after:2026-01-01 before:2026-02-01 "精确短语" -排除词 其他关键词
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

function parseDate(value: string): Date | undefined {
  const d = new Date(/^\d{4}-\d{1,2}-\d{1,2}$/.test(value) ? `${value}T00:00:00` : value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function parseSearchQuery(input: string | undefined | null): ParsedQuery {
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
        q.after = parseDate(value) ?? q.after;
        break;
      case 'before':
        q.before = parseDate(value) ?? q.before;
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
