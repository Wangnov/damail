/**
 * AI 渠道并发上限和限流暂停（services/ai-limit.ts、trackAi）。不调用真实模型。
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setup, type Env } from './helpers.js';

let env: Env;
let limit: typeof import('../src/services/ai-limit.js');
let usage: typeof import('../src/services/ai-usage.js');

before(async () => {
  env = await setup();
  limit = await import('../src/services/ai-limit.js');
  usage = await import('../src/services/ai-usage.js');
});

after(async () => {
  await env?.close();
});

beforeEach(() => limit.resetAiGates());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const channel = (concurrency: number | null) => ({ channelId: 'c1', channelName: 'test', provider: 'openai' as const, model: 'm', price: null, concurrency });

describe('并发上限', () => {
  test('同一渠道同时最多 N 个请求，其余排队；不同渠道互不影响', async () => {
    let active = 0;
    let peak = 0;
    const call = (c: ReturnType<typeof channel>) =>
      usage.trackAi(c, 'test', async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(30);
        active--;
        return 1;
      });
    await Promise.all(Array.from({ length: 6 }, () => call(channel(2))));
    assert.equal(peak, 2);

    peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => call(channel(null))));
    assert.equal(peak, 6, '没设上限时，默认上限以内全部同时进行');

    peak = 0;
    await Promise.all(Array.from({ length: limit.DEFAULT_AI_CONCURRENCY + 5 }, () => call(channel(null))));
    assert.equal(peak, limit.DEFAULT_AI_CONCURRENCY, '没设上限也不能无限并发');

    const other = { ...channel(1), channelId: 'c2' };
    const release = await limit.acquireAiSlot(other);
    const t0 = Date.now();
    await call(channel(1));
    assert.ok(Date.now() - t0 < 200, '别的渠道占满不影响这个渠道');
    release();
  });

  test('排队已满时直接拒绝，错误可重试', async () => {
    const { RetryableError } = await import('../src/services/jobs.js');
    const release = await limit.acquireAiSlot(channel(1));
    const ac = new AbortController();
    const waiting = Array.from({ length: 200 }, () => limit.acquireAiSlot(channel(1), ac.signal).then((r) => r(), () => {}));
    await assert.rejects(limit.acquireAiSlot(channel(1)), (err: unknown) => err instanceof limit.AiQueueFullError && err instanceof RetryableError);
    ac.abort();
    await Promise.all(waiting);
    release();
  });

  test('中止时退出排队', async () => {
    const release = await limit.acquireAiSlot(channel(1));
    const ac = new AbortController();
    const waiting = limit.acquireAiSlot(channel(1), ac.signal);
    await sleep(10);
    assert.equal(limit.aiGateState('c1')?.waiting, 1);
    ac.abort();
    await assert.rejects(waiting);
    assert.equal(limit.aiGateState('c1')?.waiting, 0);
    release();
    assert.equal(limit.aiGateState('c1')?.active, 0);
  });
});

describe('限流', () => {
  test('429 后整个渠道暂停（按 Retry-After），暂停结束自动重试成功', async () => {
    let calls = 0;
    const t0 = Date.now();
    const out = await usage.trackAi(channel(null), 'test', async () => {
      calls++;
      if (calls === 1) throw new limit.RateLimitError('429', 150);
      return 'ok';
    });
    assert.equal(out, 'ok');
    assert.equal(calls, 2);
    assert.ok(Date.now() - t0 >= 140, `要等 Retry-After 再重试：${Date.now() - t0}ms`);
  });

  test('暂停期间同渠道的其他请求也等着，不再打到服务商', async () => {
    limit.noteRateLimited('c1', 120);
    const st = limit.aiChannelStatus().c1!;
    assert.ok(st.pausedUntil && st.limitedAt && st.limitedCount === 1, '状态里要有暂停结束时间和限流次数');
    const t0 = Date.now();
    await usage.trackAi(channel(null), 'test', async () => 1);
    assert.ok(Date.now() - t0 >= 110, '暂停期间的请求要等');
  });

  test('一直被限流：重试几次后报错；其他错误不重试', async () => {
    let calls = 0;
    await assert.rejects(
      usage.trackAi(channel(null), 'test', async () => {
        calls++;
        throw new limit.RateLimitError('429', 10);
      }),
      limit.RateLimitError,
    );
    assert.equal(calls, 3);
    calls = 0;
    await assert.rejects(
      usage.trackAi(channel(null), 'test', async () => {
        calls++;
        throw new Error('bad request');
      }),
    );
    assert.equal(calls, 1);
  });

  test('Retry-After：秒数和日期', () => {
    assert.equal(limit.parseRetryAfter('3'), 3000);
    assert.equal(limit.parseRetryAfter(null), undefined);
    assert.equal(limit.parseRetryAfter('abc'), undefined);
    const ms = limit.parseRetryAfter(new Date(Date.now() + 5000).toUTCString())!;
    assert.ok(ms > 3000 && ms <= 5000, String(ms));
  });
});

describe('任务推迟', () => {
  test('AI 排队已满推迟任务，不消耗重试次数', async () => {
    const jobsMod = await import('../src/services/jobs.js');
    const { eq } = await import('drizzle-orm');
    let calls = 0;
    jobsMod.registerJob(
      'test_defer',
      async () => {
        calls++;
        throw new limit.AiQueueFullError('queue full');
      },
      1,
    );
    await jobsMod.enqueue('test_defer', {});
    await jobsMod.startJobs();
    try {
      for (let i = 0; i < 100 && calls === 0; i++) await sleep(50);
      await sleep(100);
      const job = await env.db.query.jobs.findFirst({ where: (j, { eq }) => eq(j.type, 'test_defer') });
      assert.equal(calls, 1);
      assert.equal(job!.status, 'queued', '推迟后重新排队，不判失败');
      assert.equal(job!.attempts, 0, '不消耗重试次数');
      assert.ok(job!.runAt.getTime() > Date.now() + 20_000, '推迟一段时间再跑');
      await env.db.delete(env.schema.jobs).where(eq(env.schema.jobs.id, job!.id));
    } finally {
      jobsMod.stopJobs();
    }
  });
});
