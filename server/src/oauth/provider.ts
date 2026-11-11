import { createPrivateKey, hkdfSync } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import Provider, { errors, type Configuration, type KoaContextWithOIDC } from 'oidc-provider';
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { config } from '../config.js';
import { proxyAgent, proxyUrlById } from '../services/proxy.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { PgAdapter } from './adapter.js';
import { RESOURCE_SCOPES } from './scopes.js';
import { errorPage } from './pages.js';
import { L } from '../i18n/index.js';

/**
 * DaMail 自带的 OAuth 2.1 授权服务器，基于 oidc-provider（OpenID 认证过的成熟实现）。
 *
 * 角色划分：
 * - 授权服务器（issuer）：config.mcpOAuth.issuer，端点在 /oauth/*
 * - 受保护资源（MCP 服务）：config.mcpOAuth.resource，令牌 audience 与之绑定
 * - 客户端：ChatGPT（CIMD 或预注册），只接受精确配置的 client_id 和回调地址
 *
 * 只启用授权码 + PKCE(S256) 和 refresh token；不签发 ID Token，不开放动态注册、设备码、客户端凭证等。
 */

export const OAUTH_ROUTES = {
  authorization: '/oauth/authorize',
  token: '/oauth/token',
  revocation: '/oauth/revoke',
  jwks: '/oauth/jwks',
  userinfo: '/oauth/userinfo',
  end_session: '/oauth/logout',
  code_verification: '/oauth/device',
  device_authorization: '/oauth/device/auth',
  introspection: '/oauth/introspect',
  pushed_authorization_request: '/oauth/par',
  registration: '/oauth/register',
  backchannel_authentication: '/oauth/backchannel',
  challenge: '/oauth/challenge',
} as const;

/** oidc-provider 负责处理的路径（其余 /oauth/* 由 DaMail 自己的登录 / 同意页处理） */
export const PROVIDER_PATHS = [OAUTH_ROUTES.authorization, OAUTH_ROUTES.token, OAUTH_ROUTES.revocation, OAUTH_ROUTES.jwks];

function canonicalResource(value: string) {
  try {
    const u = new URL(value);
    if (u.hash || u.search) return null;
    // URL 解析会把协议和主机名转成小写；去掉末尾斜杠
    return u.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function isConfiguredResource(value: unknown) {
  return typeof value === 'string' && canonicalResource(value) === config.mcpOAuth.resource;
}

// 下面两处 HKDF 标签和 kid 沿用项目改名（MailHub → DaMail）前的名字，与 lib/crypto.ts 保持一致，不要修改

/** 由 MASTER_KEY 派生的 Ed25519 签名密钥（只用于 JWKS / 客户端断言之外的签名场景，本服务不签发 ID Token） */
function derivedJwks() {
  const seed = Buffer.from(hkdfSync('sha256', config.masterKey, Buffer.alloc(0), 'mailhub:oauth:ed25519', 32));
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const jwk = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ format: 'jwk' });
  return { keys: [{ ...jwk, alg: 'EdDSA', use: 'sig', kid: 'mailhub-ed25519-1' }] };
}

function cookieKeys() {
  return [Buffer.from(hkdfSync('sha256', config.masterKey, Buffer.alloc(0), 'mailhub:oauth:cookies', 32)).toString('base64url')];
}

/**
 * 某个客户端允许使用的回调地址（精确匹配）：
 * 预注册客户端用它自己的 redirect_uris；CIMD 客户端用网页设置里为它配置的地址，没有单独配置时用 MCP_OAUTH_REDIRECT_URIS
 */
export function redirectUrisFor(clientId: unknown) {
  const o = config.mcpOAuth;
  if (typeof clientId !== 'string') return new Set<string>();
  const stat = o.staticClients.find((c) => c.client_id === clientId);
  if (stat) return new Set(stat.redirect_uris);
  if (o.cimdClients.includes(clientId)) return new Set(o.cimdRedirects[clientId] ?? o.redirectUris);
  return new Set<string>();
}

export function isAllowedClientId(clientId: string) {
  return config.mcpOAuth.cimdClients.includes(clientId) || config.mcpOAuth.staticClients.some((c) => c.client_id === clientId);
}

export type ProviderOptions = {
  /** 测试用：替换 CIMD 文档抓取 */
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
  /** 测试用：替换经代理的底层请求（默认用 undici + DaMail 代理隧道） */
  proxiedRequest?: (url: string, init: RequestInit, proxy: string) => Promise<Response>;
};

/** 经代理抓取时允许访问的源：只有白名单里 CIMD client_id 所在的源（客户端的 JWKS 也需在同源） */
export function allowedFetchOrigins() {
  return new Set(config.mcpOAuth.cimdClients.map((u) => new URL(u).origin));
}

async function defaultProxiedRequest(url: string, init: RequestInit, proxy: string) {
  return (await undiciFetch(url, { ...(init as UndiciRequestInit), dispatcher: proxyAgent(proxy) })) as unknown as Response;
}

