/**
 * 系统内置的分类和提示词（docs/labels.md 第二版）：代码里定义，启动时同步到数据库，只读，多语言。
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Browser, PASSWORD, setup, type Env } from './helpers.js';

let env: Env;
let web: Browser;
let catalog: typeof import('../src/services/catalog.js');
let i18n: typeof import('../src/i18n/index.js');

before(async () => {
  env = await setup();
  catalog = await import('../src/services/catalog.js');
  i18n = await import('../src/i18n/index.js');
  web = new Browser(env.base);
  const res = await web.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: PASSWORD }),
  });
  assert.equal(res.status, 200);
});

after(async () => {
  await env?.close();
});

const get = (path: string, locale?: string) => web.request(path, { headers: { 'x-damail': '1', ...(locale ? { 'x-damail-locale': locale } : {}) } });

describe('同步', () => {
  test('启动时写入数据库；被改过的内置内容以代码为准覆盖，代码里没有的内置行删掉', async () => {
    const { db, schema } = env;
    const { eq } = await import('drizzle-orm');
    assert.equal(await db.$count(schema.categories), catalog.CATEGORIES.length);
    await db
      .update(schema.categories)
      .set({ i18n: { 'zh-CN': { name: '被改了', description: 'x' } } })
      .where(eq(schema.categories.key, 'work'));
    await db
      .update(schema.prompts)
      .set({ text: { en: 'tampered' } })
      .where(eq(schema.prompts.key, 'classify'));
    await db.insert(schema.categories).values({ key: 'gone', i18n: { en: { name: 'Gone', description: 'x' } }, color: 'red', position: 99, builtin: true });
    await db
      .insert(schema.prompts)
      .values({ key: 'gone', purpose: 'x', title: { en: 'x' }, description: {}, vars: [], text: { en: 'x' }, position: 99, builtin: true });
    await catalog.syncBuiltins();
    const work = await db.query.categories.findFirst({ where: (c, { eq }) => eq(c.key, 'work') });
    assert.equal(work!.i18n['zh-CN']!.name, '工作');
    assert.ok(!catalog.prompt('classify', {}, 'en').includes('tampered'), '提示词要恢复成代码里的');
    assert.equal(await db.$count(schema.categories, eq(schema.categories.key, 'gone')), 0);
    assert.equal(await db.$count(schema.prompts, eq(schema.prompts.key, 'gone')), 0);
  });

  test('每个内置提示词、分类都有所有语言', () => {
    for (const c of catalog.listCategories()) for (const l of i18n.LOCALES) assert.ok(c.i18n[l]?.name && c.i18n[l]?.description, `${c.key} 缺 ${l}`);
    for (const p of catalog.listPrompts()) for (const l of i18n.LOCALES) assert.ok((p.text as Record<string, string>)[l], `${p.key} 缺 ${l}`);
  });
});

describe('取用', () => {
  test('提示词：按语言取，替换变量，未知变量原样保留', () => {
    const zh = catalog.prompt('classify', { categories: '- a：b' }, 'zh-CN');
    const en = catalog.prompt('classify', { categories: '- a: b' }, 'en');
    assert.ok(zh.includes('- a：b') && !zh.includes('{{categories}}'), '中文提示词要替换变量');
    assert.ok(en.includes('- a: b') && !/[一-鿿]/.test(en), '英文提示词不夹中文');
    assert.ok(catalog.prompt('classify', {}, 'en').includes('{{categories}}'), '没传的变量原样保留');
    assert.throws(() => catalog.prompt('nope'));
  });

  test('语言回退：当前语言 → 英文 → 中文 → 任意一种', () => {
    const pick = i18n.pickLocale;
    assert.equal(pick({ 'zh-CN': '中', en: 'en' }, 'zh-CN'), '中');
    assert.equal(pick({ 'zh-CN': '中', en: 'en' }, 'fr' as never), 'en');
    assert.equal(pick({ 'zh-CN': '中' }, 'en'), '中');
    assert.equal(pick({ 'zh-CN': '', en: 'en' }, 'zh-CN'), 'en');
    assert.equal(pick({}, 'en'), undefined);
  });

  test('分类名称跟着语言变', () => {
    assert.equal(catalog.categoryName('finance', 'zh-CN'), '账单财务');
    assert.equal(catalog.categoryName('finance', 'en'), 'Bills & finance');
    assert.equal(catalog.categoryName('unknown', 'en'), 'unknown');
    assert.ok(catalog.categoryLines('en').startsWith('- important: Key mail'), catalog.categoryLines('en'));
  });
});

describe('接口', () => {
  test('GET /api/v1/categories：按界面语言返回名称，带所有语言和只读标记', async () => {
    const en = (await (await get('/api/v1/categories', 'en')).json()) as { key: string; name: string; builtin: boolean; i18n: Record<string, unknown> }[];
    assert.deepEqual(
      en.map((c) => c.key),
      [...catalog.CATEGORIES],
    );
    assert.equal(en.find((c) => c.key === 'spam')!.name, 'Spam');
    assert.ok(
      en.every((c) => c.builtin && Object.keys(c.i18n).length === i18n.LOCALES.length),
      '都是内置、都有所有语言',
    );
    const zh = (await (await get('/api/v1/categories', 'zh-CN')).json()) as { key: string; name: string }[];
    assert.equal(zh.find((c) => c.key === 'spam')!.name, '垃圾');
  });

  test('GET /api/admin/prompts：只读列表；没有修改接口', async () => {
    const res = await get('/api/admin/prompts');
    assert.equal(res.status, 200);
    const list = (await res.json()) as { key: string; vars: string[]; text: Record<string, string> }[];
    assert.ok(
      list.some((p) => p.key === 'labels.suggest' && p.vars.includes('languages')),
      '要有标签推荐提示词',
    );
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await web.request('/api/admin/prompts/classify', { method, headers: { 'x-damail': '1', 'content-type': 'application/json' }, body: '{}' });
      assert.ok(r.status === 404 || r.status === 405, `${method} 不该能改：${r.status}`);
    }
    // 没登录不能看
    assert.equal((await fetch(`${env.base}/api/admin/prompts`)).status, 401);
  });
});
