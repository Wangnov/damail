import { useSyncExternalStore } from 'react';
import { t } from '../i18n';

/**
 * 外观：跟随系统 / 浅色 / 深色，以及主题色、圆角、边框、组件大小。选择存在本机浏览器里（每台设备单独设置）。
 * 实际生效的明暗写到 <html data-theme>，styles.css 里的深色样式按它切换；
 * index.html 在加载脚本前先按同样的规则设置一次，避免刷新时先闪一下浅色。
 */
export type ThemeMode = 'system' | 'light' | 'dark';

export const themeLabel = (mode: ThemeMode) => t.appearance.modes[mode];

const KEY = 'damail.theme';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let mode = readMode();

const isDark = () => mode === 'dark' || (mode === 'system' && darkQuery.matches);

function apply() {
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  listeners.forEach((l) => l());
}

apply();
darkQuery.addEventListener('change', () => mode === 'system' && apply());
// 其他标签页改了外观，这里跟着变
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  mode = readMode();
  apply();
});

export function setThemeMode(next: ThemeMode) {
  mode = next;
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // 无痕模式存不了，只在本次打开期间生效
  }
  apply();
}

const subscribe = (cb: () => void) => (listeners.add(cb), () => listeners.delete(cb));

/** 用户选的外观（可能是跟随系统） */
export const useThemeMode = () => useSyncExternalStore(subscribe, () => mode);

/** 实际生效的是不是深色 */
export const useDarkMode = () => useSyncExternalStore(subscribe, isDark);

// ---- 主题色 ----

/** 预设的主题色；也可以自定义任意颜色 */
export const ACCENTS = [
  { key: 'blue', color: '#1677ff' },
  { key: 'indigo', color: '#4f46e5' },
  { key: 'purple', color: '#7c3aed' },
  { key: 'pink', color: '#db2777' },
  { key: 'orange', color: '#ea580c' },
  { key: 'green', color: '#16a34a' },
  { key: 'cyan', color: '#0891b2' },
  { key: 'slate', color: '#475569' },
] as const;

export const DEFAULT_ACCENT = ACCENTS[0].color;
const ACCENT_KEY = 'damail.accent';
const isHex = (v: string | null): v is string => !!v && /^#[0-9a-f]{6}$/i.test(v);

