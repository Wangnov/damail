import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { apiKeys, users } from '../db/schema.js';
import { sha256, signSession, verifySession } from '../lib/crypto.js';
import { adoptUserLocale, t } from '../i18n/index.js';
import { challenge401, challenge403, resolveOAuthToken } from '../oauth/resource.js';
import { OAUTH_SCOPES, type OAuthScope } from '../oauth/scopes.js';
import type { Scope } from '../services/mail.js';

export type AuthContext = {
  kind: 'session' | 'apiKey' | 'oauth';
  userId: number;
  // 内部权限：read / organize / draft / send / automation / admin
  scopes: string[];
  scope: Scope;
  apiKeyId?: number;
  // MCP OAuth 授权（kind === 'oauth'）：scopes 为 mail:* 形式
  oauth?: { authorizationId: number; clientId: string; scopes: OAuthScope[] };
  // 规则等系统内部发起的操作，用于审计日志
  actor?: string;
};

export type AppEnv = { Variables: { auth: AuthContext } };

const COOKIE = 'dm_session';
const SESSION_SCOPES = ['read', 'organize', 'draft', 'send', 'automation', 'admin'];
const SESSION_TTL = 30 * 24 * 3600;

// pv 是密码哈希和会话纪元的指纹：改密码或退出登录后，旧会话（包括其他设备上、被复制走的）全部失效
type SessionPayload = { uid: number; exp: number; pv: string };
// 改密码和退出登录都会让纪元加一，所以纪元相同就意味着密码哈希也相同
type SessionState = { passwordHash: string; sessionEpoch: number };

// 纪元为 0 时保持旧算法，升级后已登录的会话不受影响
const sessionVersion = (u: SessionState) => sha256(u.sessionEpoch ? `${u.passwordHash}:${u.sessionEpoch}` : u.passwordHash).slice(0, 16);
const versions = new Map<number, { epoch: number; v: string }>();

/**
 * 更新缓存的会话指纹，只允许往前走：纪元不小于缓存里的才覆盖。
 * 读数据库和写缓存之间可能插进一次退出登录，晚到的旧数据不能把撤销后的状态改回去。
 */
function remember(userId: number, u: SessionState) {
  const cur = versions.get(userId);
  if (!cur || u.sessionEpoch >= cur.epoch) versions.set(userId, { epoch: u.sessionEpoch, v: sessionVersion(u) });
  return versions.get(userId)!.v;
}

const loadSessionState = (userId: number) =>
  db.query.users.findFirst({ where: eq(users.id, userId), columns: { passwordHash: true, sessionEpoch: true } });

async function currentVersion(userId: number) {
  const cached = versions.get(userId);
  if (cached) return cached.v;
  const user = await loadSessionState(userId);
  return user ? remember(userId, user) : null;
}

/**
 * 签发会话，传入调用方刚校验过的密码哈希。纪元在这里重新从数据库读取：
 * 校验密码期间可能已经退出登录（纪元加一），用旧数据签发会让撤销失效。
 * 密码哈希必须仍是校验过的那个：校验期间密码被改了，就不能用没校验过的新密码签发，返回 false。
 */
export async function issueSession(c: Context, verified: { id: number; passwordHash: string }): Promise<boolean> {
  const userId = verified.id;
  const user = await loadSessionState(userId);
  if (!user || user.passwordHash !== verified.passwordHash) return false;
  remember(userId, user);
  const token = signSession({ uid: userId, exp: Math.floor(Date.now() / 1000) + SESSION_TTL, pv: sessionVersion(user) } satisfies SessionPayload);
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: SESSION_TTL,
  });
  return true;
}

export function clearSession(c: Context) {
  deleteCookie(c, COOKIE, { path: '/' });
}

/** 让这个用户已签发的所有会话失效（退出登录时调用），只删 cookie 挡不住被复制走的会话 */
export async function revokeSessions(userId: number) {
  const [user] = await db
    .update(users)
    .set({ sessionEpoch: sql`${users.sessionEpoch} + 1` })
    .where(eq(users.id, userId))
    .returning({ passwordHash: users.passwordHash, sessionEpoch: users.sessionEpoch });
  if (user) remember(userId, user);
  else versions.delete(userId);
}

export async function readSession(c: Context): Promise<number | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const payload = verifySession<SessionPayload>(token);
  if (!payload || payload.exp < Date.now() / 1000) return null;
  if (!payload.pv || payload.pv !== (await currentVersion(payload.uid))) return null;
  return payload.uid;
}

