/**
 * 审计日志：开放接口（API Key / MCP）每次调用都记录，网页后台记录写操作，敏感字段脱敏，
 * 只有网页登录态能查看，按保留天数清理。审计写入是异步的，断言前轮询等待。
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Browser, mcp, callTool, PASSWORD, setup, type Env } from './helpers.js';

let env: Env;
let web: Browser;
let auditMod: typeof import('../src/lib/audit.js');

type Row = {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  source: string | null;
  ip: string | null;
  userAgent: string | null;
  status: number | null;
  durationMs: number | null;
  detail: Record<string, unknown> | null;
  createdAt: Date;
};

async function rows(): Promise<Row[]> {
  const { asc } = await import('drizzle-orm');
  return (await env.db.select().from(env.schema.auditLogs).orderBy(asc(env.schema.auditLogs.id))) as Row[];
}

/** 等到满足条件的记录出现（审计写入不阻塞响应） */
async function waitRow(pred: (r: Row) => boolean, label: string): Promise<Row> {
  for (let i = 0; i < 50; i++) {
    const hit = (await rows()).find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`没有等到审计记录：${label}\n${JSON.stringify(await rows(), null, 2)}`);
}

/** 断言一段时间内没有新记录满足条件 */
async function noRow(pred: (r: Row) => boolean, since: number) {
  await new Promise((r) => setTimeout(r, 300));
  const hit = (await rows()).filter((r) => r.id > since).find(pred);
  assert.equal(hit, undefined, `不应该有这条记录：${JSON.stringify(hit)}`);
}

const lastId = async () => (await rows()).at(-1)?.id ?? 0;

function api(path: string, init: RequestInit = {}, key = env.apiKey.value) {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${key}`);
  headers.set('user-agent', 'audit-test/1.0');
  if (init.body) headers.set('content-type', 'application/json');
  return fetch(`${env.base}${path}`, { ...init, headers });
}

function admin(path: string, method: string, body?: unknown, b = web) {
  return b.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-damail': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

before(async () => {
  env = await setup();
  auditMod = await import('../src/lib/audit.js');
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

describe('登录', () => {
  test('登录成功、失败都记录，带 IP，不记密码', async () => {
    const ok = await waitRow((r) => r.action === 'auth.login' && r.actor === `user:${env.users.alice.id}`, '登录成功');
    assert.equal(ok.source, 'web');
    assert.ok(ok.ip);

    const res = await fetch(`${env.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'wrong-password' }),
    });
    assert.equal(res.status, 401);
    const failed = await waitRow((r) => r.action === 'auth.login_failed', '登录失败');
    assert.equal(failed.actor, 'anonymous');
    assert.equal(failed.status, 401);
    assert.deepEqual(failed.detail, { username: 'alice' });
    assert.doesNotMatch(JSON.stringify(await rows()), /wrong-password|correct horse/);
  });
});

describe('开放接口：REST', () => {
  test('API Key 的只读请求也记录：操作者、路由、状态码、耗时、IP、UA', async () => {
    const res = await api('/api/v1/accounts?limit=5');
    assert.equal(res.status, 200);
    const r = await waitRow((x) => x.action === 'GET /api/v1/accounts', 'GET accounts');
    assert.equal(r.actor, `key:${env.apiKey.row.id}`);
    assert.equal(r.source, 'api');
    assert.equal(r.status, 200);
    assert.equal(r.target, '/api/v1/accounts');
    assert.equal(r.userAgent, 'audit-test/1.0');
    assert.ok(r.ip);
    assert.ok(typeof r.durationMs === 'number');
    assert.deepEqual(r.detail, { query: { limit: '5' } });
  });

  test('被拒绝的请求也记录状态码和错误原因', async () => {
    // 测试密钥没有 organize 权限
    const res = await api('/api/v1/messages/batch', { method: 'POST', body: JSON.stringify({ ids: [env.messages.work.id], action: 'read' }) });
    assert.equal(res.status, 403);
    const r = await waitRow((x) => x.action === 'POST /api/v1/messages/batch' && x.actor.startsWith('key:'), '403');
    assert.equal(r.status, 403);
    assert.match(String(r.detail?.error), /organize/);
    assert.deepEqual((r.detail?.body as { action: string }).action, 'read');
  });

  test('无效的 API Key：记录为凭证无效', async () => {
    const res = await api('/api/v1/accounts', {}, 'dm_invalid_key_value_000000000000');
    assert.equal(res.status, 401);
    const r = await waitRow((x) => x.action === 'auth.token_invalid', '凭证无效');
    assert.equal(r.actor, 'anonymous');
    assert.equal(r.target, '/api/v1/accounts');
    assert.equal(r.source, 'api');
  });

  test('业务操作只记一条业务记录，补上状态码和来源', async () => {
    const res = await api('/api/v1/drafts', {
      method: 'POST',
      body: JSON.stringify({ accountId: env.accounts.work.id, to: [{ address: 'x@example.com' }], subject: 'audit', text: '机密正文' }),
    });
    assert.equal(res.status, 201, await res.clone().text());
    const r = await waitRow((x) => x.action === 'draft.create' && x.actor.startsWith('key:'), 'draft.create');
    assert.equal(r.source, 'api');
    assert.equal(r.status, 201);
    assert.ok(r.ip);
    await noRow((x) => x.action === 'POST /api/v1/drafts', r.id - 1);
  });
});

