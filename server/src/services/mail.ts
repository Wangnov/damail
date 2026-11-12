import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { findAttachmentPart } from '../lib/mime-part.js';
import { accounts, drafts, folders, messageInsights, messages, type Message, type MessageInsight } from '../db/schema.js';
import { escapeLike, parseSearchQuery } from '../lib/search-query.js';
import { isIgnoredSql } from './contacts.js';
import { dueFollowUpCount, findWaiting, followUpsFor, type WaitingInfo } from './followups.js';
import { parseRaw, readRaw } from './ingest.js';
import { unsubscribeInfoFor } from './subscriptions.js';
import { translationsFor } from './translate.js';
import { labelsForMessages, labelsForThreads } from './labels.js';
import { L } from '../i18n/index.js';
import { completeMessage } from './message-source.js';

/** 访问范围：API Key 可以限定只能看某些账户，null 表示全部 */
export type Scope = { accountIds: number[] | null };

export type View = 'inbox' | 'important' | 'sent' | 'starred' | 'unread' | 'all' | 'waiting';

export type ListOptions = {
  scope: Scope;
  view?: View;
  accountId?: number;
  folderId?: number;
  q?: string;
  cursor?: string;
  limit?: number;
};

const FOLDER_ALIASES: Record<string, string> = {
  inbox: '\\Inbox',
  sent: '\\Sent',
  junk: '\\Junk',
  spam: '\\Junk',
  trash: '\\Trash',
  drafts: '\\Drafts',
  archive: '\\Archive',
};

const like = (v: string) => `%${escapeLike(v)}%`;

function isInbox() {
  return sql`(${folders.specialUse} = '\\Inbox' OR upper(${folders.path}) = 'INBOX')`;
}

function buildFilters(opts: ListOptions): SQL[] {
  const conds: SQL[] = [];
  const { scope } = opts;
  if (scope.accountIds) conds.push(scope.accountIds.length ? inArray(messages.accountId, scope.accountIds) : sql`false`);
  if (opts.accountId) conds.push(eq(messages.accountId, opts.accountId));
  if (opts.folderId) conds.push(eq(messages.folderId, opts.folderId));

  const q = parseSearchQuery(opts.q);
  const hasFolderFilter = Boolean(opts.folderId || q.folder.length);
  // 带搜索词时默认搜全部已同步文件夹
  const view = opts.view ?? (opts.q ? 'all' : 'inbox');
  if (!hasFolderFilter) {
    if (view === 'inbox' || view === 'important') conds.push(isInbox());
    else if (view === 'sent') conds.push(sql`${folders.specialUse} = '\\Sent'`);
    // 跨文件夹的视图和搜索不含垃圾箱、垃圾邮件，要看用 folder:trash / folder:junk
    else conds.push(sql`coalesce(${folders.specialUse}, '') NOT IN ('\\Trash', '\\Junk')`);
  }
  if (view === 'starred') conds.push(eq(messages.flagged, true));
  if (view === 'unread') conds.push(eq(messages.seen, false));
  if (view === 'important') conds.push(eq(messageInsights.priority, 'high'));

  for (const t of q.terms) conds.push(sql`${messages.searchText} ILIKE ${like(t)}`);
  for (const t of q.excludes) conds.push(sql`${messages.searchText} NOT ILIKE ${like(t)}`);
  for (const v of q.from) conds.push(sql`(${messages.fromAddress} ILIKE ${like(v)} OR ${messages.fromName} ILIKE ${like(v)})`);
  for (const v of q.to) conds.push(sql`(${messages.to}::text ILIKE ${like(v)} OR ${messages.cc}::text ILIKE ${like(v)})`);
  for (const v of q.subject) conds.push(sql`${messages.subject} ILIKE ${like(v)}`);
  for (const v of q.account) {
    conds.push(
      sql`(${accounts.email} ILIKE ${like(v)} OR ${accounts.name} ILIKE ${like(v)} OR ${accounts.provider} = ${v.toLowerCase()} OR ${accounts.id}::text = ${v})`,
    );
  }
  for (const v of q.folder) {
    const special = FOLDER_ALIASES[v.toLowerCase()];
    if (special === '\\Inbox') conds.push(isInbox());
    else if (special) conds.push(sql`${folders.specialUse} = ${special}`);
    else conds.push(sql`(${folders.path} ILIKE ${like(v)} OR ${folders.name} ILIKE ${like(v)})`);
  }
  if (q.isUnread !== undefined) conds.push(eq(messages.seen, !q.isUnread));
  if (q.isStarred !== undefined) conds.push(eq(messages.flagged, q.isStarred));
  if (q.isAnswered !== undefined) conds.push(eq(messages.answered, q.isAnswered));
  if (q.hasAttachment !== undefined) conds.push(eq(messages.hasAttachments, q.hasAttachment));
  if (q.category.length) conds.push(inArray(messageInsights.category, q.category));
  if (q.priority.length) conds.push(inArray(messageInsights.priority, q.priority));
  // 标签按名字匹配（任意一种语言的名称，不区分大小写）；多个 label: 表示都要有
  const hasLabel = (name: string) =>
    sql`EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = ${messages.id} AND NOT ml.removed AND EXISTS (SELECT 1 FROM jsonb_each(l.i18n) e WHERE lower(e.value->>'name') = lower(${name})))`;
  for (const v of q.label) conds.push(hasLabel(v));
  for (const v of q.notLabel) conds.push(sql`NOT ${hasLabel(v)}`);
  if (q.needsReply !== undefined) conds.push(sql`coalesce(${messageInsights.needsReply}, false) = ${q.needsReply}`);
  if (q.hasCode !== undefined) conds.push(sql`coalesce(jsonb_array_length(${messageInsights.extracted}->'codes'), 0) ${q.hasCode ? sql`> 0` : sql`= 0`}`);
  if (q.after) conds.push(sql`${messages.date} >= ${q.after.toISOString()}`);
  if (q.before) conds.push(sql`${messages.date} < ${q.before.toISOString()}`);
  return conds;
}

