/**
 * 搜索框的中文写法：提交前换成后端认识的英文语法，例如
 *   分类:账单 → category:finance   优先级:高 → priority:high
 *   需回复 → is:needs-reply   有验证码 → has:code   发件人:张三 → from:张三
 *   今天 → after:today   近7天 → after:7d   之后:3个月 → after:3m
 * 引号里的短语和普通关键词原样保留。中文界面显示时再换回中文写法（localizeQuery）。
 *
 * 这个文件不依赖界面和网络，测试见 web/test/search.test.ts。
 */

export type SearchLang = 'zh' | 'en';

/** 分类的中文名（含常见叫法）→ 英文名 */
const CATEGORY_ALIAS: Record<string, string> = {
  重要: 'important',
  工作: 'work',
  个人: 'personal',
  账单: 'finance',
  财务: 'finance',
  账单财务: 'finance',
  验证码: 'verification',
  物流: 'shipping',
  快递: 'shipping',
  通知: 'notification',
  系统通知: 'notification',
  社交: 'social',
  营销: 'marketing',
  推广: 'marketing',
  广告: 'marketing',
  营销推广: 'marketing',
  垃圾: 'spam',
};

/** 分类的英文名 → 输入框里显示的中文写法 */
export const CATEGORY_ZH: Record<string, string> = {
  important: '重要',
  work: '工作',
  personal: '个人',
  finance: '账单',
  verification: '验证码',
  shipping: '物流',
  notification: '通知',
  social: '社交',
  marketing: '营销',
  spam: '垃圾',
};

const PRIORITY_ALIAS: Record<string, string> = { 高: 'high', 普通: 'normal', 中: 'normal', 低: 'low' };
export const PRIORITY_ZH: Record<string, string> = { high: '高', normal: '普通', low: '低' };

/** 常用文件夹的中文名 → 后端认识的英文名 */
const FOLDER_ALIAS: Record<string, string> = {
  收件箱: 'inbox',
  已发送: 'sent',
  草稿: 'drafts',
  草稿箱: 'drafts',
  已删除: 'trash',
  废纸篓: 'trash',
  垃圾邮件: 'junk',
  归档: 'archive',
};
export const FOLDER_ZH: Record<string, string> = { inbox: '收件箱', sent: '已发送', drafts: '草稿箱', trash: '已删除', junk: '垃圾邮件', archive: '归档' };

/** 带值的前缀（中文 → 英文） */
const KEY_ALIAS: Record<string, string> = {
  分类: 'category',
  类别: 'category',
  优先级: 'priority',
  发件人: 'from',
  来自: 'from',
  收件人: 'to',
  发给: 'to',
  主题: 'subject',
  账户: 'account',
  邮箱: 'account',
  文件夹: 'folder',
  标签: 'label',
  之后: 'after',
  之前: 'before',
};

/** 后端认识的前缀，以及中文界面里显示的写法 */
export const KEY_ZH = {
  from: '发件人',
  to: '收件人',
  subject: '主题',
  account: '邮箱',
  folder: '文件夹',
  label: '标签',
  after: '之后',
  before: '之前',
  category: '分类',
  priority: '优先级',
} as const;
export type SearchKey = keyof typeof KEY_ZH;
/** is: 和 has: 只用英文写法，中文界面里写成状态词 */
type AnyKey = SearchKey | 'is' | 'has';
const ANY_KEYS = new Set<string>([...Object.keys(KEY_ZH), 'is', 'has']);

/** 单独的状态词（中文 → 英文） */
const FLAG_ALIAS: Record<string, string> = {
  需回复: 'is:needs-reply',
  待回复: 'is:needs-reply',
  需要回复: 'is:needs-reply',
  有验证码: 'has:code',
  有附件: 'has:attachment',
  未读: 'is:unread',
  已读: 'is:read',
  星标: 'is:starred',
  已回复: 'is:answered',
  今天: 'after:today',
  近7天: 'after:7d',
  近30天: 'after:30d',
};

/** 英文状态 → 中文界面里显示的写法 */
export const FLAG_ZH: Record<string, string> = {
  'is:unread': '未读',
  'is:read': '已读',
  'is:starred': '星标',
  'is:answered': '已回复',
  'is:needs-reply': '需回复',
  'has:attachment': '有附件',
  'has:code': '有验证码',
  'after:today': '今天',
  'after:7d': '近7天',
  'after:30d': '近30天',
};

/** 日期值的中文写法：今天、昨天、7天、2周、3个月、1年 */
const DATE_UNIT_ZH: Record<string, string> = { d: '天', w: '周', m: '个月', y: '年' };

