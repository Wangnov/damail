import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type Provider from 'oidc-provider';
import { clearSession, issueSession, readSession, type AppEnv } from '../auth/index.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { accounts, mcpAuthorizations, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { verifyPassword } from '../lib/crypto.js';
import { delegateToProvider, getOAuthProvider, isConfiguredResource, OAUTH_ROUTES } from './provider.js';
import { consentPage, errorPage, loginPage, PAGE_CSP, type ClientInfo } from './pages.js';
import { protectedResourceMetadata, resourceMetadataUrl } from './resource.js';
import { BASE_SCOPES, isOAuthScope, parseScopeParam, RESOURCE_SCOPES } from './scopes.js';
import { L } from '../i18n/index.js';

type NodeBindings = { incoming: IncomingMessage; outgoing: ServerResponse };
type Env = AppEnv & { Bindings: NodeBindings };
type C = Context<Env>;

const CSRF_COOKIE = 'dm_oauth_csrf';
const INTERACTION_PATH = '/oauth/interaction';

// ---- 简单的按 IP 固定窗口限流（单实例部署） ----
const buckets = new Map<string, { count: number; until: number }>();
// 限流用的客户端 IP：优先反向代理写入的 X-Real-IP（OpenResty 设为 $remote_addr），
// 其次 X-Forwarded-For 的最后一跳（前面的条目由客户端自己填写，可以伪造来绕过限流），最后才是直连地址
function clientIp(c: C) {
  const real = c.req.header('x-real-ip')?.trim();
  if (real) return real;
  const last = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
  return last || c.env?.incoming?.socket?.remoteAddress || 'local';
}
function limited(c: C, bucket: string, max: number, windowMs: number) {
  const key = `${bucket}:${clientIp(c)}`;
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.until <= now) {
    buckets.set(key, { count: 1, until: now + windowMs });
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.until <= now) buckets.delete(k);
    return false;
  }
  b.count += 1;
  return b.count > max;
}
function loginFailed(c: C) {
  const key = `login-fail:${clientIp(c)}`;
  const now = Date.now();
  const b = buckets.get(key);
  buckets.set(key, b && b.until > now ? { count: b.count + 1, until: b.until } : { count: 1, until: now + 10 * 60_000 });
}
function loginBlocked(c: C) {
  const b = buckets.get(`login-fail:${clientIp(c)}`);
  return Boolean(b && b.until > Date.now() && b.count >= 10);
}

function html(c: C, body: string, status: 200 | 400 | 403 | 404 | 429 = 200) {
  c.header('Content-Security-Policy', PAGE_CSP);
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  return c.html(body, status);
}

const secureCookies = () => new URL(config.mcpOAuth.issuer).protocol === 'https:';

function newCsrf(c: C) {
  const token = randomBytes(24).toString('base64url');
  setCookie(c, CSRF_COOKIE, token, { httpOnly: true, sameSite: 'Strict', secure: secureCookies(), path: INTERACTION_PATH, maxAge: 900 });
  return token;
}

/**
 * 表单 CSRF：Strict Cookie 与表单字段一致，且请求来自本站。
 * 页面使用 no-referrer（不向外泄露交互地址），浏览器提交表单时 Origin 会是 "null"，
 * 这时以浏览器自动附加、页面脚本无法伪造的 Sec-Fetch-Site 为准。
 */
