/**
 * 账户异常通知去重（sync/status.ts 的 StatusReporter）。只统计排进队列的 notify 任务，不真正投递。
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { setup, type Env } from './helpers.js';

let env: Env;
let status: typeof import('../src/sync/status.js');
let channelId: number;

before(async () => {
  env = await setup();
  status = await import('../src/sync/status.js');
  const { encryptChannelConfig } = await import('../src/services/notify.js');
  const [ch] = await env.db
    .insert(env.schema.channels)
    .values({
      name: 'test',
      type: 'dingtalk',
      configEnc: encryptChannelConfig({ webhook: 'http://127.0.0.1:9/robot' }),
      events: ['account.error'],
    })
    .returning();
  channelId = ch!.id;
});

after(async () => {
  await env?.close();
});

beforeEach(async () => {
  await env.db.delete(env.schema.jobs).where(eq(env.schema.jobs.type, 'notify'));
});

/** emitEvent 是异步发出的，等它把任务写进队列 */
async function alerts() {
  await new Promise((r) => setTimeout(r, 100));
  const rows = await env.db
    .select({ n: sql<number>`count(*)::int` })
    .from(env.schema.jobs)
    .where(and(eq(env.schema.jobs.type, 'notify'), sql`${env.schema.jobs.payload}->'notice'->>'event' = 'account.error'`, sql`(${env.schema.jobs.payload}->>'channelId')::int = ${channelId}`));
  return rows[0]!.n;
}

describe('账户异常通知', () => {
  test('持续失败时重试经过 connecting / syncing，也只通知一次', async () => {
    const r = new status.StatusReporter(env.accounts.work.id);
    for (let i = 0; i < 4; i++) {
      await r.set('connecting');
      await r.set('error', 'IMAP 登录失败');
      await r.set('syncing');
      await r.set('error', 'Graph 返回 500');
    }
    assert.equal(await alerts(), 1);
  });

  test('失败和恢复来回切换时，冷却期内不重复通知', async () => {
    const r = new status.StatusReporter(env.accounts.work.id);
    for (let i = 0; i < 3; i++) {
      await r.set('syncing');
      await r.set('error', '全量同步失败');
      await r.set('idle');
    }
    assert.equal(await alerts(), 1);
  });

  test('恢复后过了冷却期再失败，会再次通知', async () => {
    const r = new status.StatusReporter(env.accounts.work.id);
    await r.set('error', '第一次');
    await r.set('idle');
    r.lastAlertAt -= status.ERROR_ALERT_COOLDOWN_MS;
    await r.set('error', '第二次');
    assert.equal(await alerts(), 2);
  });

  test('冷却期过了但一直没恢复，不再通知', async () => {
    const r = new status.StatusReporter(env.accounts.work.id);
    await r.set('error', '第一次');
    r.lastAlertAt -= status.ERROR_ALERT_COOLDOWN_MS;
    await r.set('connecting');
    await r.set('error', '还是失败');
    assert.equal(await alerts(), 1);
  });
});