function dateToEn(value: string): string {
  if (value === '今天') return 'today';
  if (value === '昨天') return 'yesterday';
  const m = /^(\d{1,4})(天|周|个?月|年)$/.exec(value);
  if (!m) return value;
  const unit = m[2]!.endsWith('月') ? 'm' : m[2] === '天' ? 'd' : m[2] === '周' ? 'w' : 'y';
  return `${m[1]}${unit}`;
}

function dateToZh(value: string): string {
  const v = value.toLowerCase();
  if (v === 'today') return '今天';
  if (v === 'yesterday') return '昨天';
  const m = /^(\d{1,4})([dwmy])$/.exec(v);
  return m ? `${m[1]}${DATE_UNIT_ZH[m[2]!]}` : value;
}

/** 一个词：可能带 - 前缀、可能是 key:value，value 可能带引号（"a b"） */
const TOKEN = /(-?)((?:[^\s"：:]+[:：])?"[^"]*"?|\S+)/g;

export type QueryToken = {
  /** 原文（含 -） */
  text: string;
  start: number;
  end: number;
  neg: boolean;
  /** 冒号前面的原文；没有冒号是 null */
  rawKey: string | null;
  /** 换成英文后的前缀（认不出是 null） */
  key: AnyKey | null;
  /** 冒号后面的值，去掉了引号 */
  value: string;
};

const unquote = (v: string) => v.replace(/^"/, '').replace(/"$/, '');
/** 值里有空格时加引号 */
export const quoteValue = (v: string) => (/\s/.test(v) ? `"${v}"` : v);

export function canonicalKey(raw: string): AnyKey | null {
  const lower = raw.toLowerCase();
  if (ANY_KEYS.has(lower)) return lower as AnyKey;
  return (KEY_ALIAS[raw] as SearchKey | undefined) ?? null;
}

function splitToken(neg: string, body: string, start: number): QueryToken {
  const m = body.startsWith('"') ? null : /^([^:：]+)[:：](.*)$/.exec(body);
  return {
    text: neg + body,
    start,
    end: start + neg.length + body.length,
    neg: neg === '-',
    rawKey: m ? m[1]! : null,
    key: m ? canonicalKey(m[1]!) : null,
    value: unquote(m ? m[2]! : body),
  };
}

export function tokenize(input: string): QueryToken[] {
  return [...input.matchAll(TOKEN)].map((m) => splitToken(m[1]!, m[2]!, m.index!));
}

function convert(token: string): string {
  if (token.startsWith('"')) return token;
  if (FLAG_ALIAS[token]) return FLAG_ALIAS[token];
  const m = token.match(/^([^:：]+)[:：](.+)$/);
  // 中文前缀换成英文；英文前缀的值也可以用中文写（category:账单）
  const lower = m?.[1]!.toLowerCase();
  const key = m && (KEY_ALIAS[m[1]!] ?? (lower && lower in KEY_ZH ? lower : null));
  if (!m || !key) return token;
  const value = m[2]!;
  if (key === 'category') return `category:${CATEGORY_ALIAS[value] ?? value}`;
  if (key === 'priority') return `priority:${PRIORITY_ALIAS[value] ?? value}`;
  if (key === 'folder') return `folder:${FOLDER_ALIAS[value] ?? value}`;
  if (key === 'after' || key === 'before') return `${key}:${dateToEn(value)}`;
  return `${key}:${value}`;
}

/** 提交前：中文写法换成英文语法，多余空格合并 */
export function normalizeQuery(input: string): string {
  return tokenize(input.trim())
    .map((tk) => (tk.neg ? '-' : '') + convert(tk.text.slice(tk.neg ? 1 : 0)))
    .join(' ');
}

/** 一个英文条件在中文界面里的写法 */
function tokenToZh(body: string): string {
  if (body.startsWith('"')) return body;
  const flag = FLAG_ZH[body.toLowerCase()];
  if (flag) return flag;
  const m = /^(\w+):(.+)$/.exec(body);
  const key = m?.[1]!.toLowerCase();
  if (!m || !key || !(key in KEY_ZH)) return body;
  const raw = m[2]!;
  let value = raw;
  if (key === 'category') value = CATEGORY_ZH[raw.toLowerCase()] ?? raw;
  else if (key === 'priority') value = PRIORITY_ZH[raw.toLowerCase()] ?? raw;
  else if (key === 'folder') value = FOLDER_ZH[raw.toLowerCase()] ?? raw;
  else if (key === 'after' || key === 'before') value = dateToZh(raw);
  return `${KEY_ZH[key as SearchKey]}:${value}`;
}

/**
 * 显示用：英文语法按界面语言写出来（中文界面 from:amazon → 发件人:amazon），
 * 再经过 normalizeQuery 能换回原样，所以链接里一直是英文语法。
 */
export function localizeQuery(q: string, lang: SearchLang): string {
  if (lang === 'en' || !q) return q;
  return tokenize(q)
    .map((tk) => (tk.neg ? '-' : '') + tokenToZh(tk.text.slice(tk.neg ? 1 : 0)))
    .join(' ');
}

/** 去掉第 index 个词（用于条件标签上的 ×） */
export function removeToken(q: string, index: number): string {
  return tokenize(q)
    .filter((_, i) => i !== index)
    .map((tk) => tk.text)
    .join(' ');
}

/** 搜索语句里是否已经有这个条件（英文语法，不区分大小写） */
export function hasToken(q: string, token: string): boolean {
  const target = token.toLowerCase();
  return tokenize(normalizeQuery(q)).some((tk) => tk.text.toLowerCase() === target);
}

/** 加上或去掉一个条件（快捷筛选用）；返回英文语法 */
export function toggleToken(q: string, token: string): string {
  const norm = normalizeQuery(q);
  const target = token.toLowerCase();
  const list = tokenize(norm);
  const i = list.findIndex((tk) => tk.text.toLowerCase() === target);
  if (i >= 0) return removeToken(norm, i);
  return norm ? `${norm} ${token}` : token;
}

// ---- 光标处的词：决定下拉里补全什么 ----

export type CursorWord = {
  start: number;
  end: number;
  /** 光标所在的整个词（含 -），光标在空白处时是空串 */
  text: string;
  neg: boolean;
  rawKey: string | null;
  key: AnyKey | null;
  /** 冒号后、光标前已经输入的部分 */
  value: string;
  /** 在没闭合的引号里：不做补全 */
  inQuote: boolean;
};

export function wordAt(input: string, cursor: number): CursorWord {
  let start = cursor;
  while (start > 0 && !/\s/.test(input[start - 1]!)) start--;
  let end = cursor;
  while (end < input.length && !/\s/.test(input[end]!)) end++;
  const before = input.slice(0, cursor);
  const inQuote = (before.match(/"/g)?.length ?? 0) % 2 === 1;
  const text = input.slice(start, end);
  const neg = text.startsWith('-');
  const body = text.slice(neg ? 1 : 0);
  const typed = input.slice(start + (neg ? 1 : 0), cursor);
  const m = /^([^:："]+)[:：](.*)$/.exec(body);
  const tm = /^[^:："]+[:：](.*)$/.exec(typed);
  return {
    start,
    end,
    text,
    neg,
    rawKey: m ? m[1]! : null,
    key: m ? canonicalKey(m[1]!) : null,
    value: tm ? unquote(tm[1]!) : '',
    inQuote,
  };
}

/**
 * 用 insert 替换光标处的词。insert 以冒号结尾（只补了前缀）时不加空格，方便接着输入值；
 * 否则补一个空格。返回新的文字和光标位置。
 */
export function replaceWord(input: string, word: Pick<CursorWord, 'start' | 'end'>, insert: string): { value: string; cursor: number } {
  const head = input.slice(0, word.start);
  const tail = input.slice(word.end);
  const open = /[:：]$/.test(insert) || insert === '-' || insert === '';
  const gap = open ? '' : tail.startsWith(' ') ? '' : ' ';
  const pre = head && !/\s$/.test(head) ? `${head} ` : head;
  const value = pre + insert + gap + tail;
  return { value, cursor: pre.length + insert.length + (open ? 0 : 1) };
}

// ---- 条件名的联想 ----

export type KeyOption = {
  /** 插入的写法（以冒号结尾的是前缀，其余是完整条件） */
  insert: string;
  /** 英文语法里对应的前缀或条件 */
  canonical: string;
};

/** 输入的是中文就补中文写法，否则补英文写法；两边的别名都能联想 */
const KEY_ORDER: SearchKey[] = ['from', 'to', 'subject', 'account', 'folder', 'label', 'category', 'priority', 'after', 'before'];
const FLAG_ORDER = ['is:unread', 'is:starred', 'has:attachment', 'is:needs-reply', 'has:code', 'is:answered', 'is:read', 'after:today', 'after:7d', 'after:30d'];
/** 英文界面里状态的联想词（is:unread 也能用 unread 联想出来） */
const FLAG_EN_WORDS: Record<string, string[]> = {
  'after:today': ['today'],
  'after:7d': ['week', '7d'],
  'after:30d': ['month', '30d'],
  'is:needs-reply': ['reply', 'needs-reply'],
  'has:code': ['code'],
};

export function keyOptions(typed: string, limit = 6): KeyOption[] {
  const w = typed.toLowerCase();
  if (!w) return [];
  const zh = isZhText(typed);
  const score = (names: string[]) => {
    let best = 0;
    for (const n of names.map((x) => x.toLowerCase())) {
      if (n === w) best = Math.max(best, 3);
      else if (n.startsWith(w)) best = Math.max(best, 2);
      else if (w.length >= 2 && n.includes(w)) best = Math.max(best, 1);
    }
    return best;
  };
  const zhKeys = (k: SearchKey) => Object.keys(KEY_ALIAS).filter((a) => KEY_ALIAS[a] === k);
  const zhFlags = (f: string) => Object.keys(FLAG_ALIAS).filter((a) => FLAG_ALIAS[a] === f);
  const out: (KeyOption & { s: number; i: number })[] = [];
  KEY_ORDER.forEach((k, i) => {
    const s = score([k, ...zhKeys(k)]);
    if (s) out.push({ insert: zh ? `${KEY_ZH[k]}:` : `${k}:`, canonical: `${k}:`, s, i });
  });
  FLAG_ORDER.forEach((f, i) => {
    const words = [f, f.split(':')[1]!, ...(FLAG_EN_WORDS[f] ?? []), ...zhFlags(f)];
    const s = score(words);
    if (s) out.push({ insert: zh ? FLAG_ZH[f]! : f, canonical: f, s, i: i + KEY_ORDER.length });
  });
  // 输入已经是完整条件（例如「未读」）就不用再联想它自己
  return out
    .filter((o) => o.insert.toLowerCase() !== w)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map(({ insert, canonical }) => ({ insert, canonical }));
}

/** 含非 ASCII 字符（中文）：补全时用中文写法 */
export const isZhText = (s: string) => /[^\x00-\x7f]/.test(s);

/** 值的写法（插入用）：中文前缀配中文值，英文前缀配英文值 */
export function valueSpelling(key: AnyKey, canonicalValue: string, lang: SearchLang): string {
  if (lang === 'en') return quoteValue(canonicalValue);
  if (key === 'category') return CATEGORY_ZH[canonicalValue] ?? canonicalValue;
  if (key === 'priority') return PRIORITY_ZH[canonicalValue] ?? canonicalValue;
  if (key === 'folder') return FOLDER_ZH[canonicalValue] ?? quoteValue(canonicalValue);
  if (key === 'after' || key === 'before') return dateToZh(canonicalValue);
  return quoteValue(canonicalValue);
}

/** 值是否和已经输入的部分匹配（英文名、中文写法和显示名都算） */
export function valueMatches(typed: string, ...names: (string | undefined | null)[]): boolean {
  const w = typed.trim().toLowerCase();
  if (!w) return true;
  return names.some((n) => n?.toLowerCase().includes(w));
}

/** 相对日期的英文值，用来显示「近 7 天」这样的说明 */
export function relativeDate(value: string): { n: number; unit: 'd' | 'w' | 'm' | 'y' } | 'today' | 'yesterday' | null {
  const v = dateToEn(value).toLowerCase();
  if (v === 'today' || v === 'yesterday') return v;
  const m = /^(\d{1,4})([dwmy])$/.exec(v);
  return m ? { n: Number(m[1]), unit: m[2] as 'd' | 'w' | 'm' | 'y' } : null;
}

// ---- 最近搜索（存在本机浏览器里） ----

const HISTORY_KEY = 'damail.searchHistory';
const HISTORY_MAX = 8;

export function readHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function writeHistory(list: string[]) {
  try {
    if (list.length) localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    else localStorage.removeItem(HISTORY_KEY);
  } catch {
    // 无痕模式存不了，不记
  }
}

/** q 是英文语法；同样的搜索挪到最前面 */
export function pushHistory(q: string): string[] {
  const list = [q, ...readHistory().filter((x) => x !== q)].slice(0, HISTORY_MAX);
  writeHistory(list);
  return list;
}

export function dropHistory(q: string | null): string[] {
  const list = q === null ? [] : readHistory().filter((x) => x !== q);
  writeHistory(list);
  return list;
}

// ---- 侧栏和标签点击用的固定搜索语句 ----

/** 分类筛选用的搜索语句；侧栏和标签点击共用，侧栏靠它认出当前选中的分类 */
export const categoryQuery = (category: string) => `category:${category}`;
export const categoryOfQuery = (q: string | null) => q?.match(/^category:(\w+)$/)?.[1] ?? null;

/** 标签筛选用的搜索语句；名字里有空格时加引号 */
export const labelQuery = (name: string) => (/\s/.test(name) ? `label:"${name}"` : `label:${name}`);
export const labelOfQuery = (q: string | null) => {
  const m = q?.match(/^label:(?:"([^"]+)"|(\S+))$/);
  return m ? (m[1] ?? m[2]!) : null;
};

/** 需要回复：收件箱里 AI 判断要回、自己还没回的 */
export const NEEDS_REPLY_Q = 'is:needs-reply -is:answered';