function readAccent() {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    return isHex(v) ? v.toLowerCase() : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

let accent = readAccent();
const accentListeners = new Set<() => void>();

/** 主题色也写到 CSS 变量 --mh-accent，样式表里 Logo 渐变、按钮阴影等用它 */
function applyAccent() {
  document.documentElement.style.setProperty('--mh-accent', accent);
  accentListeners.forEach((l) => l());
}

applyAccent();
window.addEventListener('storage', (e) => {
  if (e.key !== ACCENT_KEY) return;
  accent = readAccent();
  applyAccent();
});

export function setAccent(next: string) {
  if (!isHex(next)) return;
  accent = next.toLowerCase();
  try {
    if (accent === DEFAULT_ACCENT) localStorage.removeItem(ACCENT_KEY);
    else localStorage.setItem(ACCENT_KEY, accent);
  } catch {
    // 无痕模式存不了，只在本次打开期间生效
  }
  applyAccent();
}

/** 当前主题色（#rrggbb） */
export const useAccent = () =>
  useSyncExternalStore(
    (cb) => (accentListeners.add(cb), () => accentListeners.delete(cb)),
    () => accent,
  );

/** 预设里的名字，自定义颜色返回「自定义」 */
export const accentLabel = (color: string) => {
  const preset = ACCENTS.find((a) => a.color === color);
  return preset ? t.appearance.accents[preset.key] : t.appearance.customColor;
};

// ---- 圆角、边框 ----

/** 一个存在本机的枚举选项：读写 localStorage、应用到页面、通知订阅者 */
function createPref<T extends string>(key: string, values: readonly T[], fallback: T, apply: (v: T) => void) {
  const read = (): T => {
    try {
      const v = localStorage.getItem(key);
      return values.includes(v as T) ? (v as T) : fallback;
    } catch {
      return fallback;
    }
  };
  let value = read();
  const subs = new Set<() => void>();
  const run = () => {
    apply(value);
    subs.forEach((l) => l());
  };
  run();
  window.addEventListener('storage', (e) => {
    if (e.key !== key) return;
    value = read();
    run();
  });
  return {
    set(next: T) {
      value = next;
      try {
        if (next === fallback) localStorage.removeItem(key);
        else localStorage.setItem(key, next);
      } catch {
        // 无痕模式存不了，只在本次打开期间生效
      }
      run();
    },
    use: () =>
      useSyncExternalStore(
        (cb) => (subs.add(cb), () => subs.delete(cb)),
        () => value,
      ),
  };
}

export type RadiusKey = 'none' | 'small' | 'medium' | 'large';
/** 圆角：antd 的基础圆角和样式表里的圆角（--mh-r）都按这个系数缩放 */
export const RADIUS: Record<RadiusKey, { scale: number }> = {
  none: { scale: 0 },
  small: { scale: 0.6 },
  medium: { scale: 1 },
  large: { scale: 1.4 },
};
const radiusPref = createPref<RadiusKey>('damail.radius', ['none', 'small', 'medium', 'large'], 'medium', (v) =>
  document.documentElement.style.setProperty('--mh-r', String(RADIUS[v].scale)),
);
export const setRadius = radiusPref.set;
export const useRadius = radiusPref.use;

export type BorderKey = 'soft' | 'normal' | 'strong';
export const BORDER_KEYS: BorderKey[] = ['soft', 'normal', 'strong'];
/** 边框深浅：antd 的边框色写在 main.tsx 的主题里，外壳的描边按 <html data-border> 切换 */
const borderPref = createPref<BorderKey>('damail.border', ['soft', 'normal', 'strong'], 'normal', (v) => {
  document.documentElement.dataset.border = v;
});
export const setBorder = borderPref.set;
export const useBorder = borderPref.use;

/** 各档边框色（边框 / 次级边框 / 分割线）；标准档用 antd 算法算出的默认值 */
export const BORDER_TOKENS: Record<'light' | 'dark', Partial<Record<BorderKey, { colorBorder: string; colorBorderSecondary: string; colorSplit: string }>>> = {
  light: {
    soft: { colorBorder: '#e6e6e6', colorBorderSecondary: '#f5f5f5', colorSplit: 'rgba(5, 5, 5, 0.04)' },
    strong: { colorBorder: '#bfbfbf', colorBorderSecondary: '#e1e1e1', colorSplit: 'rgba(5, 5, 5, 0.12)' },
  },
  dark: {
    soft: { colorBorder: '#363636', colorBorderSecondary: '#262626', colorSplit: 'rgba(253, 253, 253, 0.07)' },
    strong: { colorBorder: '#5a5a5a', colorBorderSecondary: '#434343', colorSplit: 'rgba(253, 253, 253, 0.18)' },
  },
};

// ---- 组件大小 ----

export type SizeKey = 'small' | 'middle' | 'large';
export const SIZE_KEYS: SizeKey[] = ['small', 'middle', 'large'];
/** 组件大小：交给 antd 的 componentSize，按钮、输入框、表格等一起变；代码里单独指定了尺寸的不受影响 */
// 同时写到 <html data-size>，样式表里自己写了高度的按钮（如「写邮件」）按它切换
const sizePref = createPref<SizeKey>('damail.size', ['small', 'middle', 'large'], 'middle', (v) => {
  document.documentElement.dataset.size = v;
});
export const setComponentSize = sizePref.set;
export const useComponentSize = sizePref.use;

// ---- 玻璃效果、动画 ----

/** 玻璃效果：关掉后面板改成实心底色、外壳去掉彩色光斑，不再做背景模糊（老机器上更省电） */
const glassPref = createPref<'on' | 'off'>('damail.glass', ['on', 'off'], 'on', (v) => {
  document.documentElement.dataset.glass = v;
});
export const setGlass = (on: boolean) => glassPref.set(on ? 'on' : 'off');
export const useGlass = () => glassPref.use() === 'on';

/** 动画：关掉后页面切换、面板展开、弹窗等都不做过渡；系统设置了「减少动态效果」时本来就不做 */
const motionPref = createPref<'on' | 'off'>('damail.motion', ['on', 'off'], 'on', (v) => {
  document.documentElement.dataset.motion = v;
});
export const setMotion = (on: boolean) => motionPref.set(on ? 'on' : 'off');
export const useMotion = () => motionPref.use() === 'on';
