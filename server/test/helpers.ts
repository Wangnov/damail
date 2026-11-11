/**
 * 集成测试环境：独立的 damail_test 数据库 + 随机端口上的真实 HTTP 服务（oidc-provider 需要 Node 原生请求）。
 * 只访问本机数据库；不连邮箱、不访问外网（CIMD 文档抓取用注入的 fetch 模拟）、不发信。
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://damail:damail@127.0.0.1:55434/damail_test';
export const STATIC_CLIENT = 'damail-test-client';
export const STATIC_REDIRECT = 'http://127.0.0.1:9/callback';
export const CIMD_CLIENT = 'https://client.example/oauth/client.json';
export const CIMD_REDIRECT = 'https://client.example/callback';
// 负面用例专用：抓取到的文档会被缓存，和正常流程用的 client 分开
export const CIMD_CLIENT_2 = 'https://client.example/oauth/other-client.json';
export const PASSWORD = 'correct horse battery staple';

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function resetDatabase() {
  const url = new URL(TEST_DB);
  const dbName = url.pathname.slice(1);
  if (!/test/.test(dbName)) throw new Error(`拒绝在非测试库上运行：${dbName}`);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(TEST_DB), { pathname: '/postgres' }).toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  const client = new pg.Client({ connectionString: TEST_DB });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;');
  await client.end();
}

export type Env = Awaited<ReturnType<typeof setup>>;

export async function setup(extraEnv: Record<string, string> = {}) {
  await resetDatabase();
  const port = await freePort();
  const base = `http://localhost:${port}`;
  Object.assign(process.env, {
    DATABASE_URL: TEST_DB,
    DATA_DIR: mkdtempSync(path.join(os.tmpdir(), 'damail-test-')),
    MASTER_KEY: randomBytes(32).toString('hex'),
    PUBLIC_URL: base,
    SYNC_ENABLED: 'false',
    SEND_DELAY_SEC: '600',
    MCP_OAUTH_ENABLED: 'true',
    MCP_OAUTH_CIMD_CLIENTS: `${CIMD_CLIENT},${CIMD_CLIENT_2}`,
    MCP_OAUTH_REDIRECT_URIS: CIMD_REDIRECT,
    MCP_OAUTH_STATIC_CLIENTS: JSON.stringify([{ client_id: STATIC_CLIENT, client_name: '测试客户端', redirect_uris: [STATIC_REDIRECT] }]),
    MCP_OAUTH_SEND_LIMIT_PER_HOUR: '2',
    MCP_OAUTH_RATE_LIMIT_PER_MIN: '10000',
    ...extraEnv,
  });

  const { serve } = await import('@hono/node-server');
  const { createApp } = await import('../src/app.js');
  const { db, pool, runMigrations } = await import('../src/db/index.js');
  const schema = await import('../src/db/schema.js');
  const { hashPassword, generateApiKey, sha256 } = await import('../src/lib/crypto.js');
  const providerMod = await import('../src/oauth/provider.js');

  await runMigrations();
  // 和正式启动一样，把内置的分类、提示词同步进数据库
  await (await import('../src/services/catalog.js')).syncBuiltins();

  // CIMD 文档抓取：只记录被请求的 URL，返回测试里设定的内容
  const cimd = { fetched: [] as string[], docs: {} as Record<string, unknown> };
  providerMod.setOAuthProvider(
    providerMod.createOAuthProvider({
      fetch: async (url) => {
        cimd.fetched.push(String(url));
        const doc = cimd.docs[String(url)];
        return new Response(JSON.stringify(doc ?? {}), { status: doc ? 200 : 404, headers: { 'content-type': 'application/json' } });
      },
    }),
  );

  // ---- 种子数据：两个用户、两个邮箱、各一封邮件、几份不同来源的草稿 ----
  const pw = await hashPassword(PASSWORD);
  const [alice] = await db.insert(schema.users).values({ username: 'alice', passwordHash: pw }).returning();
  const [bob] = await db.insert(schema.users).values({ username: 'bob', passwordHash: pw }).returning();
  const mkAccount = (name: string, email: string) => ({
    name,
    email,
    imapHost: '127.0.0.1',
    imapPort: 1,
    username: email,
    secretEnc: 'x',
    smtpHost: '127.0.0.1',
    smtpPort: 1,
    enabled: false,
    status: 'disabled',
  });
  const [acc1] = await db.insert(schema.accounts).values(mkAccount('工作', 'work@local.test')).returning();
  const [acc2] = await db.insert(schema.accounts).values(mkAccount('私人', 'home@local.test')).returning();
  const [f1] = await db
    .insert(schema.folders)
    .values({ accountId: acc1!.id, path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', syncEnabled: true })
    .returning();
  const [f2] = await db
    .insert(schema.folders)
    .values({ accountId: acc2!.id, path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', syncEnabled: true })
    .returning();
  const mkMsg = (accountId: number, folderId: number, subject: string) => ({
    accountId,
    folderId,
    uid: 1,
    threadId: `t-${subject}`,
    messageId: `<${subject}@local.test>`,
    subject,
    fromAddress: 'sender@example.com',
    textBody: `${subject} body`,
    date: new Date(),
  });
  const [msg1] = await db
    .insert(schema.messages)
    .values(mkMsg(acc1!.id, f1!.id, 'work-mail'))
    .returning();
  const [msg2] = await db
    .insert(schema.messages)
    .values(mkMsg(acc2!.id, f2!.id, 'home-mail'))
    .returning();

  const apiKeyValue = generateApiKey();
  const [apiKey] = await db
    .insert(schema.apiKeys)
    .values({ userId: alice!.id, name: 'test', prefix: apiKeyValue.slice(0, 8), keyHash: sha256(apiKeyValue), scopes: ['read', 'draft', 'send'] })
    .returning();
  const to = [{ address: 'friend@example.com' }];
  const [webDraft] = await db.insert(schema.drafts).values({ accountId: acc1!.id, subject: 'web draft', to, source: 'web' }).returning();
  const [keyDraft] = await db
    .insert(schema.drafts)
    .values({ accountId: acc1!.id, subject: 'key draft', to, source: 'api', createdByKeyId: apiKey!.id })
    .returning();

  const server = serve({ fetch: createApp().fetch, port, hostname: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));

  return {
    base,
    port,
    db,
    schema,
    cimd,
    users: { alice: alice!, bob: bob! },
    accounts: { work: acc1!, home: acc2! },
    messages: { work: msg1!, home: msg2! },
    apiKey: { value: apiKeyValue, row: apiKey! },
    drafts: { web: webDraft!, key: keyDraft! },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await pool.end();
    },
  };
}

// ---- 带 Cookie 的浏览器模拟 ----
export class Browser {
  cookies = new Map<string, string>();
  constructor(readonly base: string) {}

  async request(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await fetch(new URL(url, this.base), { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair!.indexOf('=');
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      const expired = attrs.some((a) => /max-age=0\b/i.test(a) || /expires=thu, 01 jan 1970/i.test(a));
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  /** 提交表单（同源 Origin） */
  post(url: string, fields: [string, string][], extraHeaders: Record<string, string> = {}) {
    return this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: this.base, ...extraHeaders },
      body: new URLSearchParams(fields).toString(),
    });
  }
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function csrfOf(html: string) {
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  if (!m) throw new Error(`页面里没有 CSRF 字段：${html.slice(0, 300)}`);
  return m[1]!;
}