function encodeCursor(date: Date, id: number) {
  return Buffer.from(`${date.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor?: string): { date: string; id: number } | null {
  if (!cursor) return null;
  const [date, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!date || !id || Number.isNaN(Date.parse(date))) return null;
  return { date, id: Number(id) };
}

function clampLimit(limit?: number, max = 100) {
  return Math.min(Math.max(Number(limit) || 30, 1), max);
}

function whereSql(conds: SQL[]) {
  return conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;
}

export function addressLabel(name?: string | null, address?: string | null) {
  return name || address || L('(未知发件人)', '(unknown sender)');
}

/** 「全部标为已读」：和会话列表同样的筛选条件下所有未读邮件的 id（等回复视图不支持，按全部算） */
export async function unreadMessageIds(opts: Omit<ListOptions, 'cursor' | 'limit'>, max = 5000): Promise<number[]> {
  const conds = [...buildFilters({ ...opts, view: opts.view === 'waiting' ? 'all' : opts.view }), eq(messages.seen, false)];
  const result = await db.execute<{ id: string }>(sql`
    SELECT ${messages.id} AS id
    FROM ${messages}
    JOIN ${folders} ON ${folders.id} = ${messages.folderId}
    JOIN ${accounts} ON ${accounts.id} = ${messages.accountId}
    LEFT JOIN ${messageInsights} ON ${messageInsights.messageId} = ${messages.id}
    ${whereSql(conds)}
    ORDER BY ${messages.date} DESC
    LIMIT ${max}
  `);
  return result.rows.map((r) => Number(r.id));
}

/** 会话列表：按会话最新一封邮件排序 */
export type ThreadSummary = Awaited<ReturnType<typeof hydrateThreads>>[number] & { waiting?: WaitingInfo };

export async function listThreads(opts: ListOptions): Promise<{ items: ThreadSummary[]; nextCursor: string | null }> {
  if (opts.view === 'waiting' && !opts.q && !opts.folderId) {
    const rows = await findWaiting(opts.scope, opts.accountId);
    if (!rows.length) return { items: [], nextCursor: null };
    const items = await hydrateThreads(
      rows.map((r) => ({ thread_id: r.threadId, last_date: r.lastDate, latest_id: String(r.latestId) })),
      opts.scope,
    );
    const waiting = new Map(rows.map((r) => [r.threadId, r.waiting]));
    return { items: items.map((t) => ({ ...t, waiting: waiting.get(t.threadId) })), nextCursor: null };
  }
  const limit = clampLimit(opts.limit);
  const cursor = decodeCursor(opts.cursor);
  const conds = buildFilters(opts);

  const result = await db.execute<{
    thread_id: string;
    last_date: Date;
    latest_id: string;
    match_count: string;
  }>(sql`
    WITH matched AS (
      SELECT ${messages.id} AS id, ${messages.threadId} AS thread_id, ${messages.date} AS date
      FROM ${messages}
      JOIN ${folders} ON ${folders.id} = ${messages.folderId}
      JOIN ${accounts} ON ${accounts.id} = ${messages.accountId}
      LEFT JOIN ${messageInsights} ON ${messageInsights.messageId} = ${messages.id}
      ${whereSql(conds)}
    ), grouped AS (
      SELECT thread_id, max(date) AS last_date,
             (array_agg(id ORDER BY date DESC, id DESC))[1] AS latest_id,
             count(*) AS match_count
      FROM matched GROUP BY thread_id
    )
    SELECT * FROM grouped
    ${cursor ? sql`WHERE (last_date, latest_id) < (${cursor.date}::timestamptz, ${cursor.id})` : sql``}
    ORDER BY last_date DESC, latest_id DESC
    LIMIT ${limit + 1}
  `);

  const rows = result.rows.slice(0, limit);
  const hasMore = result.rows.length > limit;
  if (!rows.length) return { items: [], nextCursor: null };
  const items = await hydrateThreads(rows, opts.scope);
  const last = rows[rows.length - 1]!;
  return { items, nextCursor: hasMore ? encodeCursor(new Date(last.last_date), Number(last.latest_id)) : null };
}

/** 按会话补全列表需要的字段：最后一封的内容、参与人、未读和星标汇总 */
async function hydrateThreads(rows: { thread_id: string; last_date: Date; latest_id: string }[], scope: Scope) {
  const scopeCond = scope.accountIds ? (scope.accountIds.length ? sql`AND m2.account_id = ANY(${sql.param(scope.accountIds)}::int[])` : sql`AND false`) : sql``;
  const threadIds = rows.map((r) => r.thread_id);
  const latestIds = rows.map((r) => Number(r.latest_id));

  const [latest, aggregates, threadLabels] = await Promise.all([
    db
      .select({ m: messages, insight: messageInsights })
      .from(messages)
      .leftJoin(messageInsights, eq(messageInsights.messageId, messages.id))
      .where(inArray(messages.id, latestIds)),
    db.execute<{
      thread_id: string;
      message_count: string;
      unread: boolean;
      flagged: boolean;
      has_attachments: boolean;
      participants: string[];
      account_ids: number[];
    }>(sql`
      SELECT m2.thread_id,
             count(DISTINCT coalesce(m2.message_id, m2.id::text)) AS message_count,
             bool_or(NOT m2.seen) AS unread,
             bool_or(m2.flagged) AS flagged,
             bool_or(m2.has_attachments) AS has_attachments,
             (array_agg(DISTINCT coalesce(nullif(m2.from_name, ''), m2.from_address)))[1:4] AS participants,
             array_agg(DISTINCT m2.account_id) AS account_ids
      FROM messages m2
      WHERE m2.thread_id = ANY(${sql.param(threadIds)}::text[]) ${scopeCond}
      GROUP BY m2.thread_id
    `),
    labelsForThreads(threadIds, scope),
  ]);

  const latestById = new Map(latest.map((r) => [r.m.id, r]));
  const aggByThread = new Map(aggregates.rows.map((a) => [a.thread_id, a]));

  return rows.map((r) => {
    const { m, insight } = latestById.get(Number(r.latest_id))!;
    const agg = aggByThread.get(r.thread_id);
    return {
      threadId: r.thread_id,
      latestMessageId: m.id,
      subject: m.subject,
      snippet: m.snippet,
      from: { name: m.fromName, address: m.fromAddress },
      participants: agg?.participants?.filter(Boolean) ?? [],
      lastDate: new Date(r.last_date).toISOString(),
      messageCount: Number(agg?.message_count ?? 1),
      unread: agg?.unread ?? !m.seen,
      flagged: agg?.flagged ?? m.flagged,
      hasAttachments: agg?.has_attachments ?? m.hasAttachments,
      accountIds: agg?.account_ids ?? [m.accountId],
      insight: briefInsight(insight),
      labels: threadLabels.get(r.thread_id) ?? [],
    };
  });
}

/** 扁平邮件搜索（给 Agent 用，不按会话聚合） */
export async function searchMessages(opts: ListOptions) {
  const limit = clampLimit(opts.limit, 50);
  const cursor = decodeCursor(opts.cursor);
  const conds = buildFilters({ ...opts, view: opts.view ?? 'all' });
  if (cursor) conds.push(sql`(${messages.date}, ${messages.id}) < (${cursor.date}::timestamptz, ${cursor.id})`);

  const rows = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      accountId: messages.accountId,
      accountEmail: accounts.email,
      folder: folders.path,
      subject: messages.subject,
      fromName: messages.fromName,
      fromAddress: messages.fromAddress,
      to: messages.to,
      date: messages.date,
      snippet: messages.snippet,
      seen: messages.seen,
      flagged: messages.flagged,
      hasAttachments: messages.hasAttachments,
      category: messageInsights.category,
      priority: messageInsights.priority,
      summary: messageInsights.summary,
    })
    .from(messages)
    .innerJoin(folders, eq(folders.id, messages.folderId))
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .leftJoin(messageInsights, eq(messageInsights.messageId, messages.id))
    .where(and(...conds))
    .orderBy(sql`${messages.date} DESC, ${messages.id} DESC`)
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.date, last.id) : null };
}

export function inScope(scope: Scope, accountId: number) {
  return !scope.accountIds || scope.accountIds.includes(accountId);
}

/** 列表里只带标签需要的字段 */
function briefInsight(i: MessageInsight | null) {
  if (!i) return null;
  return { category: i.category, priority: i.priority, needsReply: i.needsReply, hasCode: i.extracted.codes.length > 0 };
}

function fullInsight(i: MessageInsight | null) {
  if (!i) return null;
  return {
    category: i.category,
    priority: i.priority,
    summary: i.summary,
    needsReply: i.needsReply,
    extracted: i.extracted,
    model: i.model,
    createdAt: i.createdAt,
  };
}

function toDetail(m: Message, extra: { accountEmail: string; folderPath: string; folderSpecialUse: string | null; insight: MessageInsight | null }) {
  return {
    id: m.id,
    threadId: m.threadId,
    accountId: m.accountId,
    accountEmail: extra.accountEmail,
    folder: extra.folderPath,
    folderSpecialUse: extra.folderSpecialUse,
    messageId: m.messageId,
    inReplyTo: m.inReplyTo,
    subject: m.subject,
    from: { name: m.fromName, address: m.fromAddress },
    to: m.to,
    cc: m.cc,
    replyTo: m.replyTo,
    date: m.date.toISOString(),
    seen: m.seen,
    flagged: m.flagged,
    answered: m.answered,
    text: m.textBody,
    html: m.htmlBody,
    attachments: m.attachments,
    truncated: m.truncated,
    size: m.size,
    insight: fullInsight(extra.insight),
  };
}

export type MessageDetail = Awaited<ReturnType<typeof withExtras>>[number];

const detailColumns = {
  m: messages,
  accountEmail: accounts.email,
  folderPath: folders.path,
  folderSpecialUse: folders.specialUse,
  insight: messageInsights,
};

export async function getMessage(scope: Scope, id: number): Promise<MessageDetail | null> {
  const [row] = await db
    .select(detailColumns)
    .from(messages)
    .innerJoin(folders, eq(folders.id, messages.folderId))
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .leftJoin(messageInsights, eq(messageInsights.messageId, messages.id))
    .where(eq(messages.id, id));
  if (!row || !inScope(scope, row.m.accountId)) return null;
  return (await withExtras([row]))[0]!;
}

/** 补上跟进提醒和退订信息 */
async function withExtras(rows: { m: Message; accountEmail: string; folderPath: string; folderSpecialUse: string | null; insight: MessageInsight | null }[]) {
  // 在详情里列出完整附件，避免预览末尾之外的附件不可见。
  for (const row of rows) if (row.m.truncated) row.m = await completeMessage(row.m);
  const [fus, unsub, translations, labelMap] = await Promise.all([
    followUpsFor(rows.map((r) => r.m)),
    unsubscribeInfoFor(rows.map((r) => r.m)),
    translationsFor(rows.map((r) => r.m.id)),
    labelsForMessages(rows.map((r) => r.m.id)),
  ]);
  return rows.map((r) => ({
    ...toDetail(r.m, r),
    followUp: fus.get(`${r.m.accountId}|${r.m.messageId}`) ?? null,
    unsubscribe: unsub.get(r.m.id) ?? null,
    translation: translations.get(r.m.id) ?? null,
    labels: labelMap.get(r.m.id) ?? [],
  }));
}

export async function getThread(scope: Scope, threadId: string) {
  const conds = [eq(messages.threadId, threadId)];
  if (scope.accountIds) conds.push(scope.accountIds.length ? inArray(messages.accountId, scope.accountIds) : sql`false`);
  const rows = await db
    .select(detailColumns)
    .from(messages)
    .innerJoin(folders, eq(folders.id, messages.folderId))
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .leftJoin(messageInsights, eq(messageInsights.messageId, messages.id))
    .where(and(...conds))
    .orderBy(asc(messages.date), asc(messages.id));
  if (!rows.length) return null;
  // 同一封邮件可能出现在多个文件夹（如 Gmail 标签），按 Message-ID 去重
  const seen = new Set<string>();
  const list = rows.filter((r) => {
    const key = r.m.messageId ?? `id:${r.m.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { threadId, subject: list[0]!.m.subject, messages: await withExtras(list) };
}

/** 会话主题（第一封邮件的主题），看不到这个会话时返回 null */
export async function getThreadSubject(scope: Scope, threadId: string) {
  const conds = [eq(messages.threadId, threadId)];
  if (scope.accountIds) conds.push(scope.accountIds.length ? inArray(messages.accountId, scope.accountIds) : sql`false`);
  const [row] = await db
    .select({ subject: messages.subject })
    .from(messages)
    .where(and(...conds))
    .orderBy(asc(messages.date), asc(messages.id))
    .limit(1);
  return row ? row.subject || L('（无主题）', '(no subject)') : null;
}

export async function getAttachment(scope: Scope, messageId: number, index: number) {
  const stored = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!stored || !inScope(scope, stored.accountId)) return null;
  const msg = await completeMessage(stored);
  if (!msg.rawPath) return null;
  const raw = await readRaw(msg.rawPath);
  // 快速路径：只解码目标附件；和入库时记录的大小一致才采用，否则退回完整解析
  const meta = msg.attachments[index];
  if (meta) {
    try {
      const part = findAttachmentPart(raw, index);
      if (part && part.content.length === meta.size) {
        return {
          filename: meta.filename ?? part.filename ?? `attachment-${index}`,
          contentType: meta.contentType || part.contentType || 'application/octet-stream',
          content: part.content,
        };
      }
    } catch {
      // 结构不规范的邮件交给 mailparser
    }
  }
  const parsed = await parseRaw(raw);
  const att = parsed.attachments[index];
  if (!att) return null;
  return {
    filename: att.filename ?? `attachment-${index}`,
    contentType: att.contentType || 'application/octet-stream',
    content: att.content,
  };
}

export async function getRaw(scope: Scope, messageId: number) {
  const stored = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!stored || !inScope(scope, stored.accountId)) return null;
  const msg = await completeMessage(stored);
  if (!msg.rawPath) return null;
  return readRaw(msg.rawPath);
}

