/**
 * 安全加固回归测试：审批绑定草稿版本、请求体上限、登录限流、NUL 字符入库、
 * 明文连接判断和按上限流式读取。
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { callTool, obtainTokens, PASSWORD, setup, Browser, type Env } from './helpers.js';

let env: Env;
before(async () => {
  env = await setup();
});
after(async () => {
  await env?.close();
});

const toolText = (r: Awaited<ReturnType<typeof callTool>>) => r.json.result?.content?.[0]?.text ?? '';

async function sessionBrowser(user = 'alice') {
  const b = new Browser(env.base);
  const res = await b.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  return b;
}

// 网页会话的写请求要带同源 Origin 和 x-damail 头
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: env.base, 'x-damail': '1' }, body: JSON.stringify(body) });

describe('审批绑定草稿版本', () => {
  test('用户审阅后 Agent 改了内容，按旧版本批准会被拒绝', async () => {
    const tok = await obtainTokens(env, { scope: 'mail:read mail:draft', mailboxes: [env.accounts.work.id] });
    const created = await callTool(env, tok.access_token!, 'create_draft', { body: '正常内容', to: ['friend@example.com'], account_id: env.accounts.work.id });
    const id = JSON.parse(toolText(created)).id as number;
    await callTool(env, tok.access_token!, 'request_send', { id });

    const web = await sessionBrowser();
    const reviewed = (await (await web.request(`/api/v1/drafts/${id}`)).json()) as { revision: number; status: string };
    assert.equal(reviewed.status, 'pending');

    // 审阅期间 Agent 换了收件人
    const edit = await callTool(env, tok.access_token!, 'update_draft', { id, to: ['attacker@example.com'] });
    assert.ok(!edit.json.result?.isError, toolText(edit));

    // 不带版本号不能批准
    assert.equal((await web.request(`/api/v1/drafts/${id}/send`, json({}))).status, 400);
    // 带审阅时的旧版本号被拒绝
    assert.equal((await web.request(`/api/v1/drafts/${id}/send`, json({ revision: reviewed.revision }))).status, 409);
    let row = await env.db.query.drafts.findFirst({ where: (d, { eq }) => eq(d.id, id) });
    assert.equal(row!.status, 'pending');

    // 看过最新版本后再批准才会入队
    const latest = (await (await web.request(`/api/v1/drafts/${id}`)).json()) as { revision: number };
    assert.ok(latest.revision > reviewed.revision);
    assert.equal((await web.request(`/api/v1/drafts/${id}/send`, json({ revision: latest.revision }))).status, 200);
    row = await env.db.query.drafts.findFirst({ where: (d, { eq }) => eq(d.id, id) });
    assert.equal(row!.status, 'queued');

    // 入队后 Agent 不能再改
    const late = await callTool(env, tok.access_token!, 'update_draft', { id, body: '改掉' });
    assert.ok(late.json.result?.isError);
    row = await env.db.query.drafts.findFirst({ where: (d, { eq }) => eq(d.id, id) });
    assert.equal(row!.body, '正常内容');
  });
});

describe('审批时保存全部发送字段', () => {
  test('Agent 审阅期间偷加的密送，在网页保存全部字段后被清掉，不会随审批发出', async () => {
    const tok = await obtainTokens(env, { scope: 'mail:read mail:draft', mailboxes: [env.accounts.work.id] });
    const created = await callTool(env, tok.access_token!, 'create_draft', { body: '正文', to: ['friend@example.com'], account_id: env.accounts.work.id });
    const id = JSON.parse(toolText(created)).id as number;
    await callTool(env, tok.access_token!, 'request_send', { id });

    const web = await sessionBrowser();
    const reviewed = (await (await web.request(`/api/v1/drafts/${id}`)).json()) as { to: { address: string }[]; subject: string; body: string };
    await callTool(env, tok.access_token!, 'update_draft', { id, bcc: ['spy@example.com'] });

    // 网页写信窗口批准前的保存：提交全部发送字段，抄送 / 密送行折叠时也传空数组
    const saved = await web.request(`/api/v1/drafts/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: env.base, 'x-damail': '1' },
      body: JSON.stringify({ to: reviewed.to.map((a) => a.address), cc: [], bcc: [], subject: reviewed.subject, body: reviewed.body }),
    });
    assert.equal(saved.status, 200);
    const latest = (await saved.json()) as { revision: number; bcc: unknown[] };
    assert.deepEqual(latest.bcc, []);
    assert.equal((await web.request(`/api/v1/drafts/${id}/send`, json({ revision: latest.revision }))).status, 200);
    const row = await env.db.query.drafts.findFirst({ where: (d, { eq }) => eq(d.id, id) });
    assert.deepEqual([row!.status, row!.bcc], ['queued', []]);
  });
});

describe('请求体上限', () => {
  test('未登录接口的超大请求体在解析前返回 413', async () => {
    const big = JSON.stringify({ username: 'x', password: 'y'.repeat(3 * 1024 * 1024) });
    const res = await fetch(`${env.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
    assert.equal(res.status, 413);
  });

  test('草稿接口允许内嵌图片的大正文', async () => {
    const web = await sessionBrowser();
    const res = await web.request(`/api/v1/drafts/${env.drafts.web.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: env.base, 'x-damail': '1' },
      body: JSON.stringify({ bodyHtml: `<p><img src="data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}"></p>` }),
    });
    assert.equal(res.status, 200);
  });
});

describe('登录限流', () => {
  const attempt = (username: string, headers: Record<string, string>) =>
    fetch(`${env.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ username, password: 'wrong-password' }),
    });

  test('X-Forwarded-For 第一跳轮换不能绕过按 IP 限流', async () => {
    for (let i = 0; i < 10; i++) assert.equal((await attempt(`nobody-${i}`, { 'x-forwarded-for': `203.0.113.${i}, 198.51.100.7` })).status, 401);
    assert.equal((await attempt('nobody-x', { 'x-forwarded-for': '203.0.113.99, 198.51.100.7' })).status, 429);
  });

  test('同一账号换 IP 也会被限流，并发尝试同样计数', async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => attempt('carol', { 'x-real-ip': `192.0.2.${i}` }).then((r) => r.status)),
    );
    assert.ok(results.every((s) => s === 401 || s === 429));
    assert.equal((await attempt('carol', { 'x-real-ip': '192.0.2.200' })).status, 429);
  });
});

describe('邮件里的 NUL 字符', () => {
  test('主题、正文、附件名带 NUL 也能入库', async () => {
    const { ingestMessage } = await import('../src/services/ingest.js');
    const folder = await env.db.query.folders.findFirst({ where: (f, { eq }) => eq(f.accountId, env.accounts.work.id) });
    const source = Buffer.from(
      [
        'From: "Bad\u0000Sender" <bad@example.com>',
        'To: me@local.test',
        'Subject: hello\u0000world',
        'Message-ID: <nul\u0000test@example.com>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b"',
        '',
        '--b',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('body\u0000text').toString('base64'),
        '--b',
        'Content-Type: application/octet-stream; name="a\u0000.bin"',
        'Content-Disposition: attachment; filename="a\u0000.bin"',
        '',
        'x',
        '--b--',
        '',
      ].join('\r\n'),
    );
    const row = await ingestMessage({ accountId: env.accounts.work.id, folderId: folder!.id, uid: 900, source, flags: new Set() });
    const msg = await env.db.query.messages.findFirst({ where: (m, { eq }) => eq(m.id, row.id) });
    assert.equal(msg!.subject, 'helloworld');
    assert.equal(msg!.textBody?.includes('\u0000'), false);
    assert.equal(JSON.stringify(msg).includes('\\u0000'), false);
  });
});

describe('工具函数', () => {
  test('只有邮件数据本身的错误才算可以跳过的入库失败', async () => {
    const { isMessageDataError } = await import('../src/lib/db-errors.js');
    const { sql } = await import('drizzle-orm');
    const nul = await env.db.execute(sql`SELECT ${'a\u0000b'}::text`).catch((e: unknown) => e);
    assert.equal(isMessageDataError(nul), true, '字符串里的 NUL 是数据错误');
    const missing = await env.db.execute(sql`SELECT * FROM no_such_table`).catch((e: unknown) => e);
    assert.equal(isMessageDataError(missing), false, '其他数据库错误不跳过');
    assert.equal(isMessageDataError(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })), false);
    assert.equal(isMessageDataError(Object.assign(new Error('disk full'), { code: 'ENOSPC' })), false);
  });

  test('只有本机地址允许不加密的 SMTP / IMAP', async () => {
    const { allowsPlaintext } = await import('../src/lib/transport-security.js');
    for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'mail.localhost']) assert.equal(allowsPlaintext(h), true, h);
    for (const h of ['smtp.example.com', '10.0.0.5', '192.168.1.2', 'localhost.example.com', '127.0.0.1.example.com']) assert.equal(allowsPlaintext(h), false, h);
  });

  test('超过上限立即停止读取', async () => {
    const { readCapped } = await import('../src/lib/read-capped.js');
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
        if (pulled >= 1000) controller.close();
      },
    });
    const capped = await readCapped(new Response(stream), 10 * 1024);
    assert.equal(capped.overflow, true);
    assert.ok(capped.data.length <= 11 * 1024);
    assert.ok(pulled < 20, `读了 ${pulled} 块`);

    const small = await readCapped(new Response('hello'), 1024);
    assert.deepEqual([small.overflow, small.data.toString(), small.total], [false, 'hello', 5]);
  });
});

describe('OAuth 直接发信配额', () => {
  test('并发发送也不会超过每小时上限', async () => {
    // 测试环境的上限是每小时 2 封
    const tok = await obtainTokens(env, { scope: 'mail:read mail:draft mail:send', mailboxes: [env.accounts.work.id] });
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const created = await callTool(env, tok.access_token!, 'create_draft', { body: `b${i}`, to: ['friend@example.com'], account_id: env.accounts.work.id });
      ids.push(JSON.parse(toolText(created)).id as number);
    }
    const results = await Promise.all(ids.map((id) => callTool(env, tok.access_token!, 'send_draft', { id })));
    assert.equal(results.filter((r) => !r.json.result?.isError).length, 2);
    const queued = await env.db.query.drafts.findMany({ where: (d, { inArray, eq, and }) => and(inArray(d.id, ids), eq(d.status, 'queued')) });
    assert.equal(queued.length, 2);
  });
});

describe('退出登录', () => {
  test('退出后，之前复制走的会话 cookie 也失效', async () => {
    const web = await sessionBrowser('bob');
    const copied = new Browser(env.base);
    copied.cookies = new Map(web.cookies);
    assert.equal((await copied.request('/api/v1/accounts')).status, 200);

    const out = await web.request('/api/auth/logout', { method: 'POST', headers: { origin: env.base, 'x-damail': '1' } });
    assert.equal(out.status, 200);
    assert.equal((await copied.request('/api/v1/accounts')).status, 401);

    // 重新登录正常
    const again = await sessionBrowser('bob');
    assert.equal((await again.request('/api/v1/accounts')).status, 200);
  });
});

// 会清空用户表，放在最后
describe('首次初始化', () => {
  test('并发初始化只会创建一个管理员', async () => {
    await env.db.delete(env.schema.users);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        fetch(`${env.base}/api/auth/setup`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: `admin${i}`, password: 'a-strong-password' }),
        }).then((r) => r.status),
      ),
    );
    assert.equal(results.filter((s) => s === 200).length, 1, String(results));
    assert.equal(await env.db.$count(env.schema.users), 1);
  });
});