export type AuthorizeOptions = {
  clientId?: string;
  redirectUri?: string;
  scope?: string;
  resource?: string | null;
  state?: string;
  challenge?: string;
  method?: string | null;
};

export function authorizeUrl(env: Env, o: AuthorizeOptions & { challenge: string }) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: o.clientId ?? STATIC_CLIENT,
    redirect_uri: o.redirectUri ?? STATIC_REDIRECT,
    scope: o.scope ?? 'mail:read',
    state: o.state ?? 'st-123',
    code_challenge: o.challenge,
  });
  if (o.method !== null) q.set('code_challenge_method', o.method ?? 'S256');
  if (o.resource !== null) q.set('resource', o.resource ?? `${env.base}/mcp`);
  return `/oauth/authorize?${q}`;
}

/** 走到授权页：返回交互地址 */
export async function startAuthorize(env: Env, browser: Browser, o: AuthorizeOptions = {}) {
  const p = pkce();
  const res = await browser.request(authorizeUrl(env, { ...o, challenge: o.challenge ?? p.challenge }));
  return { res, verifier: p.verifier, location: res.headers.get('location') };
}

/** 从授权到拿到回调地址的完整浏览器流程 */
export async function authorizeFlow(env: Env, o: AuthorizeOptions & { user?: 'alice' | 'bob'; grant?: string[]; mailboxes?: number[]; deny?: boolean } = {}) {
  const browser = new Browser(env.base);
  const { res, verifier, location } = await startAuthorize(env, browser, o);
  if (res.status !== 303 || !location?.includes('/oauth/interaction/'))
    throw new Error(`authorize 未跳转到交互页：${res.status} ${location} ${await res.text()}`);
  let page = await browser.request(location);
  let body = await page.text();
  if (body.includes('/login"')) {
    const login = await browser.post(`${location}/login`, [
      ['csrf', csrfOf(body)],
      ['username', o.user ?? 'alice'],
      ['password', PASSWORD],
    ]);
    if (login.status !== 303) throw new Error(`登录失败：${login.status} ${await login.text()}`);
    page = await browser.request(location);
    body = await page.text();
  }
  const csrf = csrfOf(body);
  let finish: Response;
  if (o.deny) {
    finish = await browser.post(`${location}/abort`, [['csrf', csrf]]);
  } else {
    const fields: [string, string][] = [['csrf', csrf]];
    for (const s of o.grant ?? (o.scope ?? 'mail:read').split(' ').filter((x) => x.startsWith('mail:'))) fields.push(['scope', s]);
    if (o.mailboxes) {
      fields.push(['mailboxes', 'selected']);
      for (const id of o.mailboxes) fields.push(['account', String(id)]);
    } else fields.push(['mailboxes', 'all']);
    finish = await browser.post(`${location}/confirm`, fields);
  }
  if (finish.status !== 303) throw new Error(`提交同意页失败：${finish.status} ${await finish.text()}`);
  const resume = await browser.request(finish.headers.get('location')!);
  const callback = resume.headers.get('location');
  if (!callback) throw new Error(`没有回调：${resume.status} ${await resume.text()}`);
  return { browser, verifier, callback: new URL(callback), interaction: location, consentHtml: body };
}