export async function listAccountsWithStats(scope: Scope) {
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      email: accounts.email,
      provider: accounts.provider,
      color: accounts.color,
      enabled: accounts.enabled,
      status: accounts.status,
      lastError: accounts.lastError,
      lastSyncAt: accounts.lastSyncAt,
      inboxUnread: sql<number>`coalesce((
        SELECT sum(f.unread_count) FROM folders f
        WHERE f.account_id = "accounts"."id" AND (f.special_use = '\\Inbox' OR upper(f.path) = 'INBOX')
      ), 0)::int`,
      messageCount: sql<number>`(SELECT count(*) FROM messages mm WHERE mm.account_id = "accounts"."id")::int`,
    })
    .from(accounts)
    .orderBy(asc(accounts.id));
  return rows.filter((r) => inScope(scope, r.id));
}

export async function listFolders(scope: Scope, accountId?: number) {
  const rows = await db
    .select({
      id: folders.id,
      accountId: folders.accountId,
      path: folders.path,
      name: folders.name,
      specialUse: folders.specialUse,
      syncEnabled: folders.syncEnabled,
      totalCount: folders.totalCount,
      unreadCount: folders.unreadCount,
      // 本地已同步的封数，和点进文件夹看到的一致；totalCount 是服务器上的总数
      localCount: sql<number>`(SELECT count(*) FROM messages m WHERE m.folder_id = "folders"."id")::int`,
      lastSyncAt: folders.lastSyncAt,
    })
    .from(folders)
    .where(accountId ? eq(folders.accountId, accountId) : undefined)
    .orderBy(asc(folders.accountId), asc(folders.path));
  return rows.filter((r) => inScope(scope, r.accountId));
}

