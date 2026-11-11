/**
 * 搜索框的中文写法：提交前换成后端认识的英文语法，例如
 *   分类:账单 → category:finance   优先级:高 → priority:high
 *   需回复 → is:needs-reply   有验证码 → has:code   发件人:张三 → from:张三
 * 引号里的短语和普通关键词原样保留。
 */

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

const PRIORITY_ALIAS: Record<string, string> = { 高: 'high', 普通: 'normal', 中: 'normal', 低: 'low' };

/** 带值的前缀 */
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

/** 单独的状态词 */
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
};

function convert(token: string): string {
  if (token.startsWith('"')) return token;
  if (FLAG_ALIAS[token]) return FLAG_ALIAS[token];
  const m = token.match(/^([^:：]+)[:：](.+)$/);
  const key = m && KEY_ALIAS[m[1]!];
  if (!m || !key) return token;
  const value = m[2]!;
  if (key === 'category') return `category:${CATEGORY_ALIAS[value] ?? value}`;
  if (key === 'priority') return `priority:${PRIORITY_ALIAS[value] ?? value}`;
  return `${key}:${value}`;
}

export function normalizeQuery(input: string): string {
  return input
    .trim()
    .replace(/(-?)("[^"]*"|\S+)/g, (_, neg: string, token: string) => neg + convert(token))
    .replace(/\s+/g, ' ');
}

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