export async function tokenRequest(env: Env, fields: Record<string, string>) {
  const res = await fetch(`${env.base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

export async function exchange(env: Env, code: string, verifier: string, extra: Record<string, string> = {}) {
  return tokenRequest(env, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: STATIC_REDIRECT,
    client_id: STATIC_CLIENT,
    code_verifier: verifier,
    resource: `${env.base}/mcp`,
    ...extra,
  });
}

/** 完整拿到一组令牌 */
export async function obtainTokens(env: Env, o: Parameters<typeof authorizeFlow>[1] = {}) {
  const flow = await authorizeFlow(env, o);
  const code = flow.callback.searchParams.get('code');
  if (!code) throw new Error(`回调里没有 code：${flow.callback}`);
  const tok = await exchange(env, code, flow.verifier);
  if (tok.status !== 200) throw new Error(`换 token 失败：${JSON.stringify(tok.body)}`);
  return tok.body;
}

let rpcId = 0;
export async function mcp(env: Env, token: string | null, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
    ...headers,
  };
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(`${env.base}/mcp`, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const text = await res.text();
  let json: {
    result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string; _meta?: Record<string, unknown> }[]; _meta?: Record<string, unknown> };
    error?: unknown;
  } & Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, headers: res.headers, json, text };
}

export function callTool(env: Env, token: string, name: string, args: Record<string, unknown> = {}) {
  return mcp(env, token, 'tools/call', { name, arguments: args });
}
