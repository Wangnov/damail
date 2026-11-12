import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireSession, type AppEnv } from '../auth/index.js';
import { config } from '../config.js';
import { toolCatalog } from '../mcp/server.js';
import { db } from '../db/index.js';
import { accounts, apiKeys, folders, proxies } from '../db/schema.js';
import { decryptSecret, encryptSecret, generateApiKey, sha256 } from '../lib/crypto.js';
import { syncEngine } from '../sync/engine.js';
import { describeGraphError, graphJson } from '../sync/graph.js';
import { testImapConnection } from '../sync/imap.js';
import { accountCredentials, type Credentials } from '../services/oauth.js';
import { testSmtpConnection } from '../services/send.js';
import { accountsUsingProxy, listProxies, proxyInput, proxyUrl, proxyUrlById, proxyValues, publicProxy, testProxy } from '../services/proxy.js';
import { providers } from '../sync/providers.js';
import { iconDomain, senderIcon } from '../services/sender-icons.js';
import { L } from '../i18n/index.js';

const accountInput = z.object({
  name: z.string().trim().min(1).max(100),
  email: z
    .string()
    .trim()
    .email({ error: () => L('邮箱格式不正确', 'Invalid email address') }),
  displayName: z.string().trim().max(100).nullish(),
  provider: z.string().default('custom'),
  color: z.string().nullish(),
  imapHost: z
    .string()
    .trim()
    .min(1, { error: () => L('请填写 IMAP 服务器', 'Enter the IMAP server') }),
  imapPort: z.coerce.number().int().min(1).max(65535),
  imapSecure: z.boolean(),
  smtpHost: z.string().trim().nullish(),
  smtpPort: z.coerce.number().int().min(1).max(65535).nullish(),
  smtpSecure: z.boolean().nullish(),
  username: z.string().trim().min(1),
  secret: z.string().min(1, { error: () => L('请填写授权码 / 密码', 'Enter the authorization code / password') }),
  // 0 表示全部历史；显式天数仍保留合理上限。
  syncSinceDays: z.coerce.number().int().min(0).max(36500).default(90),
  // 轮询间隔（秒），null 用默认；最短 1 分钟，避免频繁连接被邮件服务商限流
  pollIntervalSec: z
    .number()
    .int()
    .min(60, { error: () => L('同步间隔至少 1 分钟', 'The sync interval must be at least 1 minute') })
    .max(86_400)
    .nullish(),
  proxyId: z.number().int().positive().nullish(),
  enabled: z.boolean().default(true),
});

const API_SCOPES = ['read', 'organize', 'draft', 'send', 'automation'] as const;

const accountUpdate = accountInput.partial().extend({ secret: z.string().optional() });

function publicAccount(a: typeof accounts.$inferSelect) {
  const { secretEnc: _secret, ...rest } = a;
  return rest;
}

function badRequest(err: z.ZodError) {
  return { error: err.issues[0]?.message ?? L('参数错误', 'Invalid parameters') };
}

