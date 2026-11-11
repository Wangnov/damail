import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { Address } from '../api';
import { intlLocale, t } from '../i18n';

// dayjs 的语言跟着界面语言切换（见 i18n/index.ts）
dayjs.extend(relativeTime);

/** 列表时间：今天显示时分，今年显示月日，更早显示年月日 */
export function shortDate(iso: string) {
  const d = dayjs(iso);
  const now = dayjs();
  if (d.isSame(now, 'day')) return d.format('HH:mm');
  if (d.isSame(now.subtract(1, 'day'), 'day')) return t.common.date.yesterdayAt(d.format('HH:mm'));
  if (d.isSame(now, 'year')) return d.format(t.common.date.monthDay);
  return d.format(t.common.date.short);
}

export function fullDate(iso: string) {
  return dayjs(iso).format(t.common.date.full);
}

export function fromNow(iso: string | null) {
  return iso ? dayjs(iso).fromNow() : t.common.never;
}

export function formatAddress(a: Address) {
  if (a.name && a.address) return `${a.name} <${a.address}>`;
  return a.name || a.address || '';
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const PALETTE = ['#1677ff', '#13a8a8', '#722ed1', '#eb2f96', '#fa8c16', '#52c41a', '#2f54eb', '#fa541c'];

export function colorFor(key: string | number) {
  const s = String(key);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function initials(name: string) {
  const s = name.trim();
  if (!s) return '?';
  // 中文取最后一个字（通常是名），英文取首字母
  return /[一-龥]/.test(s[0]!) ? s.slice(-1) : s[0]!.toUpperCase();
}

const FOLDER_KEYS = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'all',
  '\\Flagged': 'flagged',
} as const;

/** 系统文件夹（specialUse）的显示名 */
export function specialFolderLabel(specialUse: string | null | undefined) {
  const key = specialUse ? FOLDER_KEYS[specialUse as keyof typeof FOLDER_KEYS] : undefined;
  return key ? t.common.folders[key] : null;
}

type FolderLike = { name: string; path: string; specialUse: string | null };

export function folderLabel(f: FolderLike) {
  if (f.path.toUpperCase() === 'INBOX') return t.common.folders.inbox;
  return specialFolderLabel(f.specialUse) ?? f.name;
}

// 系统文件夹在前，按常用程度排；自定义文件夹排在后面，按名称
const FOLDER_RANK = ['\\Inbox', '\\Sent', '\\Drafts', '\\Archive', '\\All', '\\Flagged', '\\Junk', '\\Trash'];

const folderRank = (f: FolderLike) => {
  if (f.path.toUpperCase() === 'INBOX') return 0;
  const i = f.specialUse ? FOLDER_RANK.indexOf(f.specialUse) : -1;
  return i < 0 ? FOLDER_RANK.length : i;
};

export function sortFolders<T extends FolderLike>(list: T[]): T[] {
  return [...list].sort((a, b) => folderRank(a) - folderRank(b) || folderLabel(a).localeCompare(folderLabel(b), intlLocale()));
}

/** 定时发送时间：今天 / 明天 / 日期 + 时刻 */
export function formatSendAt(at: string | Date) {
  const d = dayjs(at);
  const today = dayjs();
  const { date } = t.common;
  const day = d.isSame(today, 'day')
    ? date.today
    : d.isSame(today.add(1, 'day'), 'day')
      ? date.tomorrow
      : d.format(d.isSame(today, 'year') ? date.monthDay : date.yearMonthDay);
  return `${day} ${d.format('HH:mm')}`;
}

// 邮箱服务商对应的品牌图标域名：用网页邮箱的域名，gmail.com 这类个人邮箱域名图标接口不返回；
// 企业邮箱的邮件地址是自己的域名，也要用服务商的图标
const PROVIDER_ICON: Record<string, string> = {
  qq: 'mail.qq.com',
  '163': 'mail.163.com',
  '126': 'mail.126.com',
  gmail: 'mail.google.com',
  icloud: 'www.icloud.com',
  outlook: 'outlook.live.com',
  exmail: 'exmail.qq.com',
  yeah: 'mail.yeah.net',
  'aliyun-personal': 'mail.aliyun.com',
  aliyun: 'qiye.aliyun.com',
  qiye163: 'qiye.163.com',
};

/** 邮箱服务商的图标域名，「其他 IMAP」这类没有 */
export const providerIconDomain = (provider: string) => PROVIDER_ICON[provider] ?? null;

/** 邮箱账户的图标域名：已知服务商用服务商的，自定义邮箱用邮件地址的域名 */
export function accountIconDomain(a: { provider: string; email: string }) {
  return PROVIDER_ICON[a.provider] ?? (a.email.split('@')[1]?.toLowerCase() || null);
}

/** 按当前时间问候：夜深了 / 早上好 / 中午好 / 下午好 / 晚上好 */
export function greeting() {
  const h = new Date().getHours();
  const g = t.common.greeting;
  if (h < 6) return g.lateNight;
  if (h < 11) return g.morning;
  if (h < 13) return g.noon;
  if (h < 18) return g.afternoon;
  return g.evening;
}
