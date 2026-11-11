import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  authorizeFlow,
  Browser,
  callTool,
  CIMD_CLIENT,
  CIMD_CLIENT_2,
  CIMD_REDIRECT,
  csrfOf,
  exchange,
  mcp,
  obtainTokens,
  PASSWORD,
  setup,
  startAuthorize,
  STATIC_CLIENT,
  STATIC_REDIRECT,
  tokenRequest,
  type Env,
} from './helpers.js';

let env: Env;
before(async () => {
  env = await setup();
});
after(async () => {
  await env?.close();
});

describe('discovery', () => {
  test('受保护资源元数据：路径插入与根路径，无需登录，只要求基础只读权限', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const res = await fetch(`${env.base}${path}`);
      assert.equal(res.status, 200, path);
      const doc = (await res.json()) as Record<string, unknown>;
      assert.equal(doc.resource, `${env.base}/mcp`);
      assert.deepEqual(doc.authorization_servers, [env.base]);
      assert.deepEqual(doc.scopes_supported, ['mail:read']);
    }
    assert.equal((await fetch(`${env.base}/.well-known/oauth-protected-resource/other`)).status, 404);
  });

  test('授权服务器元数据（RFC 8414 与 OIDC）字段反映真实实现', async () => {
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const res = await fetch(`${env.base}${path}`);
      assert.equal(res.status, 200, path);
      const doc = (await res.json()) as Record<string, unknown>;
      assert.equal(doc.issuer, env.base);
      assert.equal(doc.authorization_endpoint, `${env.base}/oauth/authorize`);
      assert.equal(doc.token_endpoint, `${env.base}/oauth/token`);
      assert.equal(doc.revocation_endpoint, `${env.base}/oauth/revoke`);
      assert.deepEqual(doc.code_challenge_methods_supported, ['S256']);
      assert.deepEqual(doc.response_types_supported, ['code']);
      assert.ok((doc.token_endpoint_auth_methods_supported as string[]).includes('none'));
      assert.ok(!(doc.token_endpoint_auth_methods_supported as string[]).includes('client_secret_basic'));
      assert.equal(doc.authorization_response_iss_parameter_supported, true);
      assert.equal(doc.client_id_metadata_document_supported, true);
      assert.equal(doc.registration_endpoint, undefined, '未实现 DCR 就不发布 registration_endpoint');
      assert.deepEqual([...(doc.grant_types_supported as string[])].sort(), ['authorization_code', 'refresh_token']);
    }
  });

  test('未认证访问 /mcp：401 + resource_metadata，不跳转登录页', async () => {
    const res = await mcp(env, null, 'tools/list');
    assert.equal(res.status, 401);
    const h = res.headers.get('www-authenticate') ?? '';
    assert.match(h, /^Bearer /);
    assert.match(h, new RegExp(`resource_metadata="${env.base}/.well-known/oauth-protected-resource/mcp"`));
    assert.match(h, /scope="mail:read"/);
  });
});

describe('授权码 + PKCE 主流程', () => {
  test('登录 → 同意 → 回调带 code、原样 state 和 iss → 换 token → 调用 MCP', async () => {
    const flow = await authorizeFlow(env, { scope: 'mail:read', state: 'abc 中文/=?' });
    assert.equal(flow.callback.origin + flow.callback.pathname, STATIC_REDIRECT);
    assert.equal(flow.callback.searchParams.get('state'), 'abc 中文/=?');
    assert.equal(flow.callback.searchParams.get('iss'), env.base);
    assert.ok(flow.consentHtml.includes('alice'), '同意页显示当前账号');
    const code = flow.callback.searchParams.get('code')!;
    const tok = await exchange(env, code, flow.verifier);
    assert.equal(tok.status, 200, JSON.stringify(tok.body));
    assert.equal(tok.body.token_type, 'Bearer');
    assert.equal(tok.body.scope, 'mail:read');
    assert.ok(tok.body.refresh_token);
    const list = await mcp(env, tok.body.access_token!, 'tools/list');
    assert.equal(list.status, 200, list.text);
    const names = list.json.result!.tools!.map((t) => t.name);
    assert.ok(names.includes('search_emails'));
    assert.ok(names.includes('send_draft'), 'OAuth 下全部可申请的工具可见，用于逐步授权');
    assert.ok(!names.includes('create_rule'), '自动化工具不开放给 OAuth');
    const get = await callTool(env, tok.body.access_token!, 'get_email', { id: env.messages.work.id });
    assert.equal(get.status, 200);
    assert.match(get.json.result!.content![0]!.text, /work-mail/);
  });
});