function csrfOk(c: C, form: Record<string, unknown>) {
  const origin = c.req.header('origin');
  if (origin && origin !== 'null' && origin !== new URL(config.mcpOAuth.issuer).origin) return false;
  const site = c.req.header('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  if (origin === 'null' && site !== 'same-origin') return false;
  const cookie = getCookie(c, CSRF_COOKIE);
  const field = typeof form.csrf === 'string' ? form.csrf : '';
  if (!cookie || !field || cookie.length !== field.length) return false;
  return timingSafeEqual(Buffer.from(cookie), Buffer.from(field));
}

type Details = Awaited<ReturnType<Provider['interactionDetails']>>;

async function loadInteraction(p: Provider, c: C): Promise<Details | null> {
  try {
    const details = await p.interactionDetails(c.env.incoming, c.env.outgoing);
    return details.uid === c.req.param('uid') ? details : null;
  } catch {
    return null;
  }
}

async function clientInfo(p: Provider, clientId: string): Promise<ClientInfo> {
  const client = await p.Client.find(clientId).catch(() => undefined);
  return { clientId, clientName: client?.clientName ?? null };
}

/** 本次请求的 DaMail 权限；签发的令牌只会包含请求过且用户勾选的 scope */
function requestedScopes(details: Details) {
  const raw = parseScopeParam(details.params.scope as string | undefined);
  // openid 不在元数据里声明，但部分客户端会默认带上：接受但忽略，不签发 ID Token
  const unknown = raw.filter((s) => !isOAuthScope(s) && s !== 'offline_access' && s !== 'openid');
  return { unknown, scopes: raw.filter(isOAuthScope), offline: raw.includes('offline_access') };
}

function resourceOk(details: Details) {
  const r = details.params.resource;
  return typeof r === 'string' && isConfiguredResource(r);
}

/** 结束交互（同意 / 拒绝 / 出错），由 oidc-provider 生成带 state 和 iss 的回调地址 */
async function finish(p: Provider, c: C, result: Parameters<Provider['interactionResult']>[2]) {
  const url = await p.interactionResult(c.env.incoming, c.env.outgoing, result, { mergeWithLastSubmission: false });
  deleteCookie(c, CSRF_COOKIE, { path: INTERACTION_PATH });
  return c.redirect(url, 303);
}

const inFlight = new Set<string>();

type Keep = { scopes: string[]; mailboxes: 'all' | 'selected'; accounts: number[] };

async function renderInteraction(p: Provider, c: C, details: Details, error?: string, username?: string, keep?: Keep) {
  const client = await clientInfo(p, String(details.params.client_id));
  const csrf = newCsrf(c);
  const uid = await readSession(c);
  const user = uid ? await db.query.users.findFirst({ where: eq(users.id, uid), columns: { id: true, username: true } }) : undefined;
  if (!user) return html(c, loginPage({ uid: details.uid, csrf, client, error, username }));
  const { scopes } = requestedScopes(details);
  const mailboxes = await db.select({ id: accounts.id, name: accounts.name, email: accounts.email }).from(accounts).orderBy(accounts.id);
  return html(c, consentPage({ uid: details.uid, csrf, client, username: user.username, scopes, mailboxes, error, keep }));
}

const expired = (c: C) => html(c, errorPage(L('授权请求已失效', 'Authorization request expired'), L('授权请求已过期或已经处理过，请回到发起授权的应用重新连接。', 'The authorization request has expired or was already handled. Go back to the app that started it and reconnect.')), 400);

function withProvider(c: C) {
  const p = getOAuthProvider();
  if (!p) return null;
  return p;
}

export const oauthRoutes = new Hono<Env>()
  // ---- 受保护资源元数据（RFC 9728），无需登录 ----
  .get('/.well-known/oauth-protected-resource/*', (c) => {
    if (!config.mcpOAuth.enabled) return c.notFound();
    // 资源路径插入（/.well-known/oauth-protected-resource/mcp）和根路径都返回同一份元数据
    const pathname = new URL(c.req.url).pathname.replace(/\/+$/, '');
    if (pathname !== new URL(resourceMetadataUrl()).pathname && pathname !== '/.well-known/oauth-protected-resource') return c.notFound();
    c.header('Access-Control-Allow-Origin', '*');
    return c.json(protectedResourceMetadata());
  })
  // ---- 授权服务器元数据：RFC 8414 与 OIDC Discovery 返回同一份由 oidc-provider 生成的文档 ----
  .get('/.well-known/oauth-authorization-server', async (c) => {
    const p = withProvider(c);
    if (!p) return c.notFound();
    await delegateToProvider(p, c.env.incoming, c.env.outgoing, '/.well-known/openid-configuration');
    return RESPONSE_ALREADY_SENT;
  })
  .get('/.well-known/openid-configuration', async (c) => {
    const p = withProvider(c);
    if (!p) return c.notFound();
    await delegateToProvider(p, c.env.incoming, c.env.outgoing);
    return RESPONSE_ALREADY_SENT;
  })

  // ---- 交给 oidc-provider 的协议端点 ----
  .all(`${OAUTH_ROUTES.authorization}/*`, async (c) => {
    const p = withProvider(c);
    if (!p) return c.notFound();
    await delegateToProvider(p, c.env.incoming, c.env.outgoing);
    return RESPONSE_ALREADY_SENT;
  })
  .on(['GET', 'POST'], OAUTH_ROUTES.authorization, async (c) => {
    const p = withProvider(c);
    if (!p) return c.notFound();
    if (limited(c, 'authorize', config.mcpOAuth.rateLimitPerMin, 60_000)) return html(c, errorPage(L('请求过于频繁', 'Too many requests'), L('请稍后再试。', 'Try again later.')), 429);
    await delegateToProvider(p, c.env.incoming, c.env.outgoing);
    return RESPONSE_ALREADY_SENT;
  })
  .on(['POST', 'OPTIONS'], [OAUTH_ROUTES.token, OAUTH_ROUTES.revocation], async (c) => {
    const p = withProvider(c);
    if (!p) return c.notFound();
    if (c.req.method === 'POST' && limited(c, 'token', config.mcpOAuth.rateLimitPerMin, 60_000))
      return c.json({ error: 'temporarily_unavailable', error_description: 'too many requests' }, 429);
    await delegateToProvider(p, c.env.incoming, c.env.outgoing);
    return RESPONSE_ALREADY_SENT;
  })
  .get(OAUTH_ROUTES.jwks, async (c) => {
    const p = withProvider(c);
    if (!p) return c.notFound();
    await delegateToProvider(p, c.env.incoming, c.env.outgoing);
    return RESPONSE_ALREADY_SENT;
  })

  // ---- 登录与同意页 ----
  .get(`${INTERACTION_PATH}/:uid`, async (c) => {
    const p = withProvider(c);
    if (!p) return c.notFound();
    const details = await loadInteraction(p, c);
    if (!details) return expired(c);
    const { unknown } = requestedScopes(details);
    if (unknown.length) return finish(p, c, { error: 'invalid_scope', error_description: `unsupported scope: ${unknown.join(' ')}` });
    if (!requestedScopes(details).scopes.length)
      return finish(p, c, { error: 'invalid_scope', error_description: `request at least one of: ${RESOURCE_SCOPES.join(' ')} (start with ${BASE_SCOPES.join(' ')})` });
    if (!resourceOk(details)) return finish(p, c, { error: 'invalid_target', error_description: 'unknown resource' });
    return renderInteraction(p, c, details);
  })
  .post(`${INTERACTION_PATH}/:uid/login`, async (c) => {
    const p = withProvider(c);
    if (!p) return c.notFound();
    const form = await c.req.parseBody();
    if (!csrfOk(c, form)) return html(c, errorPage(L('请求无效', 'Invalid request'), L('页面已过期，请返回重新打开授权页面。', 'This page has expired. Go back and open the authorization page again.')), 403);
    const details = await loadInteraction(p, c);
    if (!details) return expired(c);
    if (loginBlocked(c)) return renderInteraction(p, c, details, L('尝试次数过多，请 10 分钟后再试', 'Too many attempts. Try again in 10 minutes'));
    const username = typeof form.username === 'string' ? form.username.trim().slice(0, 64) : '';
    const password = typeof form.password === 'string' ? form.password.slice(0, 200) : '';
    const user = username ? await db.query.users.findFirst({ where: eq(users.username, username) }) : undefined;
    if (!user || !password || !(await verifyPassword(password, user.passwordHash))) {
      loginFailed(c);
      return renderInteraction(p, c, details, L('用户名或密码错误', 'Incorrect username or password'), username);
    }
    await issueSession(c, user.id);
    return c.redirect(`${INTERACTION_PATH}/${details.uid}`, 303);
  })
  .post(`${INTERACTION_PATH}/:uid/switch`, async (c) => {
    const form = await c.req.parseBody();
    if (!csrfOk(c, form)) return html(c, errorPage(L('请求无效', 'Invalid request'), L('页面已过期，请返回重新打开授权页面。', 'This page has expired. Go back and open the authorization page again.')), 403);
    clearSession(c);
    return c.redirect(`${INTERACTION_PATH}/${encodeURIComponent(c.req.param('uid'))}`, 303);
  })
  .post(`${INTERACTION_PATH}/:uid/abort`, async (c) => {
    const p = withProvider(c);
    if (!p) return c.notFound();
    const form = await c.req.parseBody();
    if (!csrfOk(c, form)) return html(c, errorPage(L('请求无效', 'Invalid request'), L('页面已过期，请返回重新打开授权页面。', 'This page has expired. Go back and open the authorization page again.')), 403);
    const details = await loadInteraction(p, c);
    if (!details || details.result) return expired(c);
    const uid = await readSession(c);
    audit(uid ? `user:${uid}` : 'anonymous', 'mcp_oauth.deny', { detail: { clientId: details.params.client_id } });
    return finish(p, c, { error: 'access_denied', error_description: 'The user denied the request' });
  })
  .post(`${INTERACTION_PATH}/:uid/confirm`, async (c) => {
    const p = withProvider(c);
    if (!p) return c.notFound();
    const form = await c.req.parseBody({ all: true });
    if (!csrfOk(c, form)) return html(c, errorPage(L('请求无效', 'Invalid request'), L('页面已过期，请返回重新打开授权页面。', 'This page has expired. Go back and open the authorization page again.')), 403);
    const details = await loadInteraction(p, c);
    // 已经提交过（重复点击 / 重放表单）不再签发第二个授权
    if (!details || details.result || inFlight.has(details.uid)) return expired(c);
    const userId = await readSession(c);
    if (!userId) return c.redirect(`${INTERACTION_PATH}/${details.uid}`, 303);
    const requested = requestedScopes(details);
    if (requested.unknown.length || !requested.scopes.length || !resourceOk(details)) return expired(c);

    const picked = ([] as unknown[]).concat(form.scope ?? []).map(String);
    const scopes = requested.scopes.filter((s) => picked.includes(s));
    const chosen = new Set(([] as unknown[]).concat(form.account ?? []).map((v) => Number(v)));
    const keep: Keep = { scopes, mailboxes: form.mailboxes === 'selected' ? 'selected' : 'all', accounts: [...chosen] };
    if (!scopes.length) return renderInteraction(p, c, details, L('请至少勾选一项权限，或者点击“拒绝”', 'Select at least one permission, or click "Deny"'), undefined, keep);

    let accountIds: number[] | null = null;
    if (form.mailboxes === 'selected') {
      const existing = await db.select({ id: accounts.id }).from(accounts);
      accountIds = existing.map((a) => a.id).filter((id) => chosen.has(id));
      if (!accountIds.length) return renderInteraction(p, c, details, L('选择“指定邮箱”时，请至少勾选一个邮箱', 'When choosing "Selected mailboxes", select at least one mailbox'), undefined, keep);
    }

    inFlight.add(details.uid);
    try {
      const clientId = String(details.params.client_id);
      const client = await clientInfo(p, clientId);
      const grant = new p.Grant({ accountId: String(userId), clientId });
      grant.addResourceScope(config.mcpOAuth.resource, scopes.join(' '));
      // 用户取消勾选的 scope 记为拒绝，否则 oidc-provider 会认为还有未处理的权限而再次要求同意
      const rejected = requested.scopes.filter((s) => !scopes.includes(s));
      if (rejected.length) grant.rejectResourceScope(config.mcpOAuth.resource, rejected.join(' '));
      if (requested.offline) grant.addOIDCScope('offline_access');
      const grantId = await grant.save();
      const [row] = await db
        .insert(mcpAuthorizations)
        .values({ grantId, userId, clientId, clientName: client.clientName, resource: config.mcpOAuth.resource, scopes, accountIds })
        .returning({ id: mcpAuthorizations.id });
      audit(`user:${userId}`, 'mcp_oauth.grant', { target: `oauth:${row!.id}`, detail: { clientId, scopes, accountIds } });
      return await finish(p, c, { login: { accountId: String(userId), remember: false }, consent: { grantId } });
    } finally {
      inFlight.delete(details.uid);
    }
  });
