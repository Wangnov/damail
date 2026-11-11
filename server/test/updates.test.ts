/**
 * 检查新版本（services/updates.ts）：GitHub 请求用注入的假接口，不访问外网。
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Browser, PASSWORD, setup, type Env } from './helpers.js';

let env: Env;
let mod: typeof import('../src/services/updates.js');
let clock = 1_000_000_000_000;
let calls: { url: string; headers: Record<string, string> }[] = [];
let reply: () => { status: number; body?: unknown; headers?: Record<string, string> };

const release = (tag: string) => ({
  tag_name: tag,
  name: `DaMail ${tag}`,
  html_url: `https://github.com/o/r/releases/tag/${tag}`,
  published_at: '2026-11-12T00:00:00Z',
  body: '### 新增\n- 一条',
});

before(async () => {
  env = await setup();
  mod = await import('../src/services/updates.js');
  mod.updatesTesting.setNow(() => clock);
  mod.updatesTesting.setFetcher(async (url, init) => {
    calls.push({ url, headers: init.headers });
    const r = reply();
    return { status: r.status, headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null }, json: async () => r.body };
  });
});

after(async () => {
  mod.updatesTesting.setFetcher(null);
  mod.updatesTesting.setNow(null);
  await env.close();
});

beforeEach(() => {
  mod.updatesTesting.reset();
  calls = [];
});

describe('updateStatus', () => {
  test('读最新正式版本，6 小时内用缓存，过期后带 ETag 条件请求', async () => {
    reply = () => ({ status: 200, body: release('v0.2.0'), headers: { etag: 'W/"abc"' } });
    const s = await mod.updateStatus();
    assert.equal(s.enabled, true);
    assert.equal(s.latest?.tag, 'v0.2.0');
    assert.equal(s.latest?.body, '### 新增\n- 一条');
    assert.equal(s.error, null);
    assert.match(calls[0]!.url, /\/repos\/gopkg-dev\/damail\/releases\/latest$/);
    assert.equal(calls[0]!.headers['If-None-Match'], undefined);

    clock += 5 * 3600_000;
    await mod.updateStatus();
    assert.equal(calls.length, 1, '缓存期内不再请求');

    clock += 2 * 3600_000;
    reply = () => ({ status: 304 });
    const s2 = await mod.updateStatus();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.headers['If-None-Match'], 'W/"abc"');
    assert.equal(s2.latest?.tag, 'v0.2.0', '304 时沿用上次结果');
  });

  test('手动检查更新：距上次超过 1 分钟才重新请求', async () => {
    reply = () => ({ status: 200, body: release('v0.2.0') });
    await mod.updateStatus();
    await mod.updateStatus({ refresh: true });
    assert.equal(calls.length, 1);
    clock += 61_000;
    reply = () => ({ status: 200, body: release('v0.3.0') });
    assert.equal((await mod.updateStatus({ refresh: true })).latest?.tag, 'v0.3.0');
  });

  test('还没有 Release 时返回空；出错时保留上次结果，30 分钟后重试', async () => {
    reply = () => ({ status: 404 });
    assert.equal((await mod.updateStatus()).latest, null);

    clock += 7 * 3600_000;
    reply = () => ({ status: 200, body: release('v0.2.0') });
    await mod.updateStatus();

    clock += 7 * 3600_000;
    reply = () => ({ status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    const s = await mod.updateStatus();
    assert.equal(s.latest?.tag, 'v0.2.0');
    assert.ok(s.error);

    const n = calls.length;
    clock += 10 * 60_000;
    await mod.updateStatus();
    assert.equal(calls.length, n, '失败后 30 分钟内不重试');
    clock += 21 * 60_000;
    reply = () => ({ status: 200, body: release('v0.2.1') });
    const s2 = await mod.updateStatus();
    assert.equal(s2.latest?.tag, 'v0.2.1');
    assert.equal(s2.error, null);
  });

  test('同时多次请求只查一次', async () => {
    reply = () => ({ status: 200, body: release('v0.2.0') });
    await Promise.all([mod.updateStatus(), mod.updateStatus(), mod.updateStatus()]);
    assert.equal(calls.length, 1);
  });

  test('接口需要登录', async () => {
    reply = () => ({ status: 200, body: release('v0.2.0') });
    const anon = await fetch(`${env.base}/api/admin/updates`);
    assert.equal(anon.status, 401);
    const web = new Browser(env.base);
    const login = await web.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const res = await web.request('/api/admin/updates');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { latest: { tag: string } };
    assert.equal(body.latest.tag, 'v0.2.0');
  });
});