// ---------- 工具函数 ----------
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

/** 跟随 provider 的跳转直到出现回调（或出错停在某个页面） */
async function follow(b: Browser, res: Response) {
  let r = res;
  for (let i = 0; i < 5 && r.status >= 300 && r.status < 400; i++) {
    const loc = r.headers.get('location')!;
    if (!loc.startsWith('/') && !loc.startsWith(env.base)) return { callback: new URL(loc), res: r };
    r = await b.request(loc);
  }
  return { callback: null, res: r };
}

async function latestAuthorization() {
  const { desc } = await import('drizzle-orm');
  return env.db.query.mcpAuthorizations.findFirst({ orderBy: desc(env.schema.mcpAuthorizations.id) });
}

const toolText = (r: Awaited<ReturnType<typeof callTool>>) => r.json.result?.content?.[0]?.text ?? '';

describe('授权请求校验', () => {
  test('未注册的 client：显示错误页，不跳转', async () => {
    const { res, location } = await startAuthorize(env, new Browser(env.base), { clientId: 'evil-client' });
    assert.equal(location, null);
    assert.ok(res.status >= 400);
  });

  test('redirect_uri 不在白名单：显示错误页，不跳转到不可信地址', async () => {
    const { res, location } = await startAuthorize(env, new Browser(env.base), { redirectUri: 'https://evil.example/cb' });
    assert.equal(res.status, 400);
    assert.equal(location, null);
  });

  test('PKCE：plain 方法直接拒绝，缺少 challenge 按 invalid_request 回调（带 iss）', async () => {
    const plain = await startAuthorize(env, new Browser(env.base), { method: 'plain', challenge: 'x'.repeat(43) });
    assert.equal(plain.res.status, 400);
    assert.equal(plain.location, null);

    const b = new Browser(env.base);
    const res = await b.request(
      `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: STATIC_CLIENT, redirect_uri: STATIC_REDIRECT, scope: 'mail:read', state: 's1', resource: `${env.base}/mcp` })}`,
    );
    const { callback } = await follow(b, res);
    assert.ok(callback, '应回调到客户端');
    assert.equal(callback!.searchParams.get('error'), 'invalid_request');
    assert.equal(callback!.searchParams.get('iss'), env.base);
    assert.equal(callback!.searchParams.get('state'), 's1');
    assert.equal(callback!.searchParams.get('code'), null);
  });

  test('resource 缺失或不是本 MCP 资源：invalid_target', async () => {
    for (const resource of [null, 'https://other.example/mcp', `${env.base}/api`]) {
      const b = new Browser(env.base);
      const { res } = await startAuthorize(env, b, { resource });
      const { callback } = await follow(b, res);
      assert.ok(callback, `resource=${resource} 应回调错误`);
      assert.equal(callback!.searchParams.get('error'), 'invalid_target', String(resource));
      assert.equal(callback!.searchParams.get('iss'), env.base);
    }
  });

  test('没有请求任何 DaMail 权限：invalid_scope', async () => {
    const b = new Browser(env.base);
    const { res } = await startAuthorize(env, b, { scope: 'offline_access' });
    const { callback } = await follow(b, res);
    assert.equal(callback?.searchParams.get('error'), 'invalid_scope');
  });

  test('未知 scope：invalid_scope，不签发授权码', async () => {
    const b = new Browser(env.base);
    const { res } = await startAuthorize(env, b, { scope: 'mail:read mail:delete' });
    const { callback } = await follow(b, res);
    assert.ok(callback);
    assert.equal(callback!.searchParams.get('error'), 'invalid_scope');
    assert.equal(callback!.searchParams.get('code'), null);
    assert.equal(callback!.searchParams.get('iss'), env.base);
  });

  test('用户拒绝：access_denied，state 原样、带 iss，不产生授权记录', async () => {
    const before = await latestAuthorization();
    const flow = await authorizeFlow(env, { deny: true, state: 'deny-1' });
    assert.equal(flow.callback.searchParams.get('error'), 'access_denied');
    assert.equal(flow.callback.searchParams.get('state'), 'deny-1');
    assert.equal(flow.callback.searchParams.get('iss'), env.base);
    assert.equal((await latestAuthorization())?.id, before?.id);
  });

  test('登录完成不等于同意：已登录也必须经过同意页；中途放弃不产生授权', async () => {
    const b = await sessionBrowser();
    const before = await latestAuthorization();
    const { location } = await startAuthorize(env, b, {});
    const page = await b.request(location!);
    const html = await page.text();
    assert.match(html, /授权确认/);
    assert.equal((await latestAuthorization())?.id, before?.id);
  });

  test('同意页 CSRF：缺 token、Origin 不符都拒绝；重复提交不会再签发', async () => {
    const b = await sessionBrowser();
    const { location } = await startAuthorize(env, b, {});
    const html = await (await b.request(location!)).text();
    const csrf = csrfOf(html);
    assert.equal((await b.post(`${location}/confirm`, [['scope', 'mail:read'], ['mailboxes', 'all']])).status, 403);
    assert.equal(
      (await b.post(`${location}/confirm`, [['csrf', csrf], ['scope', 'mail:read'], ['mailboxes', 'all']], { origin: 'https://evil.example' })).status,
      403,
    );
    // 浏览器在 no-referrer 页面提交时 Origin 为 "null"：只有 Sec-Fetch-Site 表明同源才接受
    assert.equal(
      (await b.post(`${location}/confirm`, [['csrf', csrf], ['scope', 'mail:read'], ['mailboxes', 'all']], { origin: 'null' })).status,
      403,
    );
    assert.equal(
      (
        await b.post(`${location}/confirm`, [['csrf', csrf], ['scope', 'mail:read'], ['mailboxes', 'all']], {
          origin: 'null',
          'sec-fetch-site': 'cross-site',
        })
      ).status,
      403,
    );
    const ok = await b.post(`${location}/confirm`, [['csrf', csrf], ['scope', 'mail:read'], ['mailboxes', 'all']], {
      origin: 'null',
      'sec-fetch-site': 'same-origin',
    });
    assert.equal(ok.status, 303);
    const first = await latestAuthorization();
    // 第一次提交后 CSRF Cookie 已清除；即使带上原 Cookie 重放也不再签发
    b.cookies.set('dm_oauth_csrf', csrf);
    const again = await b.post(`${location}/confirm`, [['csrf', csrf], ['scope', 'mail:read'], ['mailboxes', 'all']]);
    assert.notEqual(again.status, 303);
    assert.equal((await latestAuthorization())?.id, first?.id);
  });

  test('用户取消勾选 mail:send 时不签发 send', async () => {
    const tok = await obtainTokens(env, { scope: 'mail:read mail:draft mail:send', grant: ['mail:read', 'mail:draft'] });
    assert.equal(tok.scope, 'mail:read mail:draft');
  });

  test('登录页、同意页按回车提交的是主按钮（登录 / 允许），不是取消 / 拒绝', async () => {
    const { loginPage, consentPage } = await import('../src/oauth/pages.js');
    const client = { clientId: STATIC_CLIENT, clientName: 'Test' };
    const pages = [
      loginPage({ uid: 'u1', csrf: 'c', client }),
      consentPage({ uid: 'u1', csrf: 'c', client, username: 'alice', scopes: ['mail:read', 'mail:send'], mailboxes: [] }),
    ];
    for (const html of pages) {
      // 表单的隐式提交使用 DOM 中第一个提交按钮
      const form = html.slice(html.lastIndexOf('<form'));
      const first = form.match(/<button type="submit"[^>]*>/)![0];
      assert.match(first, /class="primary"/);
      assert.doesNotMatch(first, /formaction/);
    }
  });

  test('同意页权限按固定顺序显示；提交出错重新显示时保留刚才的选择', async () => {
    const { consentPage } = await import('../src/oauth/pages.js');
    const client = { clientId: STATIC_CLIENT, clientName: 'Test' };
    const mailboxes = [
      { id: 1, name: '工作', email: 'w@x.test' },
      { id: 2, name: 'h@x.test', email: 'h@x.test' },
    ];
    const base = { uid: 'u1', csrf: 'c', client, username: 'alice', mailboxes };
    const html = consentPage({ ...base, scopes: ['mail:send', 'mail:read', 'mail:draft'] });
    const order = [...html.matchAll(/name="scope" value="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(order, ['mail:read', 'mail:draft', 'mail:send']);
    assert.match(html, /value="all" checked/);
    assert.doesNotMatch(html, /name="account" value="\d+" checked/);

    const kept = consentPage({ ...base, scopes: ['mail:read', 'mail:send'], keep: { scopes: ['mail:read'], mailboxes: 'selected', accounts: [2] } });
    assert.match(kept, /value="mail:read" checked/);
    assert.doesNotMatch(kept, /value="mail:send" checked/);
    assert.match(kept, /value="selected" checked/);
    assert.match(kept, /name="account" value="2" checked/);
    assert.doesNotMatch(kept, /name="account" value="1" checked/);
  });
});

describe('换 token', () => {
  test('错误 verifier / 缺 verifier / 错误 redirect_uri / 缺或错 resource / 错误 client 都被拒绝', async () => {
    const cases: [string, Record<string, string>][] = [
      ['错误 verifier', { code_verifier: 'a'.repeat(43) }],
      ['缺 verifier', { code_verifier: '' }],
      ['错误 redirect_uri', { redirect_uri: 'http://127.0.0.1:9/other' }],
      ['错误 resource', { resource: 'https://other.example/mcp' }],
      ['错误 client', { client_id: CIMD_CLIENT }],
    ];
    for (const [name, extra] of cases) {
      const flow = await authorizeFlow(env, {});
      const code = flow.callback.searchParams.get('code')!;
      const fields = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== ''));
      const omit = Object.entries(extra).filter(([, v]) => v === '').map(([k]) => k);
      const body: Record<string, string> = {
        grant_type: 'authorization_code',
        code,
        redirect_uri: STATIC_REDIRECT,
        client_id: STATIC_CLIENT,
        code_verifier: flow.verifier,
        resource: `${env.base}/mcp`,
        ...fields,
      };
      for (const k of omit) delete body[k];
      const tok = await tokenRequest(env, body);
      assert.notEqual(tok.status, 200, name);
      assert.equal(tok.body.access_token, undefined, name);
    }
  });

  test('换 token 时没带 resource：沿用授权时绑定的 MCP 资源，audience 不变', async () => {
    const flow = await authorizeFlow(env, {});
    const tok = await tokenRequest(env, {
      grant_type: 'authorization_code',
      code: flow.callback.searchParams.get('code')!,
      redirect_uri: STATIC_REDIRECT,
      client_id: STATIC_CLIENT,
      code_verifier: flow.verifier,
    });
    assert.equal(tok.status, 200);
    assert.equal((await mcp(env, tok.body.access_token!, 'tools/list')).status, 200);
  });

  test('授权码只能用一次：重复兑换失败，并撤销已签发的令牌', async () => {
    const flow = await authorizeFlow(env, {});
    const code = flow.callback.searchParams.get('code')!;
    const first = await exchange(env, code, flow.verifier);
    assert.equal(first.status, 200);
    assert.equal((await mcp(env, first.body.access_token!, 'tools/list')).status, 200);
    const second = await exchange(env, code, flow.verifier);
    assert.equal(second.body.error, 'invalid_grant');
    assert.equal((await mcp(env, first.body.access_token!, 'tools/list')).status, 401);
    const refreshed = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: first.body.refresh_token!, client_id: STATIC_CLIENT });
    assert.notEqual(refreshed.status, 200);
  });

  test('并发兑换同一授权码：最多一个成功', async () => {
    const flow = await authorizeFlow(env, {});
    const code = flow.callback.searchParams.get('code')!;
    const results = await Promise.all([1, 2, 3, 4].map(() => exchange(env, code, flow.verifier)));
    assert.ok(results.filter((r) => r.status === 200).length <= 1, JSON.stringify(results.map((r) => r.status)));
  });

  test('过期的授权码被拒绝', async () => {
    const { eq, sql } = await import('drizzle-orm');
    const flow = await authorizeFlow(env, {});
    await env.db
      .update(env.schema.oauthPayloads)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(env.schema.oauthPayloads.model, 'AuthorizationCode'));
    const tok = await exchange(env, flow.callback.searchParams.get('code')!, flow.verifier);
    assert.equal(tok.body.error, 'invalid_grant');
  });
});

