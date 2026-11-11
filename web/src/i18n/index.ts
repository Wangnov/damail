import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { useSyncExternalStore } from 'react';
import { MESSAGES, type Messages } from './messages';

/** 支持的语言：加新语言从这里开始 */
export const LOCALE_CODES = ['zh-CN', 'en'] as const;
export type Locale = (typeof LOCALE_CODES)[number];
/** 某种语言的内容缺失时先退回英文 */
export const FALLBACK_LOCALE: Locale = 'en';
export type { Messages };

/** 语言选择器里显示的名字，用各自的语言写 */
export const LOCALES: { value: Locale; label: string; short: string }[] = [
  { value: 'zh-CN', label: '简体中文', short: '中文' },
  { value: 'en', label: 'English', short: 'EN' },
];

const KEY = 'damail.locale';

export const isLocale = (v: unknown): v is Locale => (LOCALE_CODES as readonly unknown[]).includes(v);

/** 没选过语言时按浏览器语言：中文用简体中文，其他用英文 */
function detect(): Locale {
  try {
    const saved = localStorage.getItem(KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // 无痕模式读不了，按浏览器语言
  }
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

let locale: Locale = detect();

/**
 * 当前语言的文案。用法：`t.mail.reply`、`t.list.count(3)`。
 * 是会随切换语言更新的导出绑定，在组件渲染、事件处理里读都是最新的；
 * 不要在模块顶层把它的值存进常量（那样切换语言后不会变），需要的话写成函数。
 */
export let t: Messages = MESSAGES[locale];

const listeners = new Set<() => void>();

function apply(l: Locale) {
  dayjs.locale(l === 'zh-CN' ? 'zh-cn' : 'en');
  document.documentElement.lang = l;
}
apply(locale);

/** 切换界面语言（只改本机；要跟账号保存用 api 里的 saveLocale） */
export function setLocale(next: Locale) {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // 存不了就只在本次打开期间生效
  }
  if (next === locale) return;
  locale = next;
  t = MESSAGES[next];
  apply(next);
  listeners.forEach((l) => l());
}

export const getLocale = () => locale;

/** 按语言存的内容（接口返回的 i18n 字段） */
export type I18n<T> = Partial<Record<Locale, T>>;

/** 取当前语言的内容：没有就退回英文、简体中文，再没有就取任意一种 */
export function pickText<T>(map: I18n<T> | null | undefined, l: Locale = locale): T | undefined {
  if (!map) return undefined;
  const has = (v: T | undefined) => v !== undefined && v !== null && (v as unknown) !== '';
  for (const k of [l, FALLBACK_LOCALE, 'zh-CN' as Locale]) if (has(map[k])) return map[k];
  return Object.values(map).find((v) => has(v as T | undefined)) as T | undefined;
}

export function useLocale() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => locale,
  );
}

/** 当前语言的 Intl 地区代码（数字、日期格式化、排序用） */
export const intlLocale = () => (locale === 'zh-CN' ? 'zh-CN' : 'en-US');

// 其他标签页切换了语言，这里也跟着切
window.addEventListener('storage', (e) => {
  if (e.key === KEY && isLocale(e.newValue)) setLocale(e.newValue);
});
