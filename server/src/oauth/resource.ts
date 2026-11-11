import { and, eq, isNull, or, sql, lt } from 'drizzle-orm';
import type { AuthContext } from '../auth/index.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { mcpAuthorizations } from '../db/schema.js';
import { PgAdapter } from './adapter.js';
import { isAllowedClientId } from './provider.js';
import { BASE_SCOPES, internalScopes, isOAuthScope, type OAuthScope } from './scopes.js';

/**
 * MCP 资源服务器侧的令牌校验。每次 /mcp 请求都查库：
 * 令牌存在且未过期、audience 是本 MCP 资源、客户端仍在白名单、授权未撤销且用户 / 客户端一致。
 * 只接受本授权服务器签发给 MCP 资源的令牌，不接受也不透传任何其他令牌（包括邮件服务商的）。
 */

const accessTokens = new PgAdapter('AccessToken');

/** RFC 9728：资源路径插入到 well-known 后缀之后 */
export function resourceMetadataUrl() {
  const r = new URL(config.mcpOAuth.resource);
  const path = r.pathname === '/' ? '' : r.pathname;
  return `${r.origin}/.well-known/oauth-protected-resource${path}`;
}

export function protectedResourceMetadata() {
  return {
    resource: config.mcpOAuth.resource,
    authorization_servers: [config.mcpOAuth.issuer],
    // 只列基础只读权限；写草稿 / 整理 / 发送在需要时通过 insufficient_scope 逐步申请
    scopes_supported: BASE_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'DaMail',
  };
}

// RFC 6750：参数值只能是可见 ASCII，且不能含 " 和 \
const quote = (v: string) => `"${v.replace(/[^\x20-\x7e]|["\\]/g, '')}"`;

export function challenge401(error?: { code: 'invalid_token' | 'invalid_request'; description: string }) {
  const parts = [`resource_metadata=${quote(resourceMetadataUrl())}`, `scope=${quote(BASE_SCOPES.join(' '))}`];
  if (error) parts.push(`error=${quote(error.code)}`, `error_description=${quote(error.description)}`);
  return `Bearer ${parts.join(', ')}`;
}

export function challenge403(scopes: OAuthScope[], description: string) {
  return `Bearer error="insufficient_scope", scope=${quote(scopes.join(' '))}, resource_metadata=${quote(resourceMetadataUrl())}, error_description=${quote(description)}`;
}

function audienceMatches(aud: unknown) {
  const list = Array.isArray(aud) ? aud : [aud];
  return list.length === 1 && list[0] === config.mcpOAuth.resource;
}

export async function resolveOAuthToken(token: string): Promise<AuthContext | null> {
  if (!config.mcpOAuth.enabled || token.length < 20 || token.length > 512) return null;
  const at = (await accessTokens.find(token)) as Record<string, unknown> | undefined;
  if (!at || at.kind !== 'AccessToken') return null;
  if (typeof at.exp !== 'number' || at.exp * 1000 <= Date.now()) return null;
  if (!audienceMatches(at.aud)) return null;
  const clientId = String(at.clientId ?? '');
  const grantId = String(at.grantId ?? '');
  if (!clientId || !grantId || !isAllowedClientId(clientId)) return null;

  const authz = await db.query.mcpAuthorizations.findFirst({ where: eq(mcpAuthorizations.grantId, grantId) });
  if (!authz || authz.revokedAt) return null;
  if (String(authz.userId) !== String(at.accountId) || authz.clientId !== clientId || authz.resource !== config.mcpOAuth.resource) return null;

  // 令牌上的 scope 与用户在同意页实际授予的 scope 取交集，任何一方都不能单独扩权
  const tokenScopes = String(at.scope ?? '').split(' ').filter(isOAuthScope);
  const scopes = tokenScopes.filter((s) => authz.scopes.includes(s));

  // 每分钟最多更新一次最后使用时间
  void db
    .update(mcpAuthorizations)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(mcpAuthorizations.id, authz.id),
        isNull(mcpAuthorizations.revokedAt),
        or(isNull(mcpAuthorizations.lastUsedAt), lt(mcpAuthorizations.lastUsedAt, sql`now() - interval '1 minute'`)),
      ),
    )
    .catch(() => {});

  return {
    kind: 'oauth',
    userId: authz.userId,
    scopes: internalScopes(scopes),
    scope: { accountIds: authz.accountIds ?? null },
    oauth: { authorizationId: authz.id, clientId, scopes },
  };
}