describe('开放接口：MCP', () => {
  test('每次工具调用记录工具名、参数和结果；协议消息（tools/list）不记录', async () => {
    const before = await lastId();
    const list = await mcp(env, env.apiKey.value, 'tools/list');
    assert.equal(list.status, 200);
    const call = await callTool(env, env.apiKey.value, 'search_emails', { query: 'work', limit: 3 });
    assert.equal(call.status, 200);
    const r = await waitRow((x) => x.action === 'mcp.call' && x.target === 'search_emails', 'search_emails');
    assert.equal(r.source, 'mcp');
    assert.equal(r.status, 200);
    assert.equal(r.actor, `key:${env.apiKey.row.id}`);
    assert.equal((r.detail?.args as { query: string }).query, 'work');
    const added = (await rows()).filter((x) => x.id > before);
    assert.equal(added.length, 1, JSON.stringify(added));
  });

  test('工具里的业务操作带上工具名，正文不进日志', async () => {
    const call = await callTool(env, env.apiKey.value, 'create_draft', {
      account_id: env.accounts.work.id,
      to: ['y@example.com'],
      subject: 'mcp',
      body: '很长的机密正文',
    });
    assert.equal(call.status, 200);
    assert.notEqual(call.json.result?.isError, true, JSON.stringify(call.json));
    const r = await waitRow((x) => x.action === 'draft.create' && x.source === 'mcp', 'mcp draft.create');
    assert.equal(r.detail?.tool, 'create_draft');
    assert.doesNotMatch(JSON.stringify(await rows()), /机密正文/);
  });

  test('调用没有权限（未注册）的工具也记录，标为失败', async () => {
    const call = await callTool(env, env.apiKey.value, 'mark_emails', { ids: [env.messages.work.id], action: 'read' });
    assert.equal(call.status, 200);
    const r = await waitRow((x) => x.action === 'mcp.call' && x.target === 'mark_emails', 'mark_emails');
    assert.equal(r.status, 400);
    assert.ok(r.detail?.error);
  });
});

describe('网页后台', () => {
  test('写操作记录，密码等敏感字段隐藏；只读请求不记录', async () => {
    const before = await lastId();
    assert.equal((await web.request('/api/admin/proxies')).status, 200);
    const res = await admin('/api/admin/proxies', 'POST', {
      name: 'p',
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      username: 'u',
      password: 'proxy-secret',
    });
    assert.equal(res.status, 201, await res.clone().text());
    const r = await waitRow((x) => x.action === 'POST /api/admin/proxies', '添加代理');
    assert.equal(r.source, 'web');
    assert.equal(r.actor, `user:${env.users.alice.id}`);
    assert.equal((r.detail?.body as { password: string }).password, '[已隐藏]');
    assert.doesNotMatch(JSON.stringify(await rows()), /proxy-secret/);
    await noRow((x) => x.action.startsWith('GET '), before);
  });

  test('网页上标记已读这类高频小操作不记录', async () => {
    const before = await lastId();
    // 用不存在的邮件 ID：不会去连测试邮箱（连接会一直挂着），只验证不记录
    const res = await admin('/api/v1/messages/batch', 'POST', { ids: [999999], action: 'read' });
    assert.ok(res.status < 500, String(res.status));
    await noRow(() => true, before);
  });
});

describe('查看与保留期限', () => {
  test('只有网页登录态能查看；列表带中文名称和操作者名称，可按来源、操作者筛选', async () => {
    assert.equal((await api('/api/admin/audit-logs')).status, 401);
    const res = await web.request(`/api/admin/audit-logs?source=api&actor=key:${env.apiKey.row.id}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { total: number; items: { source: string; actorLabel: string; actionLabel: string | null; action: string }[] };
    assert.ok(body.total >= 2);
    assert.ok(body.items.every((i) => i.source === 'api' && i.actorLabel === 'test'));
    assert.equal(body.items.find((i) => i.action === 'GET /api/v1/accounts')?.actionLabel, '查看邮箱列表');

    const mcpRes = await web.request('/api/admin/audit-logs?source=mcp&q=search_emails');
    const mcpBody = (await mcpRes.json()) as { items: { actionLabel: string }[] };
    assert.equal(mcpBody.items[0]?.actionLabel, '搜索邮件');

    const failed = (await (await web.request('/api/admin/audit-logs?failed=1')).json()) as { items: { status: number }[] };
    assert.ok(failed.items.length && failed.items.every((i) => i.status >= 400));
    const byResult = (await (await web.request('/api/admin/audit-logs?result=failed')).json()) as { items: { status: number }[] };
    assert.ok(byResult.items.length && byResult.items.every((i) => i.status >= 400));
    const ok = (await (await web.request('/api/admin/audit-logs?result=ok')).json()) as { items: { status: number | null }[] };
    assert.ok(ok.items.length && ok.items.every((i) => i.status !== null && i.status < 400));
  });

  test('按保留天数清理，0 表示永久保留', async () => {
    const [old] = await env.db
      .insert(env.schema.auditLogs)
      .values({ actor: 'system', action: 'test.old', createdAt: new Date(Date.now() - 40 * 86_400_000) })
      .returning();
    assert.equal((await admin('/api/admin/audit-logs/settings', 'PUT', { retentionDays: 3 })).status, 400);
    assert.equal((await admin('/api/admin/audit-logs/settings', 'PUT', { retentionDays: 0 })).status, 200);
    assert.equal(await auditMod.purgeAuditLogs(), 0);
    assert.equal((await admin('/api/admin/audit-logs/settings', 'PUT', { retentionDays: 30 })).status, 200);
    assert.ok((await auditMod.purgeAuditLogs()) >= 1);
    assert.ok(!(await rows()).some((r) => r.id === old!.id));
    await waitRow((x) => x.action === 'audit.settings', '修改保留期限');
  });
});