const OPEN_DRAFT_STATUSES = ['draft', 'rejected', 'queued', 'sending', 'failed'];

export async function getStats(scope: Scope) {
  const list = await listAccountsWithStats(scope);
  const ids = list.map((a) => a.id);
  const [today] = ids.length
    ? (
        await db.execute<{ received_today: string; unread_total: string; important_unread: string }>(sql`
          SELECT count(*) FILTER (WHERE m.date >= date_trunc('day', now()) AND NOT ${isIgnoredSql(sql`m.from_address`)}) AS received_today,
                 count(*) FILTER (WHERE NOT m.seen) AS unread_total,
                 count(*) FILTER (WHERE NOT m.seen AND i.priority = 'high') AS important_unread
          FROM messages m JOIN folders f ON f.id = m.folder_id
          LEFT JOIN message_insights i ON i.message_id = m.id
          WHERE m.account_id = ANY(${sql.param(ids)}::int[]) AND (f.special_use = '\\Inbox' OR upper(f.path) = 'INBOX')
        `)
      ).rows
    : [];
  // 各视图的数量，口径和 buildFilters 一致：跨文件夹的视图不含垃圾箱和垃圾邮件
  const [views] = ids.length
    ? (
        await db.execute<{ unread: string; starred: string; sent: string; total: string }>(sql`
          SELECT count(*) FILTER (WHERE NOT m.seen) AS unread,
                 count(*) FILTER (WHERE m.flagged) AS starred,
                 count(*) FILTER (WHERE f.special_use = '\\Sent') AS sent,
                 count(*) AS total
          FROM messages m JOIN folders f ON f.id = m.folder_id
          WHERE m.account_id = ANY(${sql.param(ids)}::int[]) AND coalesce(f.special_use, '') NOT IN ('\\Trash', '\\Junk')
        `)
      ).rows
    : [];
  // AI 分类的数量，口径和点分类进去的列表一致（全部邮件视图，不含垃圾箱和垃圾邮件）
  const categories = ids.length
    ? (
        await db.execute<{ category: string; total: number; unread: number }>(sql`
          SELECT i.category, count(*)::int AS total, (count(*) FILTER (WHERE NOT m.seen))::int AS unread
          FROM messages m JOIN folders f ON f.id = m.folder_id
          JOIN message_insights i ON i.message_id = m.id
          WHERE m.account_id = ANY(${sql.param(ids)}::int[]) AND coalesce(f.special_use, '') NOT IN ('\\Trash', '\\Junk')
          GROUP BY i.category
        `)
      ).rows
    : [];
  // 标签的数量，口径同分类
  const labelCounts = ids.length
    ? (
        await db.execute<{ label_id: number; total: number; unread: number }>(sql`
          SELECT ml.label_id, count(*)::int AS total, (count(*) FILTER (WHERE NOT m.seen))::int AS unread
          FROM message_labels ml JOIN messages m ON m.id = ml.message_id JOIN folders f ON f.id = m.folder_id
          WHERE NOT ml.removed AND m.account_id = ANY(${sql.param(ids)}::int[]) AND coalesce(f.special_use, '') NOT IN ('\\Trash', '\\Junk')
          GROUP BY ml.label_id
        `)
      ).rows
    : [];
  const [waiting, draftCount] = await Promise.all([
    ids.length ? findWaiting(scope).then((r) => r.length) : 0,
    ids.length ? db.$count(drafts, and(inArray(drafts.accountId, ids), inArray(drafts.status, OPEN_DRAFT_STATUSES))) : 0,
  ]);
  return {
    accounts: list.map((a) => ({
      id: a.id,
      email: a.email,
      status: a.status,
      inboxUnread: a.inboxUnread,
      messageCount: a.messageCount,
      lastSyncAt: a.lastSyncAt,
    })),
    inboxUnreadTotal: Number(today?.unread_total ?? 0),
    receivedToday: Number(today?.received_today ?? 0),
    importantUnread: Number(today?.important_unread ?? 0),
    followUpsDue: await dueFollowUpCount(ids),
    unreadTotal: Number(views?.unread ?? 0),
    starredTotal: Number(views?.starred ?? 0),
    sentTotal: Number(views?.sent ?? 0),
    allTotal: Number(views?.total ?? 0),
    waitingTotal: waiting,
    // 草稿、待发和发送失败的，不含待审批（单独提醒）和已发送
    draftsTotal: draftCount,
    categories: Object.fromEntries(categories.map((c) => [c.category, { total: c.total, unread: c.unread }])),
    labels: Object.fromEntries(labelCounts.map((c) => [c.label_id, { total: c.total, unread: c.unread }])),
  };
}

