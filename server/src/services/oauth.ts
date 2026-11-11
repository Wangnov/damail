import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { accounts, settings, type Account } from '../db/schema.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { ActionError } from './actions.js';
import { fetchVia, proxyUrlById } from './proxy.js';
import { L } from '../i18n/index.js';

/**
 * 邮箱的 OAuth2 登录：Microsoft（Outlook / Hotmail / Microsoft 365）和 Google（Gmail）。
 * 用户在服务商后台注册自己的应用，把 Client ID / Secret 填到这里；令牌只在本服务器和服务商之间流转。
 * 账户的 secretEnc 里存的是加密后的 { refreshToken, accessToken, expiresAt }，IMAP / SMTP 用 XOAUTH2 认证。
 */

export const OAUTH_PROVIDERS = ['microsoft', 'google'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

type Server = { host: string; port: number; secure: boolean };

type ProviderSpec = {
  label: string;
  scopes: string[];
  authorizeUrl: (c: StoredConfig) => string;
  tokenUrl: (c: StoredConfig) => string;
  authorizeParams: Record<string, string>;
  /** 微软的令牌接口要求带 scope，Google 不需要 */
  tokenScope: boolean;
  /** 新建账户时的服务商和服务器；protocol 为 graph 时 imap/smtp 只作占位 */
  account: { provider: string; protocol: 'imap' | 'graph'; imap: Server; smtp: Server };
};

const SPECS: Record<OAuthProvider, ProviderSpec> = {
  microsoft: {
    get label() {
      return L('微软', 'Microsoft');
    },
    // 走 Graph API 收发信：部分个人账号（如 msn.cn）IMAP 登录成功却打不开邮箱
    scopes: [
      'offline_access',
      'openid',
      'email',
      'profile',
      'https://graph.microsoft.com/Mail.ReadWrite',
      'https://graph.microsoft.com/Mail.Send',
      'https://graph.microsoft.com/User.Read',
    ],
    authorizeUrl: (c) => `https://login.microsoftonline.com/${encodeURIComponent(c.tenant || 'common')}/oauth2/v2.0/authorize`,
    tokenUrl: (c) => `https://login.microsoftonline.com/${encodeURIComponent(c.tenant || 'common')}/oauth2/v2.0/token`,
    authorizeParams: { response_mode: 'query', prompt: 'select_account' },
    tokenScope: true,
    account: {
      provider: 'outlook',
      protocol: 'graph',
      imap: { host: 'outlook.office365.com', port: 993, secure: true },
      smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    },
  },
  google: {
    label: 'Google',
    // mail.google.com 是 Gmail IMAP / SMTP 唯一可用的范围
    scopes: ['openid', 'email', 'profile', 'https://mail.google.com/'],
    authorizeUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    // offline + consent 才会每次都返回 refresh token
    authorizeParams: { access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true' },
    tokenScope: false,
    account: {
      provider: 'gmail',
      protocol: 'imap',
      imap: { host: 'imap.gmail.com', port: 993, secure: true },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    },
  },
};

/** 已有 OAuth 账户用的是哪家 */
export const oauthProviderOf = (account: Pick<Account, 'provider'>): OAuthProvider => (account.provider === 'gmail' ? 'google' : 'microsoft');

export const oauthRedirectUri = (p: OAuthProvider) => `${config.publicUrl.replace(/\/+$/, '')}/api/oauth/${p}/callback`;

type StoredConfig = { clientId: string; tenant?: string; clientSecretEnc: string | null; proxyId?: number | null };

export const oauthConfigInput = z.object({
  clientId: z
    .string()
    .trim()
    .min(1, { error: () => L('请填写 Client ID', 'Enter the Client ID') })
    .max(300),
  // 只有微软用到租户
  tenant: z
    .string()
    .trim()
    .regex(/^[\w.-]*$/, { error: () => L('租户格式不对', 'Invalid tenant') })
    .optional(),
  // 不填表示保留原来的
  clientSecret: z.string().trim().max(500).optional(),
  // 连服务商（授权、新邮箱）用的代理
  proxyId: z.number().int().positive().nullish(),
});

const settingsKey = (p: OAuthProvider) => `oauth.${p}`;

async function loadConfig(p: OAuthProvider): Promise<StoredConfig | null> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, settingsKey(p)) });
  return (row?.value as StoredConfig | undefined) ?? null;
}

// 客户端密钥只给前端看首尾几位，中间用星号
const maskSecret = (v: string) => (v.length > 12 ? `${v.slice(0, 4)}${'*'.repeat(8)}${v.slice(-4)}` : '*'.repeat(8));

export async function getOAuthConfig(p: OAuthProvider) {
  const c = await loadConfig(p);
  return {
    clientId: c?.clientId ?? '',
    tenant: c?.tenant || 'common',
    hasSecret: Boolean(c?.clientSecretEnc),
    secretHint: c?.clientSecretEnc ? maskSecret(decryptSecret(c.clientSecretEnc)) : null,
    redirectUri: oauthRedirectUri(p),
    proxyId: c?.proxyId ?? null,
  };
}

