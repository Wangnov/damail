import { asc, eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { als, currentLocale, getSystemLocale, LOCALES, setSystemLocale, type Locale } from './context.js';
import { MESSAGES, type Messages } from './messages/index.js';

export { currentLocale, DEFAULT_LOCALE, FALLBACK_LOCALE, getSystemLocale, L, LOCALES, pickLocale, withLocale, type I18n, type Locale } from './context.js';

// zod 自带的通用校验错误（类型不对、超长等）也按当前语言输出
const zodLocales: Record<Locale, ReturnType<typeof z.locales.en>['localeError']> = { 'zh-CN': z.locales.zhCN().localeError, en: z.locales.en().localeError };
z.config({ localeError: (issue) => zodLocales[currentLocale()](issue) });

export const isLocale = (v: unknown): v is Locale => (LOCALES as readonly unknown[]).includes(v);

/** 把 zh / zh-Hans / en-US 这类写法归到支持的语言，认不出返回 null */
export function normalizeLocale(v: string | null | undefined): Locale | null {
  const s = v?.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('zh')) return 'zh-CN';
  if (s.startsWith('en')) return 'en';
  return null;
}

/** Accept-Language 里第一个支持的语言 */
function fromAcceptLanguage(header: string | undefined): Locale | null {
  for (const part of header?.split(',') ?? []) {
    const l = normalizeLocale(part.split(';')[0]);
    if (l) return l;
  }
  return null;
}

const userLocales = new Map<number, Locale>();

export async function loadSystemLocale() {
  const first = await db.query.users.findFirst({ orderBy: asc(users.id), columns: { id: true, locale: true } });
  if (first && isLocale(first.locale)) {
    setSystemLocale(first.locale);
    userLocales.set(first.id, first.locale);
  }
}

/** 用户改了语言：更新缓存，第一个用户的语言同时也是系统语言 */
export async function rememberUserLocale(userId: number, locale: Locale) {
  userLocales.set(userId, locale);
  const first = await db.query.users.findFirst({ orderBy: asc(users.id), columns: { id: true } });
  if (first?.id === userId) setSystemLocale(locale);
}

export async function userLocale(userId: number): Promise<Locale> {
  let l = userLocales.get(userId);
  if (!l) {
    const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { locale: true } });
    l = isLocale(u?.locale) ? u.locale : getSystemLocale();
    userLocales.set(userId, l);
  }
  return l;
}

/**
 * 每个请求的语言：x-damail-locale 请求头（网页带上当前界面语言）> 登录用户保存的语言（认证中间件里补上）
 * > 浏览器 Accept-Language > 系统语言
 */
export const localeMiddleware: MiddlewareHandler = (c, next) => {
  const header = normalizeLocale(c.req.header('x-damail-locale'));
  const locale = header ?? fromAcceptLanguage(c.req.header('accept-language')) ?? getSystemLocale();
  return als.run({ locale, explicit: Boolean(header) }, next);
};

/** 认证通过后：请求头没指定语言时，改用这个用户保存的语言（API Key、MCP、网页里的 EventSource 等） */
export async function adoptUserLocale(userId: number) {
  const store = als.getStore();
  if (store && !store.explicit) store.locale = await userLocale(userId);
}

/** 当前语言的文案 */
export const t = (locale: Locale = currentLocale()): Messages => MESSAGES[locale];

/** 各语言对应的 Intl 地区代码（日期、数字格式化用） */
const INTL_LOCALES: Record<Locale, string> = { 'zh-CN': 'zh-CN', en: 'en-US' };
export const intlLocale = (locale: Locale = currentLocale()) => INTL_LOCALES[locale];

/** 当前语言下的日期时间格式化 */
export const dateTimeFormat = (d: Date, opts: Intl.DateTimeFormatOptions = {}, locale: Locale = currentLocale()) =>
  d.toLocaleString(intlLocale(locale), { hour12: false, ...opts });