/** 联系人联想：从收到的邮件发件人和已发送邮件的收件人里按出现次数排序 */
export async function searchContacts(scope: Scope, q: string, limit = 10) {
  const ids = scope.accountIds;
  const pattern = like(q);
  const res = await db.execute<{ name: string | null; alias: string | null; address: string; n: number }>(sql`
    WITH c AS (
      SELECT m.from_name AS name, lower(m.from_address) AS address FROM messages m
      WHERE m.from_address IS NOT NULL AND (${ids === null} OR m.account_id = ANY(${sql.param(ids ?? [])}::int[]))
      UNION ALL
      SELECT r->>'name', lower(r->>'address') FROM messages m
      JOIN folders f ON f.id = m.folder_id AND f.special_use = '\\Sent'
      CROSS JOIN LATERAL jsonb_array_elements(m."to" || m.cc) r
      WHERE (${ids === null} OR m.account_id = ANY(${sql.param(ids ?? [])}::int[]))
    )
    SELECT (array_agg(c.name ORDER BY c.name IS NULL))[1] AS name, c.address, ca.alias, count(*)::int AS n
    FROM c LEFT JOIN contact_aliases ca ON ca.address = c.address
    WHERE c.address ILIKE ${pattern} OR c.name ILIKE ${pattern} OR ca.alias ILIKE ${pattern}
    GROUP BY c.address, ca.alias ORDER BY n DESC LIMIT ${limit}
  `);
  // alias 是用户的备注名，只用于显示；收件人地址仍用 name（对方看到的名字）
  return res.rows.map((r) => ({ name: r.name || undefined, address: r.address, ...(r.alias ? { alias: r.alias } : {}) }));
}