describe('refresh token', () => {
  test('轮换：新令牌可用；旧 refresh token 重放会撤销整个授权', async () => {
    const tok = await obtainTokens(env, {});
    const r1 = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: tok.refresh_token!, client_id: STATIC_CLIENT });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.notEqual(r1.body.refresh_token, tok.refresh_token);
    assert.equal(r1.body.scope, 'mail:read');
    assert.equal((await mcp(env, r1.body.access_token!, 'tools/list')).status, 200);

    const replay = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: tok.refresh_token!, client_id: STATIC_CLIENT });
    assert.equal(replay.body.error, 'invalid_grant');
    assert.equal((await mcp(env, r1.body.access_token!, 'tools/list')).status, 401);
    const r2 = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: r1.body.refresh_token!, client_id: STATIC_CLIENT });
    assert.notEqual(r2.status, 200);
    assert.ok((await latestAuthorization())?.revokedAt);
  });

  test('刷新不能扩权，也不能换到别的 resource', async () => {
    const tok = await obtainTokens(env, {});
    const wider = await tokenRequest(env, {
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token!,
      client_id: STATIC_CLIENT,
      scope: 'mail:read mail:send',
    });
    assert.notEqual(wider.status, 200);
    assert.equal(wider.body.access_token, undefined);
    const tok2 = await obtainTokens(env, {});
    const other = await tokenRequest(env, {
      grant_type: 'refresh_token',
      refresh_token: tok2.refresh_token!,
      client_id: STATIC_CLIENT,
      resource: 'https://other.example/mcp',
    });
    assert.notEqual(other.status, 200);
  });

  test('其他 client 不能使用该 refresh token', async () => {
    const tok = await obtainTokens(env, {});
    const r = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: tok.refresh_token!, client_id: CIMD_CLIENT });
    assert.notEqual(r.status, 200);
  });
});

