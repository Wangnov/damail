import { and, count, desc, eq, gte, ilike, inArray, isNotNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireSession, type AppEnv } from '../auth/index.js';
import { db } from '../db/index.js';
import { accounts, apiKeys, auditLogs, mcpAuthorizations, rules, settings, users } from '../db/schema.js';
import { actionLabel } from '../lib/audit-labels.js';
import { audit, AUDIT_SETTINGS_KEY, auditRetentionDays } from '../lib/audit.js';
import { toolCatalog } from '../mcp/server.js';
import { t } from '../i18n/index.js';

const query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
  source: z.enum(['web', 'api', 'mcp', 'oauth', 'system']).optional(),
  // user:1 / key:3 / oauth:2 / rule:5 / system / anonymous，或者只按类型：user / key / oauth / rule
  actor: z.string().max(40).optional(),
  q: z.string().trim().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  // ok：状态码 < 400；failed：状态码 ≥ 400（没有状态码的旧记录两边都不算）
  result: z.enum(['ok', 'failed']).optional(),
  failed: z.enum(['1', 'true']).optional(),
});

const ACTOR_TYPES = ['user', 'key', 'oauth', 'rule'];
const REF = /^(user|key|oauth|rule):\d+$/;

function ids(actors: string[], prefix: string) {
  return [...new Set(actors.filter((a) => a.startsWith(`${prefix}:`)).map((a) => Number(a.slice(prefix.length + 1))))].filter(Number.isFinite);
}

/** 把 user:1、key:3 这类操作者换成可读名称（API Key 吊销后仍显示原名称） */
async function actorLabels(actors: string[]) {
  const labels = new Map<string, string>([
    ['system', t().audit.actor.system],
    ['anonymous', t().audit.actor.anonymous],
  ]);
  const [u, k, o, r] = await Promise.all([
    ids(actors, 'user').length
      ? db
          .select({ id: users.id, name: users.username })
          .from(users)
          .where(inArray(users.id, ids(actors, 'user')))
      : [],
    ids(actors, 'key').length
      ? db
          .select({ id: apiKeys.id, name: apiKeys.name })
          .from(apiKeys)
          .where(inArray(apiKeys.id, ids(actors, 'key')))
      : [],
    ids(actors, 'oauth').length
      ? db
          .select({ id: mcpAuthorizations.id, name: mcpAuthorizations.clientName, clientId: mcpAuthorizations.clientId })
          .from(mcpAuthorizations)
          .where(inArray(mcpAuthorizations.id, ids(actors, 'oauth')))
      : [],
    ids(actors, 'rule').length
      ? db
          .select({ id: rules.id, name: rules.name })
          .from(rules)
          .where(inArray(rules.id, ids(actors, 'rule')))
      : [],
  ]);
  for (const x of u) labels.set(`user:${x.id}`, x.name);
  for (const x of k) labels.set(`key:${x.id}`, x.name);
  for (const x of o) labels.set(`oauth:${x.id}`, x.name || x.clientId);
  for (const x of r) labels.set(`rule:${x.id}`, x.name);
  return labels;
}