/**
 * 语义搜索的候选召回：先套用搜索语法里的过滤条件，再按命中的关键词组数打分。
 * groups 里每组是同义词（任一命中即算这一组命中），至少命中一组才算候选。
 */
export async function searchCandidates(scope: Scope, q: string, groups: string[][], limit: number) {
  const conds = buildFilters({ scope, q, view: 'all' });
  const groupHits = groups
    .filter((g) => g.length)
    .map(
      (g) =>
        sql`(CASE WHEN ${sql.join(
          g.map((t) => sql`(${messages.searchText} ILIKE ${like(t)} OR coalesce(${messageInsights.summary}, '') ILIKE ${like(t)})`),
          sql` OR `,
        )} THEN 1 ELSE 0 END)`,
    );
  const score = groupHits.length ? sql.join(groupHits, sql` + `) : sql`0::int`;
  if (groupHits.length) conds.push(sql`(${score}) > 0`);

  return db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      accountId: messages.accountId,
      accountEmail: accounts.email,
      folder: folders.path,
      subject: messages.subject,
      fromName: messages.fromName,
      fromAddress: messages.fromAddress,
      date: messages.date,
      snippet: messages.snippet,
      seen: messages.seen,
      flagged: messages.flagged,
      hasAttachments: messages.hasAttachments,
      category: messageInsights.category,
      priority: messageInsights.priority,
      summary: messageInsights.summary,
      score: sql<number>`${score}`.mapWith(Number),
    })
    .from(messages)
    .innerJoin(folders, eq(folders.id, messages.folderId))
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .leftJoin(messageInsights, eq(messageInsights.messageId, messages.id))
    .where(and(...conds))
    .orderBy(sql`(${score}) DESC, ${messages.date} DESC, ${messages.id} DESC`)
    .limit(limit);
}

export type SearchCandidate = Awaited<ReturnType<typeof searchCandidates>>[number];