/**
 * 服务器直连不了客户端（如国内服务器访问 chatgpt.com）时，经「代理设置」里的代理抓取 CIMD 文档和 JWKS。
 * oidc-provider 原本的私网地址拦截作用在直连 socket 上，经代理时由“只允许白名单源”代替；超时放宽到 fetchTimeoutMs。
 */
export function createProxiedFetch(proxyId: number, request: NonNullable<ProviderOptions['proxiedRequest']>) {
  return async (url: string | URL, options: RequestInit & { dispatcher?: unknown } = {}) => {
    const target = new URL(String(url));
    if (target.protocol !== 'https:' || !allowedFetchOrigins().has(target.origin)) throw new Error(`outbound fetch not allowed: ${target.origin}`);
    const proxy = await proxyUrlById(proxyId);
    if (!proxy) throw new Error(L(`MCP_OAUTH_FETCH_PROXY_ID=${proxyId} 对应的代理不存在`, `The proxy for MCP_OAUTH_FETCH_PROXY_ID=${proxyId} does not exist`));
    const { dispatcher: _dispatcher, signal: _signal, ...rest } = options;
    const attempt = () => request(target.href, { ...rest, redirect: 'error', signal: AbortSignal.timeout(config.mcpOAuth.fetchTimeoutMs) }, proxy);
    const reason = (err: unknown) => {
      const e = err as Error & { cause?: Error & { code?: string } };
      return e.cause?.code ?? e.cause?.message ?? e.message;
    };
    try {
      return await attempt();
    } catch (err) {
      // 代理冷启动或跨境线路偶尔失败；抓的是只读的文档 / 公钥（GET），重试一次
      console.warn(`[oauth] 经代理抓取 ${target.origin}${target.pathname} 失败，重试一次：${reason(err)}`);
      if ((rest.method ?? 'GET').toUpperCase() !== 'GET') throw err;
      try {
        return await attempt();
      } catch (err2) {
        console.error(`[oauth] 经代理抓取 ${target.origin}${target.pathname} 再次失败：${reason(err2)}`);
        throw err2;
      }
    }
  };
}

