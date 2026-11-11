/**
 * 系统内置的分类和提示词：代码里定义（src/catalog），服务启动时同步到数据库，之后从数据库读（缓存在内存里）。
 * 都是只读的；数据库里取不到时用代码里的定义兜底，不会因为数据缺失让 AI 功能不可用。
 */
import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { categories, prompts, type Category, type Prompt } from '../db/schema.js';
import { BUILTIN_CATEGORIES, type CategoryText } from '../catalog/categories.js';
import { BUILTIN_PROMPTS } from '../catalog/prompts.js';
import { currentLocale, pickLocale, type I18n, type Locale } from '../i18n/index.js';

export { CATEGORIES, type CategoryKey } from '../catalog/categories.js';

type CategoryRow = Pick<Category, 'key' | 'i18n' | 'color' | 'position' | 'builtin'>;
type PromptRow = Pick<Prompt, 'key' | 'purpose' | 'title' | 'description' | 'vars' | 'text' | 'position' | 'builtin'>;

const codeCategories: CategoryRow[] = BUILTIN_CATEGORIES.map((c, i) => ({ ...c, position: i, builtin: true }));
const codePrompts: PromptRow[] = BUILTIN_PROMPTS.map((p, i) => ({ ...p, position: i, builtin: true }));

let categoryCache: CategoryRow[] | null = null;
let promptCache: Map<string, PromptRow> | null = null;

/** 启动时：把代码里的内置内容写进数据库（以代码为准覆盖），删掉代码里已经没有的内置行，再读进缓存 */
export async function syncBuiltins() {
  await db.transaction(async (tx) => {
    for (const c of codeCategories)
      await tx
        .insert(categories)
        .values(c)
        .onConflictDoUpdate({
          target: categories.key,
          set: {
            ...c,
            updatedAt: sql`CASE WHEN ${categories.i18n} = ${JSON.stringify(c.i18n)}::jsonb AND ${categories.color} = ${c.color} THEN ${categories.updatedAt} ELSE now() END`,
          },
        });
    await tx.delete(categories).where(
      and(
        eq(categories.builtin, true),
        notInArray(
          categories.key,
          codeCategories.map((c) => c.key),
        ),
      ),
    );
    for (const p of codePrompts)
      await tx
        .insert(prompts)
        .values(p)
        .onConflictDoUpdate({
          target: prompts.key,
          set: { ...p, updatedAt: sql`CASE WHEN ${prompts.text} = ${JSON.stringify(p.text)}::jsonb THEN ${prompts.updatedAt} ELSE now() END` },
        });
    await tx.delete(prompts).where(
      and(
        eq(prompts.builtin, true),
        notInArray(
          prompts.key,
          codePrompts.map((p) => p.key),
        ),
      ),
    );
  });
  await loadCatalog();
}

export async function loadCatalog() {
  const [cats, ps] = await Promise.all([
    db.select().from(categories).orderBy(asc(categories.position)),
    db.select().from(prompts).orderBy(asc(prompts.position)),
  ]);
  categoryCache = cats.length ? cats : null;
  promptCache = ps.length ? new Map(ps.map((p) => [p.key, p])) : null;
}

// ---- 分类 ----

export function listCategories(): CategoryRow[] {
  return categoryCache ?? codeCategories;
}

function categoryText(key: string, locale?: Locale): CategoryText | undefined {
  const row = listCategories().find((c) => c.key === key) ?? codeCategories.find((c) => c.key === key);
  return pickLocale(row?.i18n, locale);
}

/** 分类名称（按当前语言）；不认识的 key 原样返回 */
export function categoryName(key: string, locale?: Locale) {
  return categoryText(key, locale)?.name ?? key;
}

/** 给 AI 的分类列表：「- key：说明」每行一个 */
export function categoryLines(locale?: Locale) {
  const sep = (locale ?? currentLocale()) === 'zh-CN' ? '：' : ': ';
  return listCategories()
    .map((c) => `- ${c.key}${sep}${pickLocale(c.i18n, locale)?.description ?? ''}`)
    .join('\n');
}

// ---- 提示词 ----

export function listPrompts(): PromptRow[] {
  return promptCache ? [...promptCache.values()] : codePrompts;
}

/** 按当前语言取提示词并替换 {{变量}}；缺这种语言时退回英文 */
export function prompt(key: string, vars: Record<string, string | number> = {}, locale?: Locale) {
  const row = promptCache?.get(key) ?? codePrompts.find((p) => p.key === key);
  if (!row) throw new Error(`Unknown prompt: ${key}`);
  const text = pickLocale(row.text as I18n<string>, locale) ?? '';
  return text.replace(/\{\{(\w+)\}\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** 测试用：清掉缓存，回到代码里的定义 */
export function resetCatalogCache() {
  categoryCache = null;
  promptCache = null;
}
