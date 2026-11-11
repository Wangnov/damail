import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { requireSession, type AppEnv } from '../auth/index.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { accounts, mcpAuthorizations } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { revokeGrant } from '../oauth/adapter.js';
import { resourceMetadataUrl } from '../oauth/resource.js';
import { OAUTH_SCOPES } from '../oauth/scopes.js';
import { currentSettings, inspectClient, saveMcpOAuthSettings } from '../oauth/settings.js';
import { L } from '../i18n/index.js';

/** 网页上查看和撤销 MCP OAuth 授权（只允许网页登录态） */
export const mcpOAuthAdminRoutes = new Hono<AppEnv>()
  .use(requireSession())
  .get('/mcp-oauth', (c) => {
    const o = config.mcpOAuth;
    return c.json({
      enabled: o.enabled,
      issuer: o.issuer,
      resource: o.resource,
      resourceMetadata: o.enabled ? resourceMetadataUrl() : null,
      clients: [...o.cimdClients, ...o.staticClients.map((s) => s.client_id)],
      redirectUris: o.redirectUris,
      scopes: Object.entries(OAUTH_SCOPES).map(([name, s]) => ({ name, label: s.label, description: s.description })),
      sendLimitPerHour: o.sendLimitPerHour,
      settings: currentSettings(),
    });
  })
  // 保存网页设置：立即生效，不需要重启
  .put('/mcp-oauth/settings', async (c) => {
    try {
      const next = await saveMcpOAuthSettings(await c.req.json());
      audit(`user:${c.var.auth.userId}`, 'mcp_oauth.settings', {
        detail: {
          enabled: next.enabled,
          clients: next.clients.map((x) => x.clientId),
          fetchProxyId: next.fetchProxyId,
          sendLimitPerHour: next.sendLimitPerHour,
        },
      });
      return c.json(next);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  })
  // 读取 CIMD 客户端元数据文档，添加客户端前确认名称和回调地址
  .post('/mcp-oauth/inspect-client', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { clientId?: unknown; proxyId?: unknown };
    if (typeof body.clientId !== 'string') return c.json({ error: L('请填写 Client ID', 'Enter the Client ID') }, 400);
    const proxyId = typeof body.proxyId === 'number' ? body.proxyId : null;
    try {
      return c.json(await inspectClient(body.clientId.trim(), proxyId));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  })
  .get('/mcp-authorizations', async (c) => {
    // 有效的全部列出，已撤销的只保留最近 30 天
    const rows = await db
      .select()
      .from(mcpAuthorizations)
      .where(or(isNull(mcpAuthorizations.revokedAt), gt(mcpAuthorizations.revokedAt, new Date(Date.now() - 30 * 86_400_000))))
      .orderBy(desc(mcpAuthorizations.createdAt))
      .limit(200);
    const names = new Map((await db.select({ id: accounts.id, email: accounts.email }).from(accounts)).map((a) => [a.id, a.email]));
    return c.json(
      rows.map((r) => ({
        id: r.id,
        clientId: r.clientId,
        clientName: r.clientName,
        scopes: r.scopes,
        accounts: r.accountIds ? r.accountIds.map((id) => ({ id, email: names.get(id) ?? null })) : null,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
        revokedAt: r.revokedAt,
        revokeReason: r.revokeReason,
      })),
    );
  })
  .delete('/mcp-authorizations/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const row = await db.query.mcpAuthorizations.findFirst({
      where: and(eq(mcpAuthorizations.id, id), isNull(mcpAuthorizations.revokedAt)),
    });
    if (!row) return c.json({ error: L('授权不存在或已撤销', 'Authorization not found or already revoked') }, 404);
    await revokeGrant(row.grantId, 'user');
    audit(`user:${c.var.auth.userId}`, 'mcp_oauth.revoke', { target: `oauth:${id}`, detail: { clientId: row.clientId } });
    return c.json({ ok: true });
  });