function buildConfiguration(opts: ProviderOptions): Configuration {
  const o = config.mcpOAuth;
  const cimdEnabled = o.cimdClients.length > 0;
  const configuration: Configuration = {
    adapter: PgAdapter,
    clients: o.staticClients.map((c) => ({
      client_id: c.client_id,
      client_name: c.client_name,
      redirect_uris: c.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    })),
    clientDefaults: {
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      id_token_signed_response_alg: 'EdDSA',
    },
    // 公共客户端（PKCE）和 private_key_jwt（ChatGPT 的 CIMD 文档可能声明），不接受共享密钥
    clientAuthMethods: ['none', 'private_key_jwt'],
    enabledJWA: {
      idTokenSigningAlgValues: ['EdDSA'],
      clientAuthSigningAlgValues: ['ES256', 'ES384', 'ES512', 'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'EdDSA'],
    },
    jwks: derivedJwks(),
    cookies: { keys: cookieKeys() },
    routes: OAUTH_ROUTES,
    responseTypes: ['code'],
    scopes: ['offline_access'],
    claims: {},
    pkce: { required: () => true },
    allowOmittingSingleRegisteredRedirectUri: false,
    // 只认本次交互里用户刚同意产生的 Grant；以前的授权不会被自动复用，每次新的授权请求都要用户明确同意
    async loadExistingGrant(ctx) {
      const grantId = ctx.oidc.result?.consent?.grantId;
      return grantId ? ctx.oidc.provider.Grant.find(grantId) : undefined;
    },
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    rotateRefreshToken: true,
    expiresWithSession: async () => false,
    ttl: {
      AuthorizationCode: o.codeTtlSec,
      AccessToken: o.accessTokenTtlSec,
      RefreshToken: o.refreshTokenTtlSec,
      Grant: o.grantTtlSec,
      Interaction: 600,
      Session: 3600,
    },
    interactions: { url: async (_ctx, interaction) => `/oauth/interaction/${interaction.uid}` },
    async findAccount(_ctx, id) {
      const user = await db.query.users.findFirst({ where: eq(users.id, Number(id)), columns: { id: true } });
      if (!user) return undefined;
      return { accountId: String(user.id), claims: async () => ({ sub: String(user.id) }) };
    },
    features: {
      devInteractions: { enabled: false },
      introspection: { enabled: false },
      revocation: { enabled: true },
      userinfo: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      registration: { enabled: false },
      clientCredentials: { enabled: false },
      deviceFlow: { enabled: false },
      pushedAuthorizationRequests: { enabled: false },
      dPoP: { enabled: false },
      resourceIndicators: {
        enabled: true,
        // 授权请求必须显式带 resource（MCP 规范要求客户端发送）。换 token / 刷新时如果带了 resource 必须与授权时一致，
        // 没带则沿用授权时绑定的 resource，令牌 audience 不会变成别的资源
        async defaultResource(ctx) {
          if (ctx.oidc.params?.resource === undefined) throw new errors.InvalidTarget('resource parameter is required');
          return undefined as unknown as string;
        },
        async useGrantedResource() {
          return true;
        },
        async getResourceServerInfo(_ctx, resourceIndicator) {
          if (!isConfiguredResource(resourceIndicator)) throw new errors.InvalidTarget('unknown resource');
          return {
            scope: RESOURCE_SCOPES.join(' '),
            audience: o.resource,
            accessTokenTTL: o.accessTokenTtlSec,
            accessTokenFormat: 'opaque',
          };
        },
      },
      clientIdMetadataDocument: {
        enabled: cimdEnabled,
        ack: 'draft-02',
        // 只抓取配置里精确列出的 client_id URL，其余一律拒绝（防 SSRF，也限定本期只接 ChatGPT）
        async allowFetch(_ctx, clientId) {
          return o.cimdClients.includes(clientId);
        },
        async allowClient(_ctx, client) {
          if (!o.cimdClients.includes(client.clientId)) return false;
          if (!['none', 'private_key_jwt'].includes(client.clientAuthMethod ?? '')) return false;
          // 文档里至少有一个回调地址在白名单内；具体请求用的回调地址另行精确校验
          const allowed = redirectUrisFor(client.clientId);
          return (client.redirectUris ?? []).some((u: string) => allowed.has(u));
        },
        cacheDuration: { min: 60, max: 3600 },
      },
    },
    async renderError(ctx, out) {
      ctx.type = 'html';
      ctx.body = errorPage(L('授权请求无效', 'Invalid authorization request'), String(out.error_description ?? out.error ?? L('请求无效', 'Invalid request')));
    },
  };
  if (opts.fetch) (configuration as Record<string, unknown>).fetch = opts.fetch;
  else if (o.fetchProxyId) (configuration as Record<string, unknown>).fetch = createProxiedFetch(o.fetchProxyId, opts.proxiedRequest ?? defaultProxiedRequest);
  return configuration;
}

let provider: Provider | undefined;

export function createOAuthProvider(opts: ProviderOptions = {}) {
  const p = new Provider(config.mcpOAuth.issuer, buildConfiguration(opts));
  // 由我们在转发前改写 X-Forwarded-* 为 issuer 的协议和主机，生成的 URL 与 issuer 一致，不信任客户端传入的值
  p.proxy = true;

  // 授权请求里的 redirect_uri 必须在白名单内；不在名单内时直接显示错误页，不跳转到不可信地址
  p.use(async (ctx: KoaContextWithOIDC, next) => {
    if (ctx.path === OAUTH_ROUTES.authorization) {
      const redirect = ctx.query.redirect_uri;
      if (typeof redirect !== 'string' || !redirectUrisFor(ctx.query.client_id).has(redirect)) {
        ctx.status = 400;
        ctx.type = 'html';
        ctx.body = errorPage(L('授权请求无效', 'Invalid authorization request'), L('回调地址不在 DaMail 允许的名单内。', 'The redirect URI is not on the DaMail allowlist.'));
        return;
      }
      const method = ctx.query.code_challenge_method;
      if (method !== undefined && method !== 'S256') {
        ctx.status = 400;
        ctx.type = 'html';
        ctx.body = errorPage(L('授权请求无效', 'Invalid authorization request'), L('只支持 PKCE S256。', 'Only PKCE S256 is supported.'));
        return;
      }
    }
    await next();
  });

  // 元数据只声明真正支持的 scope：DaMail 资源权限 + offline_access（oidc-provider 默认还会列出 openid）
  p.use(async (ctx: KoaContextWithOIDC, next) => {
    await next();
    if (ctx.path === '/.well-known/openid-configuration' && ctx.status === 200 && ctx.body && typeof ctx.body === 'object') {
      const doc = ctx.body as Record<string, unknown>;
      doc.scopes_supported = [...RESOURCE_SCOPES, 'offline_access'];
      delete doc.claims_supported;
      delete doc.claims_parameter_supported;
      delete doc.claim_types_supported;
      delete doc.subject_types_supported;
      delete doc.id_token_signing_alg_values_supported;
    }
  });

  p.on('server_error', (_ctx, err) => console.error('[oauth] server_error', err.message));
  return p;
}

export function getOAuthProvider() {
  if (!config.mcpOAuth.enabled) return undefined;
  provider ??= createOAuthProvider();
  return provider;
}

/** 测试用：注入自定义 provider */
export function setOAuthProvider(p: Provider | undefined) {
  provider = p;
}

/** 把 Node 原生请求交给 oidc-provider；返回时响应已经写完 */
export function delegateToProvider(p: Provider, req: IncomingMessage, res: ServerResponse, rewritePath?: string) {
  const issuer = new URL(config.mcpOAuth.issuer);
  req.headers['x-forwarded-proto'] = issuer.protocol.replace(':', '');
  req.headers['x-forwarded-host'] = issuer.host;
  if (rewritePath) req.url = rewritePath;
  return new Promise<void>((resolve, reject) => {
    res.once('finish', resolve);
    res.once('close', resolve);
    Promise.resolve(p.callback()(req, res)).catch(reject);
  });
}