describe('撤销', () => {
  test('网页撤销授权后 access / refresh token 都失效', async () => {
    const tok = await obtainTokens(env, {});
    const authz = await latestAuthorization();
    const web = await sessionBrowser();
    const list = await web.request('/api/admin/mcp-authorizations');
    const rows = (await list.json()) as { id: number }[];
    assert.ok(rows.some((r) => r.id === authz!.id));
    const del = await web.request(`/api/admin/mcp-authorizations/${authz!.id}`, { method: 'DELETE', headers: { 'x-damail': '1' } });
    assert.equal(del.status, 200);
    assert.equal((await mcp(env, tok.access_token!, 'tools/list')).status, 401);
    const r = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: tok.refresh_token!, client_id: STATIC_CLIENT });
    assert.notEqual(r.status, 200);
  });

  test('客户端通过 /oauth/revoke 撤销 refresh token', async () => {
    const tok = await obtainTokens(env, {});
    const res = await fetch(`${env.base}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tok.refresh_token!, token_type_hint: 'refresh_token', client_id: STATIC_CLIENT }).toString(),
    });
    assert.equal(res.status, 200);
    const r = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: tok.refresh_token!, client_id: STATIC_CLIENT });
    assert.notEqual(r.status, 200);
  });

  test('过期的 access token 返回 401 invalid_token', async () => {
    const { eq, sql } = await import('drizzle-orm');
    const tok = await obtainTokens(env, {});
    await env.db
      .update(env.schema.oauthPayloads)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(env.schema.oauthPayloads.model, 'AccessToken'));
    const res = await mcp(env, tok.access_token!, 'tools/list');
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
  });

  test('数据库里不保存令牌明文', async () => {
    const tok = await obtainTokens(env, {});
    const { sql } = await import('drizzle-orm');
    const hit = await env.db.execute(
      sql`SELECT count(*)::int AS n FROM oauth_payloads WHERE payload::text LIKE ${'%' + tok.access_token + '%'} OR payload::text LIKE ${'%' + tok.refresh_token + '%'} OR id_hash = ${tok.access_token}`,
    );
    assert.equal((hit.rows[0] as { n: number }).n, 0);
  });
});

describe('权限与资源归属', () => {
  test('只读令牌不能写草稿：HTTP 403 insufficient_scope 并给出所需 scope', async () => {
    const tok = await obtainTokens(env, { scope: 'mail:read' });
    const res = await callTool(env, tok.access_token!, 'create_draft', { body: 'hi', to: ['a@example.com'], account_id: env.accounts.work.id });
    assert.equal(res.status, 403);
    const h = res.headers.get('www-authenticate') ?? '';
    assert.match(h, /error="insufficient_scope"/);
    assert.match(h, /scope="mail:draft"/);
    assert.match(h, /resource_metadata="/);
  });

  test('tool 模式：返回 isError 和 _meta["mcp/www_authenticate"]', async () => {
    const { config } = await import('../src/config.js');
    const tok = await obtainTokens(env, { scope: 'mail:read' });
    config.mcpOAuth.scopeChallenge = 'tool';
    try {
      const res = await callTool(env, tok.access_token!, 'move_emails', { ids: [env.messages.work.id], to: 'archive' });
      assert.equal(res.status, 200);
      assert.equal(res.json.result?.isError, true);
      const meta = res.json.result?._meta?.['mcp/www_authenticate'] as string[];
      assert.match(meta[0]!, /insufficient_scope/);
      assert.match(meta[0]!, /mail:organize/);
    } finally {
      config.mcpOAuth.scopeChallenge = 'http';
    }
  });

  test('工具声明 securitySchemes', async () => {
    const tok = await obtainTokens(env, { scope: 'mail:read' });
    const list = await mcp(env, tok.access_token!, 'tools/list');
    const send = list.json.result!.tools!.find((t) => t.name === 'send_draft')!;
    assert.deepEqual(send._meta?.securitySchemes, [{ type: 'oauth2', scopes: ['mail:send'] }]);
  });

  test('草稿权限不能发信；只能处理本授权创建的草稿', async () => {
    const tok = await obtainTokens(env, { scope: 'mail:read mail:draft' });
    const created = await callTool(env, tok.access_token!, 'create_draft', {
      body: 'hello',
      to: ['friend@example.com'],
      subject: 'from oauth',
      account_id: env.accounts.work.id,
    });
    assert.equal(created.status, 200, created.text);
    const draftId = JSON.parse(toolText(created)).id as number;
    assert.equal((await callTool(env, tok.access_token!, 'send_draft', { id: draftId })).status, 403);
    // 网页创建的、API Key 创建的草稿都不能改 / 删 / 提交
    for (const id of [env.drafts.web.id, env.drafts.key.id]) {
      for (const [tool, args] of [
        ['update_draft', { id, body: 'pwned' }],
        ['delete_draft', { id }],
        ['request_send', { id }],
        ['cancel_send', { id }],
      ] as const) {
        const r = await callTool(env, tok.access_token!, tool, args);
        assert.equal(r.json.result?.isError, true, `${tool} ${id}`);
      }
    }
    const row = await env.db.query.drafts.findFirst({ where: (d, { eq }) => eq(d.id, env.drafts.web.id) });
    assert.equal(row?.body, '');
    // 自己创建的可以提交审批
    const submit = await callTool(env, tok.access_token!, 'request_send', { id: draftId });
    assert.notEqual(submit.json.result?.isError, true, toolText(submit));
  });

  test('另一个授权（含其他用户）不能处理本授权的草稿', async () => {
    const a = await obtainTokens(env, { scope: 'mail:read mail:draft mail:send' });
    const created = await callTool(env, a.access_token!, 'create_draft', { body: 'x', to: ['f@example.com'], account_id: env.accounts.work.id });
    const draftId = JSON.parse(toolText(created)).id as number;
    for (const user of ['alice', 'bob'] as const) {
      const b = await obtainTokens(env, { scope: 'mail:read mail:draft mail:send', user });
      for (const tool of ['update_draft', 'send_draft', 'delete_draft'] as const) {
        const r = await callTool(env, b.access_token!, tool, tool === 'update_draft' ? { id: draftId, body: 'y' } : { id: draftId });
        assert.equal(r.json.result?.isError, true, `${user} ${tool}`);
      }
    }
  });

  test('直接发送：只发本授权的草稿，受每小时上限约束，不能批准待审批邮件', async () => {
    const tok = await obtainTokens(env, { scope: 'mail:read mail:draft mail:send' });
    const mk = async () =>
      JSON.parse(toolText(await callTool(env, tok.access_token!, 'create_draft', { body: 'b', to: ['f@example.com'], account_id: env.accounts.work.id })))
        .id as number;
    const d1 = await mk();
    const s1 = await callTool(env, tok.access_token!, 'send_draft', { id: d1 });
    assert.equal(JSON.parse(toolText(s1)).status, 'queued');
    // 重复调用不会再次入队
    assert.equal((await callTool(env, tok.access_token!, 'send_draft', { id: d1 })).json.result?.isError, true);
    const pending = await mk();
    await callTool(env, tok.access_token!, 'request_send', { id: pending });
    const approve = await callTool(env, tok.access_token!, 'send_draft', { id: pending });
    assert.equal(approve.json.result?.isError, true);
    assert.equal((await callTool(env, tok.access_token!, 'send_draft', { id: await mk() })).json.result?.isError, undefined);
    const third = await callTool(env, tok.access_token!, 'send_draft', { id: await mk() });
    assert.equal(third.json.result?.isError, true);
    assert.match(toolText(third), /每小时最多直接发送 2 封/);
    // 测试不真的发信：撤销入队的草稿
    const { eq, and } = await import('drizzle-orm');
    await env.db
      .update(env.schema.drafts)
      .set({ status: 'draft', sendAt: null })
      .where(and(eq(env.schema.drafts.status, 'queued')));
  });

  test('邮箱范围：只授权了工作邮箱时，按 ID 访问私人邮箱的邮件和草稿都被拒绝', async () => {
    const tok = await obtainTokens(env, { scope: 'mail:read mail:draft', mailboxes: [env.accounts.work.id] });
    const accountsRes = JSON.parse(toolText(await callTool(env, tok.access_token!, 'list_accounts'))) as { id: number }[];
    assert.deepEqual(accountsRes.map((a) => a.id), [env.accounts.work.id]);
    assert.equal((await callTool(env, tok.access_token!, 'get_email', { id: env.messages.home.id })).json.result?.isError, true);
    assert.equal((await callTool(env, tok.access_token!, 'get_email', { id: env.messages.work.id })).json.result?.isError, undefined);
    assert.equal((await callTool(env, tok.access_token!, 'get_thread', { thread_id: env.messages.home.threadId })).json.result?.isError, true);
    assert.equal(
      (await callTool(env, tok.access_token!, 'get_attachment', { message_id: env.messages.home.id, index: 0 })).json.result?.isError,
      true,
    );
    const search = JSON.parse(toolText(await callTool(env, tok.access_token!, 'search_emails', {}))) as { items: { id: number }[] };
    assert.ok(search.items.every((m) => m.id !== env.messages.home.id));
    const [homeDraft] = await env.db.insert(env.schema.drafts).values({ accountId: env.accounts.home.id, subject: 'home draft' }).returning();
    assert.equal((await callTool(env, tok.access_token!, 'get_draft', { id: homeDraft!.id })).json.result?.isError, true);
    const create = await callTool(env, tok.access_token!, 'create_draft', { body: 'x', to: ['f@example.com'], account_id: env.accounts.home.id });
    assert.equal(create.json.result?.isError, true);
    const reply = await callTool(env, tok.access_token!, 'create_draft', { mode: 'reply', source_message_id: env.messages.home.id, body: 'x' });
    assert.equal(reply.json.result?.isError, true);
  });
});

describe('凭证选择与向后兼容', () => {
  test('每个 MCP 工具都配置了所需权限（新增工具漏配会直接报错）', async () => {
    const { toolCatalog } = await import('../src/mcp/server.js');
    const tools = await toolCatalog();
    assert.ok(tools.length > 30);
  });

  test('OAuth 令牌不能访问 REST API（audience 不同）', async () => {
    const tok = await obtainTokens(env, {});
    const res = await fetch(`${env.base}/api/v1/accounts`, { headers: { authorization: `Bearer ${tok.access_token}` } });
    assert.equal(res.status, 401);
  });

  test('无效 Bearer 或非 Bearer 头不会回退到网页会话', async () => {
    const web = await sessionBrowser();
    assert.equal((await web.request('/api/v1/accounts')).status, 200);
    for (const header of ['Bearer invalid-token-value-xxxxxxxx', 'Bearer dm_nope', 'Basic YWxpY2U6cGFzcw==', 'Bearer']) {
      const res = await web.request('/api/v1/accounts', { headers: { authorization: header } });
      assert.equal(res.status, 401, header);
      const m = await web.request('/mcp', {
        method: 'POST',
        headers: { authorization: header, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-damail': '1' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      assert.equal(m.status, 401, `mcp ${header}`);
      assert.match(m.headers.get('www-authenticate') ?? '', /resource_metadata=/);
    }
  });

  test('API Key 继续可用：/mcp 和 /api/v1，原有草稿归属规则不变', async () => {
    const key = env.apiKey.value;
    const list = await mcp(env, key, 'tools/list');
    assert.equal(list.status, 200);
    const names = list.json.result!.tools!.map((t) => t.name);
    assert.ok(names.includes('send_draft'));
    assert.ok(!names.includes('create_rule'), '没有 automation 权限的 Key 看不到规则工具');
    assert.equal((await fetch(`${env.base}/api/v1/accounts`, { headers: { authorization: `Bearer ${key}` } })).status, 200);
    const r = await callTool(env, key, 'update_draft', { id: env.drafts.web.id, body: 'x' });
    assert.equal(r.json.result?.isError, true);
    const own = await callTool(env, key, 'update_draft', { id: env.drafts.key.id, body: 'key edit' });
    assert.equal(own.json.result?.isError, undefined, toolText(own));
  });

  test('网页会话继续可用：可以处理全部草稿；/mcp 写请求仍要求 x-damail 头', async () => {
    const web = await sessionBrowser();
    const res = await web.request(`/api/v1/drafts/${env.drafts.web.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-damail': '1' },
      body: JSON.stringify({ body: 'web edit' }),
    });
    assert.equal(res.status, 200);
    const noHeader = await web.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(noHeader.status, 403);
  });

  test('邮件服务商 OAuth 路由不受影响', async () => {
    const web = await sessionBrowser();
    // 服务商 OAuth 起始地址仍由原路由处理（未配置应用时返回错误说明，而不是 404 或被 MCP OAuth 接管）
    const res = await web.request('/api/oauth/microsoft/start');
    assert.notEqual(res.status, 404);
    assert.ok(!(res.headers.get('location') ?? '').includes('/oauth/interaction/'));
  });
});

