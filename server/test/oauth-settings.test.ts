/**
 * MCP OAuth 网页设置：保存后立即生效（不重启）、按客户端绑定回调地址、校验、关闭开关、启动时加载。
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { authorizeFlow, Browser, mcp, PASSWORD, setup, startAuthorize, STATIC_CLIENT, tokenRequest, type Env } from './helpers.js';

let env: Env;
let web: Browser;
let configMod: typeof import('../src/config.js');
let providerMod: typeof import('../src/oauth/provider.js');
let settingsMod: typeof import('../src/oauth/settings.js');

const CIMD_A = 'https://client.example/a/client.json';
const CIMD_B = 'https://client.example/b/client.json';
const CB_A = 'https://client.example/a/callback';
const CB_B = 'https://client.example/b/callback';
const WEB_CLIENT = 'web-client';
const WEB_CB = 'http://127.0.0.1:9/web-callback';
const docs: Record<string, unknown> = {};

type Settings = {
  source?: 'env' | 'web';
  enabled: boolean;
  clients: { type: 'cimd' | 'static'; clientId: string; name?: string | null; redirectUris: string[] }[];
  fetchProxyId: number | null;
  sendLimitPerHour: number;
  scopeChallenge: 'http' | 'tool';
};

const base: Settings = {
  enabled: true,
  clients: [
    { type: 'static', clientId: WEB_CLIENT, name: '网页配置的客户端', redirectUris: [WEB_CB] },
    { type: 'cimd', clientId: CIMD_A, name: 'A', redirectUris: [CB_A] },
    { type: 'cimd', clientId: CIMD_B, name: 'B', redirectUris: [CB_B] },
  ],
  fetchProxyId: null,
  sendLimitPerHour: 3,
  scopeChallenge: 'http',
};

async function put(body: unknown, b: Browser = web) {
  const res = await b.request('/api/admin/mcp-oauth/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-damail': '1' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Settings & { error?: string } };
}

async function info() {
  const res = await web.request('/api/admin/mcp-oauth');
  return (await res.json()) as { enabled: boolean; sendLimitPerHour: number; settings: Settings };
}

/** 保存后 provider 会按新配置重建；测试里重新注入 CIMD 文档的 mock 抓取 */
function mockCimd() {
  providerMod.setOAuthProvider(
    providerMod.createOAuthProvider({
      fetch: async (url) => {
        const doc = docs[String(url)];
        return new Response(JSON.stringify(doc ?? {}), { status: doc ? 200 : 404, headers: { 'content-type': 'application/json' } });
      },
    }),
  );
}

const cimdDoc = (clientId: string, redirectUris: string[]) => ({
  client_id: clientId,
  client_name: `doc ${clientId}`,
  redirect_uris: redirectUris,
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
});

