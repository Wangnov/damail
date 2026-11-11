import { eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { contactAliases, ignoredSenders, messageInsights, messages } from '../db/schema.js';
import { escapeLike } from '../lib/search-query.js';
import { ActionError } from './actions.js';
import type { Scope } from './mail.js';
import { L } from '../i18n/index.js';

/** 统一成小写；域名统一带 @ 前缀，地址必须是 a@b 的形式 */
export function normalizePattern(input: string) {
  const v = input.trim().toLowerCase();
  if (/^@?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)) return v.startsWith('@') ? v : `@${v}`;
  if (/^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)) return v;
  throw new ActionError(L('请填写邮箱地址（a@example.com）或域名（@example.com）', 'Enter an email address (a@example.com) or a domain (@example.com)'), 400);
}

/**
 * 发件人是否在忽略名单里（SQL 版，供日报、统计、补做分析排除用）。
 * 域名 @b.com 也匹配子域名，例如 news@mail.b.com
 */
export function isIgnoredSql(address: SQL) {
  const addr = sql`lower(coalesce(${address}, ''))`;
  const domain = sql`split_part(${addr}, '@', 2)`;
  return sql`EXISTS (SELECT 1 FROM ignored_senders ig WHERE ig.pattern = ${addr}
    OR (left(ig.pattern, 1) = '@' AND (${domain} = substr(ig.pattern, 2) OR right(${domain}, length(ig.pattern)) = '.' || substr(ig.pattern, 2))))`;
}

// 名单很短，放内存里给新邮件处理用；增删时清掉
let cache: Set<string> | null = null;

async function patterns() {
  cache ??= new Set((await db.select({ p: ignoredSenders.pattern }).from(ignoredSenders)).map((r) => r.p));
  return cache;
}

export async function isIgnoredSender(address: string | null | undefined) {
  if (!address) return false;
  const set = await patterns();
  if (!set.size) return false;
  const a = address.toLowerCase();
  if (set.has(a)) return true;
  const labels = (a.split('@')[1] ?? '').split('.');
  for (let i = 0; i < labels.length - 1; i++) if (set.has(`@${labels.slice(i).join('.')}`)) return true;
  return false;
}

export async function listIgnored() {
  return db.select().from(ignoredSenders).orderBy(ignoredSenders.createdAt);
}

/** 加入忽略名单，同时删掉这些发件人已有的 AI 分析结果，让重要、需要回复等视图和概览里不再出现 */
export async function addIgnored(input: string) {
  const pattern = normalizePattern(input);
  await db.insert(ignoredSenders).values({ pattern }).onConflictDoNothing();
  cache = null;
  const removed = await db.execute(sql`
    DELETE FROM ${messageInsights} i USING ${messages} m
    WHERE i.message_id = m.id AND ${isIgnoredSql(sql`m.from_address`)}`);
  return { pattern, removedInsights: removed.rowCount ?? 0 };
}

export async function removeIgnored(input: string) {
  const pattern = input.trim().toLowerCase();
  await db.delete(ignoredSenders).where(eq(ignoredSenders.pattern, pattern));
  cache = null;
  return { pattern };
}

export type ContactRow = {
  address: string;
  name: string | null;
  /** 用户起的备注名 */
  alias: string | null;
  received: number;
  sent: number;
  lastDate: string | null;
  ignored: boolean;
};

/** 设置备注名，传空字符串表示去掉 */
export async function setContactAlias(input: string, alias: string) {
  const address = input.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(address)) throw new ActionError(L('邮箱地址不正确', 'Invalid email address'), 400);
  const value = alias.trim().slice(0, 100);
  if (!value) await db.delete(contactAliases).where(eq(contactAliases.address, address));
  else
    await db
      .insert(contactAliases)
      .values({ address, alias: value })
      .onConflictDoUpdate({ target: contactAliases.address, set: { alias: value, updatedAt: new Date() } });
  return { address, alias: value || null };
}

/**
 * 通讯录：从收到邮件的发件人和已发送邮件的收件人里汇总，不含自己的邮箱。
 * 同一封邮件在多个文件夹（Gmail 标签）里只算一次。
 */
// 写信时从通讯录选人：去掉不能回信的地址（no-reply、退信）
const NOT_A_PERSON = '(^|[._+-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?)([._+-]|@)';

export async function listContacts(
  scope: Scope,
  opts: { q?: string; ignored?: boolean; people?: boolean; sort?: 'count' | 'recent' | 'sent'; limit: number; offset: number },
) {
  const ids = scope.accountIds;
  const inScope = sql`(${ids === null} OR m.account_id = ANY(${sql.param(ids ?? [])}::int[]))`;
  const q = opts.q?.trim() ? `%${escapeLike(opts.q.trim())}%` : null;
  const order =
    opts.sort === 'recent'
      ? sql`last_date DESC NULLS LAST`
      : opts.sort === 'sent'
        ? sql`sent DESC, received DESC, last_date DESC NULLS LAST`
        : sql`received + sent DESC, last_date DESC NULLS LAST`;
  const res = await db.execute<{
    address: string;
    name: string | null;
    alias: string | null;
    received: number;
    sent: number;
    last_date: Date | null;
    ignored: boolean;
    total: number;
  }>(sql`
    WITH own AS (SELECT lower(email) AS e FROM accounts),
    c AS (
      SELECT m.from_name AS name, lower(m.from_address) AS address, m.date, coalesce(m.message_id, m.id::text) AS k, true AS recv
      FROM messages m JOIN folders f ON f.id = m.folder_id
      WHERE m.from_address IS NOT NULL AND coalesce(f.special_use, '') NOT IN ('\\Sent', '\\Drafts', '\\Junk') AND ${inScope}
      UNION ALL
      SELECT r->>'name', lower(r->>'address'), m.date, coalesce(m.message_id, m.id::text), false
      FROM messages m JOIN folders f ON f.id = m.folder_id AND f.special_use = '\\Sent'
      CROSS JOIN LATERAL jsonb_array_elements(m."to" || m.cc) r
      WHERE ${inScope}
    ),
    g AS (
      SELECT address,
             (array_agg(nullif(name, '') ORDER BY nullif(name, '') IS NULL, date DESC))[1] AS name,
             (count(DISTINCT k) FILTER (WHERE recv))::int AS received,
             (count(DISTINCT k) FILTER (WHERE NOT recv))::int AS sent,
             max(date) AS last_date
      FROM c WHERE coalesce(address, '') LIKE '%@%' AND address NOT IN (SELECT e FROM own)
      GROUP BY address
    ),
    t AS (SELECT g.*, ca.alias, ${isIgnoredSql(sql`g.address`)} AS ignored FROM g LEFT JOIN contact_aliases ca ON ca.address = g.address)
    SELECT *, (count(*) OVER ())::int AS total FROM t
    WHERE ${q ? sql`(address ILIKE ${q} OR name ILIKE ${q} OR alias ILIKE ${q})` : sql`true`}
      AND ${opts.ignored ? sql`ignored` : sql`true`}
      AND ${opts.people ? sql`NOT ignored AND address !~* ${NOT_A_PERSON}` : sql`true`}
    ORDER BY ${order}
    LIMIT ${opts.limit} OFFSET ${opts.offset}
  `);
  return {
    total: res.rows[0]?.total ?? 0,
    items: res.rows.map((r): ContactRow => ({
      address: r.address,
      name: r.name,
      alias: r.alias,
      received: r.received,
      sent: r.sent,
      lastDate: r.last_date ? new Date(r.last_date).toISOString() : null,
      ignored: r.ignored,
    })),
  };
}