export async function saveOAuthConfig(p: OAuthProvider, input: unknown) {
  const data = oauthConfigInput.parse(input);
  const prev = await loadConfig(p);
  const value: StoredConfig = {
    clientId: data.clientId,
    // 页面上不再填租户（默认 common：个人邮箱和多组织），以前填过的保留
    ...(p === 'microsoft' ? { tenant: data.tenant || prev?.tenant || 'common' } : {}),
    clientSecretEnc: data.clientSecret ? encryptSecret(data.clientSecret) : (prev?.clientSecretEnc ?? null),
    proxyId: data.proxyId ?? null,
  };
  await db
    .insert(settings)
    .values({ key: settingsKey(p), value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
  return getOAuthConfig(p);
}

// ---- 授权流程 ----

type PendingAuth = { provider: OAuthProvider; userId: number; verifier: string; accountId?: number; expires: number };
const pending = new Map<string, PendingAuth>();
// 已用过的 state 记住结果：服务商偶尔会把同一次授权连着回调两次（授权码不同），第二次直接沿用第一次的结果
type CompletedAuth = { provider: OAuthProvider; userId: number; result: Promise<Account>; expires: number };
const completed = new Map<string, CompletedAuth>();

const b64url = (b: Buffer) => b.toString('base64url');

export async function oauthAuthorizeUrl(p: OAuthProvider, userId: number, accountId?: number) {
  const spec = SPECS[p];
  const c = await loadConfig(p);
  if (!c?.clientId) throw new ActionError(L(`请先在设置 → 授权应用里配置${spec.label}应用`, `Set up the ${spec.label} app under Settings → OAuth apps first`));
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  for (const [k, v] of completed) if (v.expires < now) completed.delete(k);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  pending.set(state, { provider: p, userId, verifier, accountId, expires: now + 10 * 60_000 });
  const params = new URLSearchParams({
    client_id: c.clientId,
    response_type: 'code',
    redirect_uri: oauthRedirectUri(p),
    scope: spec.scopes.join(' '),
    state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    ...spec.authorizeParams,
  });
  // 重新授权时直接定位到原来的账号
  if (accountId) {
    const account = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
    if (account) params.set('login_hint', account.email);
  }
  return `${spec.authorizeUrl(c)}?${params}`;
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number; id_token?: string; error?: string; error_description?: string };
type StoredTokens = { refreshToken: string; accessToken: string; expiresAt: number };

/** proxyId 为 undefined 时用 OAuth 应用设置的代理 */
async function tokenRequest(p: OAuthProvider, body: Record<string, string>, proxyId?: number | null): Promise<TokenResponse> {
  const spec = SPECS[p];
  const c = await loadConfig(p);
  if (!c?.clientId) throw new ActionError(L(`${spec.label}应用未配置`, `${spec.label} app is not configured`));
  const form = new URLSearchParams({ client_id: c.clientId, ...(spec.tokenScope ? { scope: spec.scopes.join(' ') } : {}), ...body });
  if (c.clientSecretEnc) form.set('client_secret', decryptSecret(c.clientSecretEnc));
  const res = await fetchVia(await proxyUrlById(proxyId === undefined ? c.proxyId : proxyId), spec.tokenUrl(c), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token)
    throw new Error(
      data.error_description?.split('\n')[0] || data.error || L(`${spec.label}登录失败（${res.status}）`, `${spec.label} sign-in failed (${res.status})`),
    );
  return data;
}

/** id_token 直接从服务商的令牌接口拿到（TLS），这里只读取声明，不再验签 */
function emailFromIdToken(idToken?: string) {
  if (!idToken) return null;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString('utf8')) as {
      email?: string;
      preferred_username?: string;
      name?: string;
    };
    const email = claims.email || claims.preferred_username;
    return email && email.includes('@') ? { email: email.toLowerCase(), name: claims.name ?? null } : null;
  } catch {
    return null;
  }
}

/** 回调：用授权码换令牌，新建或更新账户，返回账户 */
export async function completeOAuth(p: OAuthProvider, userId: number, state: string, code: string): Promise<Account> {
  const done = completed.get(state);
  if (done && done.expires > Date.now() && done.userId === userId && done.provider === p) return done.result;
  const pend = pending.get(state);
  pending.delete(state);
  if (!pend || pend.expires < Date.now() || pend.userId !== userId || pend.provider !== p)
    throw new Error(L('授权已过期，请重新发起', 'Authorization expired; start again'));
  const result = exchangeCode(p, pend, code);
  completed.set(state, { provider: p, userId, result, expires: Date.now() + 10 * 60_000 });
  return result;
}