async function resolveApiKey(token: string): Promise<AuthContext | null> {
  const key = await db.query.apiKeys.findFirst({
    where: and(eq(apiKeys.keyHash, sha256(token)), isNull(apiKeys.revokedAt)),
  });
  if (!key) return null;
  // 每分钟最多更新一次最后使用时间
  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(apiKeys.id, key.id), sql`(${apiKeys.lastUsedAt} IS NULL OR ${apiKeys.lastUsedAt} < now() - interval '1 minute')`))
    .catch(() => {});
  return {
    kind: 'apiKey',
    userId: key.userId,
    scopes: key.scopes,
    scope: { accountIds: key.accountIds ?? null },
    apiKeyId: key.id,
  };
}

const oauthScopeFor = (internal: string) =>
  (Object.keys(OAUTH_SCOPES) as OAuthScope[]).find((s) => OAUTH_SCOPES[s].internal === internal);

/**
 * 会话 Cookie 或 Bearer 令牌。凭证选择规则：
 * - 只要带了 Authorization 头，就只按 Bearer 令牌认证；格式不对或令牌无效直接 401，不回退到 Cookie
 * - dm_ 开头是 API Key；其他令牌只有 opts.oauth（/mcp）且启用了 MCP OAuth 时才按 OAuth access token 校验
 * - 没有 Authorization 头时才使用网页会话；不同凭证不会合并权限
 */
export function requireAuth(scope?: string, opts: { oauth?: boolean } = {}): MiddlewareHandler<AppEnv> {
  const oauthEnabled = () => Boolean(opts.oauth && config.mcpOAuth.enabled);
  const deny = (c: Parameters<MiddlewareHandler<AppEnv>>[0], error?: { code: 'invalid_token' | 'invalid_request'; description: string }) => {
    if (oauthEnabled()) c.header('WWW-Authenticate', challenge401(error));
    return c.json({ error: error ? error.code : 'unauthorized' }, 401);
  };
  return async (c, next) => {
    const header = c.req.header('authorization');
    let auth: AuthContext | null = null;
    if (header !== undefined) {
      const m = /^Bearer +([A-Za-z0-9\-._~+/]+=*) *$/i.exec(header);
      if (!m) return deny(c, { code: 'invalid_request', description: 'Authorization header must use the Bearer scheme' });
      const token = m[1]!;
      if (token.startsWith('dm_')) auth = await resolveApiKey(token);
      else if (oauthEnabled()) auth = await resolveOAuthToken(token);
      if (!auth) return deny(c, { code: 'invalid_token', description: 'The access token is invalid, expired or revoked' });
    } else {
      const uid = await readSession(c);
      if (uid) auth = { kind: 'session', userId: uid, scopes: SESSION_SCOPES, scope: { accountIds: null } };
    }
    if (!auth) return deny(c);
    await adoptUserLocale(auth.userId);
    if (scope && !auth.scopes.includes(scope)) {
      if (auth.kind === 'oauth') {
        const need = oauthScopeFor(scope);
        if (need && oauthEnabled()) c.header('WWW-Authenticate', challenge403([need], `This request requires the ${need} scope`));
        return c.json({ error: 'insufficient_scope', scope: need }, 403);
      }
      return c.json({ error: t().common.apiKeyMissingScope(scope) }, 403);
    }
    // 会话请求的写操作要求自定义请求头，防 CSRF
    if (auth.kind === 'session' && c.req.method !== 'GET' && c.req.header('x-damail') !== '1') {
      return c.json({ error: 'missing x-damail header' }, 403);
    }
    c.set('auth', auth);
    await next();
  };
}

/** 仅允许网页登录态（账户管理、API Key 管理） */
export function requireSession(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const uid = await readSession(c);
    if (!uid) return c.json({ error: 'unauthorized' }, 401);
    await adoptUserLocale(uid);
    if (c.req.method !== 'GET' && c.req.header('x-damail') !== '1') {
      return c.json({ error: 'missing x-damail header' }, 403);
    }
    c.set('auth', { kind: 'session', userId: uid, scopes: SESSION_SCOPES, scope: { accountIds: null } });
    await next();
  };
}

/** 在 requireAuth 之后使用，要求额外的权限 */
export function requireScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.var.auth.scopes.includes(scope)) return c.json({ error: t().common.missingScope(scope) }, 403);
    await next();
  };
}

export function actorOf(auth: AuthContext) {
  if (auth.actor) return auth.actor;
  if (auth.kind === 'apiKey') return `key:${auth.apiKeyId}`;
  if (auth.kind === 'oauth') return `oauth:${auth.oauth?.authorizationId}`;
  return `user:${auth.userId}`;
}