export const adminRoutes = new Hono<AppEnv>()
  .use(requireSession())
  .get('/providers', (c) => c.json(providers))
  // 邮箱表单里「同步间隔：默认（N 分钟）」用
  .get('/sync-defaults', (c) => c.json({ pollIntervalSec: Math.round(config.pollIntervalMs / 1000) }))

  // 发件人品牌图标，查不到时前端显示名字首字母
  .get('/icons/:domain', async (c) => {
    const domain = iconDomain(c.req.param('domain'));
    const headers = { 'content-security-policy': "default-src 'none'" };
    if (!domain) return c.body(null, 404, { ...headers, 'cache-control': 'private, max-age=604800' });
    try {
      const icon = await senderIcon(domain);
      if (!icon) return c.body(null, 404, { ...headers, 'cache-control': 'private, max-age=86400' });
      return c.body(new Uint8Array(icon.body), 200, { ...headers, 'content-type': icon.type, 'cache-control': 'private, max-age=604800' });
    } catch {
      return c.body(null, 502, headers);
    }
  })

  .get('/accounts', async (c) => {
    const rows = await db.select().from(accounts).orderBy(accounts.id);
    return c.json(rows.map(publicAccount));
  })
  .post('/accounts/test', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    // 编辑已有账户时可以不重新输入密码
    let creds: Credentials | undefined = body.secret ? { password: String(body.secret) } : undefined;
    if (!creds && body.id) {
      const existing = await db.query.accounts.findFirst({ where: eq(accounts.id, Number(body.id)) });
      // Graph 账户没有 IMAP/SMTP，直接列文件夹试一下（代理按表单里当前选的）
      if (existing?.protocol === 'graph') {
        try {
          const page = await graphJson<{ value: Array<{ displayName: string }> }>(
            { ...existing, proxyId: Number(body.proxyId) || null },
            '/me/mailFolders?$select=displayName&$top=100',
          );
          return c.json({ ok: true, graph: true, folders: page.value.map((f) => ({ path: f.displayName })), idle: false, condstore: false });
        } catch (err) {
          return c.json({ ok: false, error: describeGraphError(err) });
        }
      }
      if (existing) {
        try {
          creds = await accountCredentials(existing);
        } catch (err) {
          return c.json({ ok: false, error: (err as Error).message });
        }
      }
    }
    if (!body.imapHost || !body.username || !creds)
      return c.json({ ok: false, error: L('请填写服务器、用户名和授权码', 'Enter the server, username and authorization code') }, 400);
    const proxy = await proxyUrlById(Number(body.proxyId) || null);
    const result = await testImapConnection({
      host: String(body.imapHost),
      port: Number(body.imapPort ?? 993),
      secure: body.imapSecure !== false,
      username: String(body.username),
      ...creds,
      proxy,
    });
    if (!result.ok || !body.smtpHost) return c.json(result);
    const smtp = await testSmtpConnection({
      host: String(body.smtpHost),
      port: Number(body.smtpPort ?? 465),
      secure: body.smtpSecure !== false,
      username: String(body.username),
      ...creds,
      proxy,
    });
    return c.json({ ...result, smtp });
  })
  .post('/accounts', async (c) => {
    const parsed = accountInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    const { secret, ...data } = parsed.data;
    const [row] = await db
      .insert(accounts)
      .values({ ...data, email: data.email.toLowerCase(), secretEnc: encryptSecret(secret) })
      .returning();
    if (row!.enabled) syncEngine.startAccount(row!.id);
    return c.json(publicAccount(row!), 201);
  })
  .patch('/accounts/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const parsed = accountUpdate.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    const { secret, ...data } = parsed.data;
    const patch: Partial<typeof accounts.$inferInsert> = { ...data };
    if (data.email) patch.email = data.email.toLowerCase();
    // 填了新密码就改回密码认证和 IMAP 收信（OAuth 账户重新授权走 /api/oauth）
    if (secret) Object.assign(patch, { secretEnc: encryptSecret(secret), authType: 'password', protocol: 'imap' });
    const existing = await db.query.accounts.findFirst({ where: eq(accounts.id, id) });
    if (!existing) return c.json({ error: 'not found' }, 404);
    const backfill =
      data.syncSinceDays !== undefined && existing.syncSinceDays !== 0 &&
      (data.syncSinceDays === 0 || data.syncSinceDays > existing.syncSinceDays);
    // 等正在运行的同步退出，避免它覆盖重置后的进度。
    if (backfill) await syncEngine.stopAccount(id);
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(accounts).set(patch).where(eq(accounts.id, id)).returning();
      if (backfill) await tx.update(folders).set({ lastUid: 0, highestModseq: null, deltaLink: null }).where(eq(folders.accountId, id));
      return updated!;
    }).catch((err) => {
      if (backfill && existing.enabled) syncEngine.startAccount(id);
      throw err;
    });
    if (row.enabled) await syncEngine.restartAccount(id);
    else await syncEngine.stopAccount(id);
    return c.json(publicAccount(row));
  })
  // 签名单独保存：不需要重启同步
  .put('/accounts/:id/signature', async (c) => {
    const id = Number(c.req.param('id'));
    const parsed = z.object({ signatureHtml: z.string().max(2_000_000).nullable() }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    const html = parsed.data.signatureHtml?.trim() || null;
    const [row] = await db.update(accounts).set({ signatureHtml: html }).where(eq(accounts.id, id)).returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json(publicAccount(row));
  })
  .delete('/accounts/:id', async (c) => {
    const id = Number(c.req.param('id'));
    await syncEngine.stopAccount(id);
    await db.delete(accounts).where(eq(accounts.id, id));
    return c.json({ ok: true });
  })
  .post('/accounts/:id/sync', (c) => {
    syncEngine.syncNow(Number(c.req.param('id')));
    return c.json({ ok: true });
  })
  .patch('/folders/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const body = z.object({ syncEnabled: z.boolean() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json(badRequest(body.error), 400);
    // 不返回整行：uidValidity / highestModseq 是 BigInt，JSON 序列化不了
    const [row] = await db
      .update(folders)
      .set({ syncEnabled: body.data.syncEnabled })
      .where(eq(folders.id, id))
      .returning({ id: folders.id, accountId: folders.accountId, syncEnabled: folders.syncEnabled });
    if (!row) return c.json({ error: 'not found' }, 404);
    if (body.data.syncEnabled) syncEngine.syncNow(row.accountId);
    return c.json(row);
  })

  .get('/proxies', async (c) => c.json(await listProxies()))
  .post('/proxies', async (c) => {
    const parsed = proxyInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    const [row] = await db.insert(proxies).values(proxyValues(parsed.data)).returning();
    return c.json(publicProxy(row!), 201);
  })
  .patch('/proxies/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const parsed = proxyInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    const prev = await db.query.proxies.findFirst({ where: eq(proxies.id, id) });
    if (!prev) return c.json({ error: 'not found' }, 404);
    const [row] = await db.update(proxies).set(proxyValues(parsed.data, prev)).where(eq(proxies.id, id)).returning();
    // 用这个代理的邮箱换新地址重连
    for (const a of await accountsUsingProxy(id)) if (a.enabled) await syncEngine.restartAccount(a.id);
    return c.json(publicProxy(row!));
  })
  .delete('/proxies/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const using = await accountsUsingProxy(id);
    // 外键 ON DELETE SET NULL：删掉后这些邮箱改为直连
    await db.delete(proxies).where(eq(proxies.id, id));
    for (const a of using) if (a.enabled) await syncEngine.restartAccount(a.id);
    return c.json({ ok: true });
  })
  // 测试已保存的代理（id）或表单里还没保存的配置；编辑时密码留空就用已保存的
  .post('/proxies/test', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const target = typeof body.target === 'string' && body.target ? body.target : 'imap.gmail.com:993';
    const id = Number(body.id) || null;
    const prev = id ? await db.query.proxies.findFirst({ where: eq(proxies.id, id) }) : undefined;
    let url: string;
    if (body.host) {
      const parsed = proxyInput.safeParse(body);
      if (!parsed.success) return c.json({ ok: false, error: badRequest(parsed.error).error });
      url = proxyUrl(proxyValues(parsed.data, prev));
    } else if (prev) url = proxyUrl(prev);
    else return c.json({ ok: false, error: L('代理不存在', 'Proxy not found') });
    return c.json(await testProxy(url, target));
  })

  .get('/mcp-tools', async (c) => c.json(await toolCatalog()))
  .get('/api-keys', async (c) => {
    const rows = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        scopes: apiKeys.scopes,
        accountIds: apiKeys.accountIds,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
        copyable: sql<boolean>`${apiKeys.keyEnc} is not null`,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, c.var.auth.userId), isNull(apiKeys.revokedAt)))
      .orderBy(desc(apiKeys.id));
    return c.json(rows);
  })
  // 列表不带密钥，复制时单独取
  .get('/api-keys/:id/secret', async (c) => {
    const [row] = await db
      .select({ keyEnc: apiKeys.keyEnc })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, Number(c.req.param('id'))), eq(apiKeys.userId, c.var.auth.userId), isNull(apiKeys.revokedAt)));
    if (!row) return c.json({ error: L('密钥不存在', 'Key not found') }, 404);
    if (!row.keyEnc)
      return c.json({ error: L('创建时没有保存完整密钥，需要重新创建', 'The full key was not saved when it was created; create a new one') }, 404);
    return c.json({ key: decryptSecret(row.keyEnc) });
  })
  .post('/api-keys', async (c) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        // read 总是包含；organize 整理邮件，draft 写草稿并提交审批，send 免审批直接发送，automation 管理自动化规则
        scopes: z.array(z.enum(API_SCOPES)).default(['read']),
        accountIds: z.array(z.number().int()).nullish(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json(badRequest(body.error), 400);
    const key = generateApiKey();
    const [row] = await db
      .insert(apiKeys)
      .values({
        userId: c.var.auth.userId,
        name: body.data.name,
        prefix: key.slice(0, 10),
        keyHash: sha256(key),
        keyEnc: encryptSecret(key),
        scopes: [...new Set(['read', ...body.data.scopes])],
        accountIds: body.data.accountIds?.length ? body.data.accountIds : null,
      })
      .returning();
    return c.json({ id: row!.id, name: row!.name, key }, 201);
  })
  // 轮转：名称、权限和账户范围不变，换一个新密钥，旧的立即失效
  .post('/api-keys/:id/rotate', async (c) => {
    const key = generateApiKey();
    const [row] = await db
      .update(apiKeys)
      .set({ prefix: key.slice(0, 10), keyHash: sha256(key), keyEnc: encryptSecret(key), lastUsedAt: null })
      .where(and(eq(apiKeys.id, Number(c.req.param('id'))), eq(apiKeys.userId, c.var.auth.userId), isNull(apiKeys.revokedAt)))
      .returning();
    if (!row) return c.json({ error: L('密钥不存在', 'Key not found') }, 404);
    return c.json({ id: row.id, name: row.name, key });
  })
  .delete('/api-keys/:id', async (c) => {
    await db
      .update(apiKeys)
      .set({ revokedAt: new Date(), keyEnc: null })
      .where(and(eq(apiKeys.id, Number(c.req.param('id'))), eq(apiKeys.userId, c.var.auth.userId)));
    return c.json({ ok: true });
  });