async function exchangeCode(p: OAuthProvider, pend: PendingAuth, code: string): Promise<Account> {
  const spec = SPECS[p];
  // 重新授权已有邮箱时沿用它的代理，新邮箱用 OAuth 应用设置的代理
  const reauth = pend.accountId ? await db.query.accounts.findFirst({ where: eq(accounts.id, pend.accountId) }) : undefined;
  const c = await loadConfig(p);
  const proxyId = reauth ? reauth.proxyId : (c?.proxyId ?? null);
  const t = await tokenRequest(p, { grant_type: 'authorization_code', code, redirect_uri: oauthRedirectUri(p), code_verifier: pend.verifier }, proxyId);
  if (!t.refresh_token)
    throw new Error(
      L(
        `${spec.label}没有返回 refresh token，请检查应用权限后重新授权`,
        `${spec.label} did not return a refresh token; check the app permissions and authorize again`,
      ),
    );
  const who = emailFromIdToken(t.id_token);
  if (!who) throw new Error(L(`无法从${spec.label}账号读取邮箱地址`, `Could not read the email address from the ${spec.label} account`));
  const secretEnc = encryptSecret(
    JSON.stringify({ refreshToken: t.refresh_token, accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 } satisfies StoredTokens),
  );

  const existing = pend.accountId ? reauth : await db.query.accounts.findFirst({ where: eq(accounts.email, who.email) });
  if (existing) {
    if (pend.accountId && existing.email.toLowerCase() !== who.email)
      throw new Error(
        L(
          `登录的${spec.label}账号（${who.email}）和要重新授权的邮箱（${existing.email}）不一致`,
          `The signed-in ${spec.label} account (${who.email}) does not match the mailbox being re-authorized (${existing.email})`,
        ),
      );
    tokenCache.delete(existing.id);
    // 原来用密码直连的同一个邮箱，改成 OAuth 并换上服务商的服务器
    const servers = existing.authType === 'oauth2' ? {} : serverFields(spec);
    const [row] = await db
      .update(accounts)
      .set({ ...servers, authType: 'oauth2', protocol: spec.account.protocol, secretEnc, username: who.email, status: 'connecting', lastError: null })
      .where(eq(accounts.id, existing.id))
      .returning();
    return row!;
  }
  const [row] = await db
    .insert(accounts)
    .values({
      name: who.email,
      email: who.email,
      displayName: who.name,
      ...serverFields(spec),
      username: who.email,
      authType: 'oauth2',
      protocol: spec.account.protocol,
      secretEnc,
      proxyId,
    })
    .returning();
  return row!;
}

function serverFields(spec: ProviderSpec) {
  const { provider, imap, smtp } = spec.account;
  return {
    provider,
    imapHost: imap.host,
    imapPort: imap.port,
    imapSecure: imap.secure,
    smtpHost: smtp.host,
    smtpPort: smtp.port,
    smtpSecure: smtp.secure,
  };
}

// ---- 取用凭证 ----

const tokenCache = new Map<number, { token: string; expiresAt: number }>();
const refreshing = new Map<number, Promise<string>>();

async function refreshAccessToken(accountId: number): Promise<string> {
  // 重新读一次，拿到最新轮换过的 refresh token
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  if (!account) throw new Error(L('账户不存在', 'Account not found'));
  const p = oauthProviderOf(account);
  const stored = JSON.parse(decryptSecret(account.secretEnc)) as StoredTokens;
  if (stored.accessToken && stored.expiresAt - Date.now() > 5 * 60_000) {
    tokenCache.set(account.id, { token: stored.accessToken, expiresAt: stored.expiresAt });
    return stored.accessToken;
  }
  let t: TokenResponse;
  try {
    t = await tokenRequest(p, { grant_type: 'refresh_token', refresh_token: stored.refreshToken }, account.proxyId);
  } catch (err) {
    throw new Error(
      L(
        `${SPECS[p].label}授权已失效，请在邮箱管理里重新授权：${(err as Error).message}`,
        `${SPECS[p].label} authorization has expired; re-authorize it under Mailboxes: ${(err as Error).message}`,
      ),
    );
  }
  // 微软会轮换 refresh token，新的要存回去；Google 通常不返回新的，沿用旧的
  const next: StoredTokens = { refreshToken: t.refresh_token ?? stored.refreshToken, accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
  await db
    .update(accounts)
    .set({ secretEnc: encryptSecret(JSON.stringify(next)) })
    .where(eq(accounts.id, account.id));
  tokenCache.set(account.id, { token: next.accessToken, expiresAt: next.expiresAt });
  return next.accessToken;
}

export type Credentials = { password: string; accessToken?: undefined } | { accessToken: string; password?: undefined };

/** IMAP / SMTP 登录用的凭证：密码账户直接解密，OAuth 账户返回有效的 access token（必要时刷新） */
export async function accountCredentials(account: Account): Promise<Credentials> {
  if (account.authType !== 'oauth2') return { password: decryptSecret(account.secretEnc) };
  const cached = tokenCache.get(account.id);
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return { accessToken: cached.token };
  let p = refreshing.get(account.id);
  if (!p) {
    p = refreshAccessToken(account.id).finally(() => refreshing.delete(account.id));
    refreshing.set(account.id, p);
  }
  return { accessToken: await p };
}
