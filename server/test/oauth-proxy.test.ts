/**
 * MCP_OAUTH_FETCH_PROXY_ID：服务器直连不了客户端时，CIMD 文档 / JWKS 经「代理设置」里的代理抓取。
 * 底层请求用注入的 mock 代替，不连真实代理、不访问外网。
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { authorizeFlow, CIMD_CLIENT, CIMD_REDIRECT, setup, tokenRequest, type Env } from './helpers.js';

let env: Env;
let providerMod: typeof import('../src/oauth/provider.js');
const PROXY_URL = 'socks5://user:p%40ss@127.0.0.1:1080';

type Call = { url: string; init: RequestInit & { dispatcher?: unknown }; proxy: string };
const calls: Call[] = [];
const docs: Record<string, unknown> = {};
async function mockRequest(url: string, init: RequestInit, proxy: string) {
  calls.push({ url, init, proxy });
  const doc = docs[url];
  return new Response(JSON.stringify(doc ?? {}), { status: doc ? 200 : 404, headers: { 'content-type': 'application/json' } });
}

before(async () => {
  // 重建后的测试库里第一个代理 id 为 1
  env = await setup({ MCP_OAUTH_FETCH_PROXY_ID: '1' });
  const { proxyValues } = await import('../src/services/proxy.js');
  const [row] = await env.db
    .insert(env.schema.proxies)
    .values(proxyValues({ name: 'test', protocol: 'socks5', host: '127.0.0.1', port: 1080, username: 'user', password: 'p@ss' }))
    .returning();
  assert.equal(row!.id, 1);
  providerMod = await import('../src/oauth/provider.js');
});
after(async () => {
  await env?.close();
});

describe('经代理抓取 CIMD', () => {
  test('只允许白名单 client_id 所在的源，经所选代理、替换超时、不跟随重定向', async () => {
    const f = providerMod.createProxiedFetch(1, mockRequest);
    calls.length = 0;
    docs[CIMD_CLIENT] = { ok: true };
    const res = await f(CIMD_CLIENT, { method: 'GET', dispatcher: { fake: true }, signal: AbortSignal.timeout(1) } as RequestInit);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, CIMD_CLIENT);
    assert.equal(calls[0]!.proxy, PROXY_URL);
    assert.equal(calls[0]!.init.dispatcher, undefined, 'oidc-provider 的直连 dispatcher 不能带到代理请求里');
    assert.equal(calls[0]!.init.redirect, 'error');
    assert.ok(calls[0]!.init.signal && !calls[0]!.init.signal.aborted);
  });

  test('其他源、http、内网地址都不会经代理请求', async () => {
    const f = providerMod.createProxiedFetch(1, mockRequest);
    calls.length = 0;
    for (const url of ['https://evil.example/client.json', 'http://client.example/oauth/client.json', 'https://169.254.169.254/latest', 'https://client.example.evil.test/x']) {
      await assert.rejects(f(url, {}), /outbound fetch not allowed/, url);
    }
    assert.equal(calls.length, 0);
  });

  test('经代理请求失败时重试一次（只读请求），两次都失败才报错', async () => {
    let fails = 1;
    const flaky = async (url: string, init: RequestInit, proxy: string) => {
      if (fails-- > 0) throw new Error('socket hang up');
      return mockRequest(url, init, proxy);
    };
    docs[CIMD_CLIENT] = { ok: true };
    calls.length = 0;
    assert.equal((await providerMod.createProxiedFetch(1, flaky)(CIMD_CLIENT, { method: 'GET' })).status, 200);
    assert.equal(calls.length, 1);
    fails = 2;
    await assert.rejects(providerMod.createProxiedFetch(1, flaky)(CIMD_CLIENT, { method: 'GET' }), /socket hang up/);
    assert.equal(fails, 0);
  });

  test('代理不存在时报错，不会退回直连', async () => {
    const f = providerMod.createProxiedFetch(999, mockRequest);
    calls.length = 0;
    await assert.rejects(f(CIMD_CLIENT, {}), /代理不存在/);
    assert.equal(calls.length, 0);
  });

  test('完整授权流程：CIMD 文档经代理抓取，可以换到 token', async () => {
    providerMod.setOAuthProvider(providerMod.createOAuthProvider({ proxiedRequest: mockRequest }));
    calls.length = 0;
    docs[CIMD_CLIENT] = {
      client_id: CIMD_CLIENT,
      client_name: '代理 CIMD',
      redirect_uris: [CIMD_REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
    const flow = await authorizeFlow(env, { clientId: CIMD_CLIENT, redirectUri: CIMD_REDIRECT });
    assert.match(flow.consentHtml, /代理 CIMD/);
    assert.ok(calls.some((c) => c.url === CIMD_CLIENT && c.proxy === PROXY_URL));
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
