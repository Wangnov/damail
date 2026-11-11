import { AsyncLocalStorage } from 'node:async_hooks';

// 语言上下文单独放：不依赖数据库，config 这类底层模块也能用 L()

/** 支持的语言：加新语言从这里开始，类型、校验、按语言存的内容都由它推导 */
export const LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'zh-CN';
/** 某种语言的内容缺失时，先退回英文，再退回任意一种 */
export const FALLBACK_LOCALE: Locale = 'en';

/** 按语言存的内容（数据库里的 i18n 字段） */
export type I18n<T> = Partial<Record<Locale, T>>;

/** 取某种语言的内容：没有就退回英文、默认语言，再没有就取任意一种 */
export function pickLocale<T>(map: I18n<T> | null | undefined, locale: Locale = currentLocale()): T | undefined {
  if (!map) return undefined;
  const has = (v: T | undefined) => v !== undefined && v !== null && (v as unknown) !== '';
  for (const l of [locale, FALLBACK_LOCALE, DEFAULT_LOCALE]) if (has(map[l])) return map[l];
  return Object.values(map).find((v) => has(v as T | undefined)) as T | undefined;
}

// 当前请求 / 任务用哪种语言；explicit 表示请求头里明确指定了（网页每次都会带）
export type Store = { locale: Locale; explicit: boolean };
export const als = new AsyncLocalStorage<Store>();

// 后台任务（同步、通知、定时报告、自动分析）没有请求上下文，用系统语言：第一个用户（管理员）的界面语言
let systemLocale: Locale = DEFAULT_LOCALE;
export const getSystemLocale = () => systemLocale;
export const setSystemLocale = (l: Locale) => {
  systemLocale = l;
};

export const currentLocale = (): Locale => als.getStore()?.locale ?? systemLocale;

/** 在指定语言下运行（后台任务按用户语言生成内容时用） */
export const withLocale = <T>(locale: Locale, fn: () => T): T => als.run({ locale, explicit: true }, fn);

/**
 * 零散的一句话（接口错误、工具说明）直接写两种语言：L('中文', 'English')。
 * 在模块顶层用时要包在函数里（例如 zod 的 { error: () => L(...) }），否则只会取启动时的语言
 */
export const L = (zh: string, en: string) => (currentLocale() === 'en' ? en : zh);