describe('Client ID Metadata Document', () => {
  const validDoc = {
    client_id: CIMD_CLIENT,
    client_name: 'CIMD 测试',
    redirect_uris: [CIMD_REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };

  test('不在白名单的 client_id URL 不会被抓取', async () => {
    const before = env.cimd.fetched.length;
    const { res, location } = await startAuthorize(env, new Browser(env.base), {
      clientId: 'https://169.254.169.254/latest/meta-data.json',
      redirectUri: CIMD_REDIRECT,
    });
    assert.equal(location, null);
    assert.ok(res.status >= 400);
    assert.equal(env.cimd.fetched.length, before);
  });

  test('文档不存在、client_id 与 URL 不一致、使用共享密钥认证、回调不在名单内：拒绝', async () => {
    const other = { ...validDoc, client_id: CIMD_CLIENT_2 };
    // 回调不在名单的文档能抓取成功并会被缓存，放在最后
    for (const doc of [
      undefined,
      { ...other, client_id: 'https://client.example/oauth/client-x.json' },
      { ...other, token_endpoint_auth_method: 'client_secret_basic' },
      { ...other, client_secret: 'leaked' },
      { ...other, redirect_uris: ['https://evil.example/cb'] },
    ]) {
      env.cimd.docs[CIMD_CLIENT_2] = doc;
      const { res, location } = await startAuthorize(env, new Browser(env.base), { clientId: CIMD_CLIENT_2, redirectUri: CIMD_REDIRECT });
      assert.equal(location, null, JSON.stringify(doc));
      assert.ok(res.status >= 400);
    }
  });

  test('合法文档：可以发起授权，回调必须精确匹配', async () => {
    env.cimd.docs[CIMD_CLIENT] = validDoc;
    const bad = await startAuthorize(env, new Browser(env.base), { clientId: CIMD_CLIENT, redirectUri: `${CIMD_REDIRECT}/x` });
    assert.equal(bad.location, null);
    const flow = await authorizeFlow(env, { clientId: CIMD_CLIENT, redirectUri: CIMD_REDIRECT });
    assert.equal(flow.callback.origin + flow.callback.pathname, CIMD_REDIRECT);
    assert.match(flow.consentHtml, /CIMD 测试/);
    assert.ok(env.cimd.fetched.includes(CIMD_CLIENT));
    const tok = await tokenRequest(env, {
      grant_type: 'authorization_code',
      code: flow.callback.searchParams.get('code')!,
      redirect_uri: CIMD_REDIRECT,
      client_id: CIMD_CLIENT,
      code_verifier: flow.verifier,
      resource: `${env.base}/mcp`,
    });
    assert.equal(tok.status, 200, JSON.stringify(tok.body));
  });
});
