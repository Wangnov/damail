import ai from './ai.js';
import audit from './audit.js';
import common from './common.js';

// 每个文件导出同一结构的 { zh, en }，英文按中文的类型检查，漏翻或参数不一致会编译失败
const NAMESPACES = { ai, audit, common };

type Namespaces = typeof NAMESPACES;
export type Messages = { [K in keyof Namespaces]: Namespaces[K]['zh'] };

const pick = (lang: 'zh' | 'en') => Object.fromEntries(Object.entries(NAMESPACES).map(([k, v]) => [k, v[lang]])) as Messages;

export const MESSAGES: Record<import('../context.js').Locale, Messages> = { 'zh-CN': pick('zh'), en: pick('en') };