before(async () => {
  env = await setup();
  configMod = await import('../src/config.js');
  providerMod = await import('../src/oauth/provider.js');
  settingsMod = await import('../src/oauth/settings.js');
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

describe('MCP OAuth 网页设置', () => {
  test('没保存过时显示环境变量里的配置', async () => {
    const i = await info();
    assert.equal(i.settings.source, 'env');
    assert.equal(i.settings.enabled, true);
    assert.ok(i.settings.clients.some((c) => c.type === 'static' && c.clientId === STATIC_CLIENT));
    assert.ok(i.settings.clients.some((c) => c.type === 'cimd'));
  });

  test('只有网页登录态能修改：API Key、未登录都被拒绝', async () => {
    const anon = await put(base, new Browser(env.base));
    assert.equal(anon.status, 401);
    const res = await fetch(`${env.base}/api/admin/mcp-oauth/settings`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${env.apiKey.value}`, 'content-type': 'application/json', 'x-damail': '1' },
      body: JSON.stringify(base),
    });
    assert.ok(res.status === 401 || res.status === 403, String(res.status));
    assert.equal((await info()).settings.source, 'env');
  });

  test('不合法的设置被拒绝，原配置不变', async () => {
    const bad: [string, Settings][] = [
      ['http 的 client_id', { ...base, clients: [{ type: 'cimd', clientId: 'http://client.example/x.json', redirectUris: [CB_A] }] }],
      ['通配符回调', { ...base, clients: [{ type: 'cimd', clientId: CIMD_A, redirectUris: ['https://client.example/*'] }] }],
      ['带 # 的回调', { ...base, clients: [{ type: 'cimd', clientId: CIMD_A, redirectUris: [`${CB_A}#x`] }] }],
      ['http 的回调', { ...base, clients: [{ type: 'cimd', clientId: CIMD_A, redirectUris: ['http://client.example/cb'] }] }],
      ['没有回调', { ...base, clients: [{ type: 'cimd', clientId: CIMD_A, redirectUris: [] }] }],
      ['重复客户端', { ...base, clients: [base.clients[1]!, base.clients[1]!] }],
      ['预注册 id 格式', { ...base, clients: [{ type: 'static', clientId: 'a b', redirectUris: [WEB_CB] }] }],
      ['代理不存在', { ...base, fetchProxyId: 999 }],
      ['发信上限为负', { ...base, sendLimitPerHour: -1 }],
    ];
    for (const [name, body] of bad) {
      const r = await put(body);
      assert.equal(r.status, 400, name);
      assert.ok(r.body.error, name);
    }
    assert.equal((await info()).settings.source, 'env');
  });

  test('保存后立即生效：旧客户端失效，新客户端可以完成授权，发信上限更新', async () => {
    const r = await put(base);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.source, 'web');
    const i = await info();
    assert.equal(i.sendLimitPerHour, 3);
    assert.equal(i.settings.clients.find((c) => c.clientId === CIMD_A)?.name, 'A');
    assert.equal(configMod.config.mcpOAuth.sendLimitPerHour, 3);

    // 环境变量里的预注册客户端不在新设置里：显示错误页，不跳转
    const old = await startAuthorize(env, new Browser(env.base));
    assert.equal(old.location, null);
    assert.ok(old.res.status >= 400);

    const flow = await authorizeFlow(env, { clientId: WEB_CLIENT, redirectUri: WEB_CB });
    assert.match(flow.consentHtml, /网页配置的客户端/);
    const tok = await tokenRequest(env, {
      grant_type: 'authorization_code',
      code: flow.callback.searchParams.get('code')!,
      redirect_uri: WEB_CB,
      client_id: WEB_CLIENT,
      code_verifier: flow.verifier,
      resource: `${env.base}/mcp`,
    });
    assert.equal(tok.status, 200, JSON.stringify(tok.body));
    assert.equal((await mcp(env, tok.body.access_token!, 'tools/list')).status, 200);
  });

  test('回调地址按客户端绑定：A 不能使用 B 的回调，即使 A 的文档里声明了它', async () => {
    docs[CIMD_A] = cimdDoc(CIMD_A, [CB_A, CB_B]);
    docs[CIMD_B] = cimdDoc(CIMD_B, [CB_B]);
    mockCimd();
    const cross = await startAuthorize(env, new Browser(env.base), { clientId: CIMD_A, redirectUri: CB_B });
    assert.equal(cross.location, null);
    assert.ok(cross.res.status >= 400);
    const own = await startAuthorize(env, new Browser(env.base), { clientId: CIMD_A, redirectUri: CB_A });
    assert.equal(own.res.status, 303);
    assert.match(own.location ?? '', /\/oauth\/interaction\//);
    const b = await startAuthorize(env, new Browser(env.base), { clientId: CIMD_B, redirectUri: CB_B });
    assert.match(b.location ?? '', /\/oauth\/interaction\//);
  });

  test('关闭开关：OAuth 端点和元数据 404，已签发的令牌立即不能用；重新开启后恢复', async () => {
    const flow = await authorizeFlow(env, { clientId: WEB_CLIENT, redirectUri: WEB_CB });
    const tok = await tokenRequest(env, {
      grant_type: 'authorization_code',
      code: flow.callback.searchParams.get('code')!,
      redirect_uri: WEB_CB,
      client_id: WEB_CLIENT,
      code_verifier: flow.verifier,
      resource: `${env.base}/mcp`,
    });
    assert.equal(tok.status, 200);

    assert.equal((await put({ ...base, enabled: false })).status, 200);
    assert.equal((await fetch(`${env.base}/.well-known/oauth-protected-resource/mcp`)).status, 404);
    assert.equal((await fetch(`${env.base}/.well-known/oauth-authorization-server`)).status, 404);
    assert.equal((await startAuthorize(env, new Browser(env.base), { clientId: WEB_CLIENT, redirectUri: WEB_CB })).res.status, 404);
    const denied = await mcp(env, tok.body.access_token!, 'tools/list');
    assert.equal(denied.status, 401);

    assert.equal((await put(base)).status, 200);
    assert.equal((await mcp(env, tok.body.access_token!, 'tools/list')).status, 200);
  });

  test('启动时加载已保存的设置；存的设置失效（代理被删）时停用 OAuth', async () => {
    const o = configMod.config.mcpOAuth;
    o.enabled = false;
    o.sendLimitPerHour = 99;
    await settingsMod.loadMcpOAuthSettings();
    assert.equal(o.enabled, true);
    assert.equal(o.sendLimitPerHour, 3);
    assert.deepEqual(o.cimdRedirects[CIMD_A], [CB_A]);

    const [proxy] = await env.db
      .insert(env.schema.proxies)
      .values({ name: 'p', protocol: 'socks5', host: '127.0.0.1', port: 1080 })
      .returning();
    assert.equal((await put({ ...base, fetchProxyId: proxy!.id })).status, 200);
    const { eq } = await import('drizzle-orm');
    await env.db.delete(env.schema.proxies).where(eq(env.schema.proxies.id, proxy!.id));
    await settingsMod.loadMcpOAuthSettings();
    assert.equal(o.enabled, false);
    assert.equal((await fetch(`${env.base}/.well-known/oauth-protected-resource/mcp`)).status, 404);
  });

  test('读取客户端文档：拒绝内网地址和非 HTTPS', async () => {
    for (const clientId of ['https://127.0.0.1/client.json', 'https://169.254.169.254/latest', 'http://client.example/x.json', 'not a url']) {
      const res = await web.request('/api/admin/mcp-oauth/inspect-client', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-damail': '1' },
        body: JSON.stringify({ clientId, proxyId: null }),
      });
      assert.equal(res.status, 400, clientId);
    }
  });
});