/** 审计日志：只允许网页登录态查看和修改保留期限 */
export const auditAdminRoutes = new Hono<AppEnv>()
  .use('/audit-logs/*', requireSession())
  .use('/audit-logs', requireSession())
  .get('/audit-logs', async (c) => {
    const f = query.parse(c.req.query());
    const where: SQL[] = [];
    if (f.source) where.push(eq(auditLogs.source, f.source));
    if (f.actor) {
      if (ACTOR_TYPES.includes(f.actor)) where.push(sql`${auditLogs.actor} like ${`${f.actor}:%`}`);
      else where.push(eq(auditLogs.actor, f.actor));
    }
    if (f.from) where.push(gte(auditLogs.createdAt, f.from));
    if (f.to) where.push(lte(auditLogs.createdAt, f.to));
    if (f.result === 'failed' || f.failed) where.push(and(isNotNull(auditLogs.status), gte(auditLogs.status, 400))!);
    else if (f.result === 'ok') where.push(and(isNotNull(auditLogs.status), lt(auditLogs.status, 400))!);
    if (f.q) {
      const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push(or(ilike(auditLogs.action, like), ilike(auditLogs.target, like), ilike(auditLogs.ip, like), sql`${auditLogs.detail}::text ilike ${like}`)!);
    }
    const cond = where.length ? and(...where) : undefined;
    const [rows, totals] = await Promise.all([
      db
        .select()
        .from(auditLogs)
        .where(cond)
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(f.pageSize)
        .offset((f.page - 1) * f.pageSize),
      db.select({ total: count() }).from(auditLogs).where(cond),
    ]);
    const total = totals[0]?.total ?? 0;

    // 对象是 oauth:2、key:3 这类引用时也换成名称
    const labels = await actorLabels([...rows.map((r) => r.actor), ...rows.flatMap((r) => (r.target && REF.test(r.target) ? [r.target] : []))]);
    const accountIds = [...new Set(rows.map((r) => r.accountId).filter((x): x is number => x != null))];
    const accountRows = accountIds.length
      ? await db.select({ id: accounts.id, email: accounts.email }).from(accounts).where(inArray(accounts.id, accountIds))
      : [];
    const accountEmail = new Map(accountRows.map((a) => [a.id, a.email]));
    const tools = rows.some((r) => r.action === 'mcp.call') ? new Map((await toolCatalog()).map((t) => [t.name, t.title])) : new Map<string, string>();

    return c.json({
      total,
      items: rows.map((r) => ({
        ...r,
        actorLabel: labels.get(r.actor) ?? r.actor,
        targetLabel: r.target && REF.test(r.target) ? (labels.get(r.target) ?? null) : null,
        actionLabel: actionLabel(r.action, r.target, (name) => tools.get(name)),
        // 邮箱已删除时为 null，前端按 accountId 显示
        account: r.accountId != null ? (accountEmail.get(r.accountId) ?? null) : null,
      })),
    });
  })
  // 筛选用的操作者列表：用户、API Key（含已吊销）、OAuth 授权
  .get('/audit-logs/actors', async (c) => {
    const [u, k, o] = await Promise.all([
      db.select({ id: users.id, name: users.username }).from(users).orderBy(users.id),
      db.select({ id: apiKeys.id, name: apiKeys.name, revokedAt: apiKeys.revokedAt }).from(apiKeys).orderBy(desc(apiKeys.id)),
      db
        .select({ id: mcpAuthorizations.id, name: mcpAuthorizations.clientName, clientId: mcpAuthorizations.clientId, revokedAt: mcpAuthorizations.revokedAt })
        .from(mcpAuthorizations)
        .orderBy(desc(mcpAuthorizations.id)),
    ]);
    return c.json([
      ...u.map((x) => ({ value: `user:${x.id}`, label: x.name, type: 'user' })),
      ...k.map((x) => ({ value: `key:${x.id}`, label: x.name, type: 'key', revoked: Boolean(x.revokedAt) })),
      ...o.map((x) => ({ value: `oauth:${x.id}`, label: x.name || x.clientId, type: 'oauth', revoked: Boolean(x.revokedAt) })),
    ]);
  })
  .get('/audit-logs/settings', async (c) => c.json({ retentionDays: await auditRetentionDays() }))
  .put('/audit-logs/settings', async (c) => {
    const { retentionDays } = z.object({ retentionDays: z.number().int().min(0).max(3650) }).parse(await c.req.json());
    if (retentionDays > 0 && retentionDays < 7) return c.json({ error: t().audit.retentionMin }, 400);
    const value = { retentionDays };
    await db
      .insert(settings)
      .values({ key: AUDIT_SETTINGS_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
    audit(`user:${c.var.auth.userId}`, 'audit.settings', { detail: value });
    return c.json(value);
  });
