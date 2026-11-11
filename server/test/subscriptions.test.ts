/**
 * 订阅列表（services/subscriptions.ts querySubscriptions）：筛选、计数、分页在数据库里做。不访问外网、不发邮件。
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { setup, type Env } from './helpers.js';

let env: Env;
let subs: typeof import('../src/services/subscriptions.js');

before(async () => {
  env = await setup();
  subs = await import('../src/services/subscriptions.js');
  const { db, schema } = env;
  const acc = env.accounts.work.id;
  const folder = (await db.select().from(schema.folders).where(eq(schema.folders.accountId, acc)))[0]!;
  let uid = 9000;
  // 发件人 → [封数, 已读封数]
  const senders: Record<string, [number, number]> = {
    ignored: [5, 0], // 很少打开
    read: [4, 4], // 经常看
    few: [2, 0], // 太少，不算很少打开
    unsub: [3, 0], // 已退订
    failed: [3, 0], // 退订失败，仍算很少打开
  };
  // 每个发件人的邮件时间错开：越靠前的发件人越新
  for (const [idx, [name, [n, seen]]] of Object.entries(senders).entries()) {
    for (let i = 0; i < n; i++) {
      uid++;
      await db.insert(schema.messages).values({
        accountId: acc,
        folderId: folder.id,
        uid,
        threadId: `sub-${name}-${i}`,
        messageId: `<sub-${uid}@local.test>`,
        subject: `${name} ${i}`,
        fromAddress: `${name}@news.example`,
        textBody: 'x',
        seen: i < seen,
        listInfo: { id: `list-${name}`, http: `https://news.example/u/${name}` },
        date: new Date(Date.now() - (idx * 10 + i + 1) * 3600_000),
      });
    }
  }
  await db.insert(schema.unsubscriptions).values([
    { accountId: acc, listKey: 'list-unsub', method: 'one-click', status: 'done' },
    { accountId: acc, listKey: 'list-failed', method: 'one-click', status: 'failed' },
  ]);
});

after(async () => {
  await env?.close();
});

describe('订阅列表', () => {
  test('计数和筛选：已退订看退订记录（失败的不算），很少打开 = 没退订、至少 3 封、打开率低于 20%', async () => {
    const scope = { accountIds: [env.accounts.work.id] };
    const all = await subs.querySubscriptions(scope, {});
    assert.deepEqual(all.counts, { all: 5, ignored: 2, unsubscribed: 1 });
    assert.equal(all.total, 5);
    assert.deepEqual(
      all.items.map((r) => r.listKey),
      ['list-ignored', 'list-read', 'list-unsub', 'list-failed', 'list-few'],
      '按封数、最近一封排序',
    );
    const ignored = await subs.querySubscriptions(scope, { filter: 'ignored' });
    assert.deepEqual(ignored.items.map((r) => r.listKey).sort(), ['list-failed', 'list-ignored']);
    assert.equal(ignored.total, 2);
    const unsub = await subs.querySubscriptions(scope, { filter: 'unsubscribed' });
    assert.deepEqual(
      unsub.items.map((r) => [r.listKey, r.unsubscribed?.status]),
      [['list-unsub', 'done']],
    );
    assert.deepEqual(await subs.querySubscriptions({ accountIds: [env.accounts.home.id] }, {}), {
      items: [],
      total: 0,
      counts: { all: 0, ignored: 0, unsubscribed: 0 },
    });
  });

  test('分页：每页 2 个，第 3 页只剩 1 个；超出范围是空页但计数照旧', async () => {
    const scope = { accountIds: [env.accounts.work.id] };
    const keys = async (offset: number) => (await subs.querySubscriptions(scope, { offset, limit: 2 })).items.map((r) => r.listKey);
    assert.deepEqual([...(await keys(0)), ...(await keys(2)), ...(await keys(4))], ['list-ignored', 'list-read', 'list-unsub', 'list-failed', 'list-few']);
    const empty = await subs.querySubscriptions(scope, { offset: 10, limit: 2 });
    assert.deepEqual([empty.items.length, empty.total, empty.counts.all], [0, 5, 5]);
  });

  test('排序：按打开率、最近一封，升序 / 降序', async () => {
    const scope = { accountIds: [env.accounts.work.id] };
    const keys = async (sort: 'openRate' | 'lastDate', order: 'asc' | 'desc') =>
      (await subs.querySubscriptions(scope, { sort, order })).items.map((r) => r.listKey);
    assert.equal((await keys('openRate', 'desc'))[0], 'list-read', '打开率最高的在前');
    assert.equal((await keys('openRate', 'asc')).at(-1), 'list-read');
    assert.deepEqual(await keys('lastDate', 'desc'), ['list-ignored', 'list-read', 'list-few', 'list-unsub', 'list-failed'], '最近一封越新越靠前');
    assert.deepEqual(await keys('lastDate', 'asc'), ['list-failed', 'list-unsub', 'list-few', 'list-read', 'list-ignored']);
  });

  test('接口：带 page 返回分页结构，不带 page 照旧返回数组', async () => {
    const headers = { authorization: `Bearer ${env.apiKey.value}` };
    const paged = await fetch(`${env.base}/api/v1/subscriptions?page=2&pageSize=2&filter=all`, { headers });
    assert.equal(paged.status, 200);
    const body = (await paged.json()) as { items: { listKey: string }[]; total: number; counts: { all: number } };
    assert.deepEqual([body.items.map((r) => r.listKey), body.total, body.counts.all], [['list-unsub', 'list-failed'], 5, 5]);
    const legacy = (await (await fetch(`${env.base}/api/v1/subscriptions`, { headers })).json()) as unknown[];
    assert.ok(Array.isArray(legacy) && legacy.length === 5, '不带 page 时返回全部（数组）');
  });
});
