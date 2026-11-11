import { open } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { actorOf, type AuthContext } from '../auth/index.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { messages, unsubscriptions, type ListInfo, type Message } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { BODY_SCAN_VERSION, needsBodyScan, withBodyUnsubscribe, type BodyFields } from '../lib/body-unsubscribe.js';
import { parseListHeaders } from '../lib/list-headers.js';
import { OutboundError, safeRequest } from '../lib/safe-fetch.js';
import { ActionError } from './actions.js';
import { createDraft, queueDraft } from './drafts.js';
import { inScope, type Scope } from './mail.js';
import { L } from '../i18n/index.js';

/**
 * 订阅邮件与退订：
 * - 一键退订（RFC 8058）：向 List-Unsubscribe 里的 https 地址 POST「List-Unsubscribe=One-Click」，不带 Cookie，不跟随跳转，不能访问内网
 * - 只给了 mailto：从收到邮件的账户发一封退订邮件（走发件箱，有撤销窗口）
 * - 只给了网页链接：交给用户在浏览器里打开，由用户自己完成
 * - 没有 List-Unsubscribe 头：从正文里找退订链接（source: 'body'），同样只交给用户自己打开
 */

/** 同一个列表的标识：List-Id，没有时用发件地址 */
export const listKeyOf = (m: Pick<Message, 'listInfo' | 'fromAddress'>) => m.listInfo?.id || m.fromAddress?.toLowerCase() || '';

const hasUnsubscribe = (info: ListInfo | null | undefined) => Boolean(info?.http || info?.mailto);

async function readHead(rawPath: string) {
  const file = await open(path.join(config.rawDir, rawPath));
  try {
    const buf = Buffer.alloc(128 * 1024);
    const { bytesRead } = await file.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

async function listInfoFromRaw(rawPath: string | null): Promise<ListInfo> {
  if (!rawPath) return {};
  try {
    return parseListHeaders(await readHead(rawPath));
  } catch {
    return {};
  }
}

const hasBody = (m: BodyFields) => m.htmlBody !== undefined || m.textBody !== undefined;

/** 还没解析过的邮件当场解析并存下；带了正文的顺便找正文里的退订链接（后台补算还没轮到时也能马上看到） */
export async function ensureListInfo<T extends Pick<Message, 'id' | 'listInfo' | 'rawPath'> & BodyFields>(list: T[]): Promise<T[]> {
  for (const m of list) {
    const before = m.listInfo;
    if (!m.listInfo) m.listInfo = await listInfoFromRaw(m.rawPath);
    if (hasBody(m) && needsBodyScan(m.listInfo)) m.listInfo = withBodyUnsubscribe(m.listInfo, m);
    if (m.listInfo !== before) await db.update(messages).set({ listInfo: m.listInfo }).where(eq(messages.id, m.id));
  }
  return list;
}

// ---- 旧邮件补算 ----

let backfilling = false;

/** 启动后在后台给旧邮件补上退订信息，最近的先算 */
export async function backfillListInfo() {
  if (backfilling) return;
  backfilling = true;
  let total = 0;
  try {
    for (;;) {
      const batch = await db
        .select({ id: messages.id, rawPath: messages.rawPath })
        .from(messages)
        .where(isNull(messages.listInfo))
        .orderBy(sql`${messages.date} DESC`)
        .limit(200);
      if (!batch.length) break;
      for (const m of batch) {
        await db
          .update(messages)
          .set({ listInfo: await listInfoFromRaw(m.rawPath) })
          .where(eq(messages.id, m.id));
      }
      total += batch.length;
      // 让出数据库和磁盘给同步
      await new Promise((r) => setTimeout(r, 200));
    }
    if (total) console.log(`[subscriptions] 已为 ${total} 封旧邮件补上退订信息`);
    await backfillBodyUnsubscribe();
  } catch (err) {
    console.warn('[subscriptions] 补算退订信息失败', err);
  } finally {
    backfilling = false;
  }
}

/** 邮件头里没有退订方式的旧邮件，按当前规则从正文里找退订链接，最近的先找 */
async function backfillBodyUnsubscribe() {
  let total = 0;
  let found = 0;
  for (;;) {
    const batch = await db
      .select({
        id: messages.id,
        subject: messages.subject,
        inReplyTo: messages.inReplyTo,
        htmlBody: messages.htmlBody,
        textBody: messages.textBody,
        listInfo: messages.listInfo,
      })
      .from(messages)
      .where(
        sql`${messages.listInfo} IS NOT NULL
            AND (${messages.listInfo}->>'source' = 'body' OR NOT (${messages.listInfo} ? 'http' OR ${messages.listInfo} ? 'mailto'))
            AND coalesce((${messages.listInfo}->>'bodyScan')::int, 0) < ${BODY_SCAN_VERSION}`,
      )
      .orderBy(sql`${messages.date} DESC`)
      .limit(200);
    if (!batch.length) break;
    for (const m of batch) {
      const info = withBodyUnsubscribe(m.listInfo!, m);
      if (info.http) found++;
      await db.update(messages).set({ listInfo: info }).where(eq(messages.id, m.id));
    }
    total += batch.length;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (total) console.log(`[subscriptions] 检查了 ${total} 封邮件的正文，找到 ${found} 个退订链接`);
}

// ---- 订阅统计 ----

export type SubscriptionRow = {
  accountId: number;
  listKey: string;
  name: string;
  address: string | null;
  count: number;
  unread: number;
  lastDate: string;
  latestMessageId: number;
  threadId: string;
  oneClick: boolean;
  method: 'one-click' | 'mailto' | 'link';
  url?: string;
  /** 退订链接是从正文里找到的（发件人没按 RFC 2369 / 8058 提供退订头） */
  fromBody: boolean;
  unsubscribed: { method: string; status: string; at: string } | null;
};

export type SubscriptionFilter = 'all' | 'ignored' | 'unsubscribed';
export type SubscriptionSort = 'count' | 'openRate' | 'lastDate';
export type SubscriptionPage = { items: SubscriptionRow[]; total: number; counts: Record<SubscriptionFilter, number> };

/** 近 N 天收件箱里带退订信息的发件人，按数量排序；打开率 = 已读 / 总数（MCP、助手用，最多 300 个） */
export async function listSubscriptions(scope: Scope, days = 90): Promise<SubscriptionRow[]> {
  return (await querySubscriptions(scope, { days, limit: 300 })).items;
}

/**
 * 订阅列表：筛选、计数、分页都在数据库里做。
 * - 已退订：有退订记录且没失败；
 * - 很少打开：没退订、近 N 天收到至少 3 封、打开率低于 20%（最值得退订）。
 * counts 是三种筛选各有多少个（筛选按钮上显示），total 是当前筛选的总数。
 */
export async function querySubscriptions(
  scope: Scope,
  opts: { days?: number; filter?: SubscriptionFilter; sort?: SubscriptionSort; order?: 'asc' | 'desc'; offset?: number; limit?: number },
): Promise<SubscriptionPage> {
  const days = opts.days ?? 90;
  const filter = opts.filter ?? 'all';
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 300);
  const offset = Math.max(opts.offset ?? 0, 0);
  const scopeCond = scope.accountIds ? (scope.accountIds.length ? sql`AND m.account_id = ANY(${sql.param(scope.accountIds)}::int[])` : sql`AND false`) : sql``;
  // 排序：默认按封数从多到少；同值时按最近一封、再按 list_key，保证翻页稳定
  const dir = opts.order === 'asc' ? sql`ASC` : sql`DESC`;
  const sortExpr = opts.sort === 'openRate' ? sql`(count - unread)::float / nullif(count, 0)` : opts.sort === 'lastDate' ? sql`last_date` : sql`count`;
  const where = filter === 'ignored' ? sql`WHERE ignored` : filter === 'unsubscribed' ? sql`WHERE unsubscribed` : sql``;
  const result = await db.execute<{
    all_n: string;
    ignored_n: string;
    unsubscribed_n: string;
    account_id: number | null;
    list_key: string;
    count: string;
    unread: string;
    last_date: Date;
    latest_id: string;
    u_method: string | null;
    u_status: string | null;
    u_at: Date | null;
  }>(sql`
    WITH g AS (
      SELECT m.account_id, coalesce(m.list_info->>'id', lower(m.from_address)) AS list_key,
             count(DISTINCT coalesce(m.message_id, m.id::text)) AS count,
             count(DISTINCT coalesce(m.message_id, m.id::text)) FILTER (WHERE NOT m.seen) AS unread,
             max(m.date) AS last_date,
             (array_agg(m.id ORDER BY m.date DESC, m.id DESC))[1] AS latest_id
      FROM messages m JOIN folders f ON f.id = m.folder_id
      WHERE m.date > now() - make_interval(days => ${days})
        AND (f.special_use = '\\Inbox' OR upper(f.path) = 'INBOX' OR f.special_use = '\\Junk')
        AND (m.list_info ? 'http' OR m.list_info ? 'mailto')
        AND coalesce(m.list_info->>'id', m.from_address) IS NOT NULL
        ${scopeCond}
      GROUP BY 1, 2
    ), s AS (
      SELECT g.*, u.method AS u_method, u.status AS u_status, u.created_at AS u_at,
             coalesce(u.status <> 'failed', false) AS unsubscribed,
             NOT coalesce(u.status <> 'failed', false) AND g.count >= 3 AND (g.count - g.unread) < 0.2 * g.count AS ignored
      FROM g LEFT JOIN unsubscriptions u ON u.account_id = g.account_id AND u.list_key = g.list_key
    )
    SELECT c.*, p.*
    FROM (SELECT count(*) AS all_n, count(*) FILTER (WHERE ignored) AS ignored_n, count(*) FILTER (WHERE unsubscribed) AS unsubscribed_n FROM s) c
    LEFT JOIN LATERAL (
      SELECT account_id, list_key, count, unread, last_date, latest_id, u_method, u_status, u_at
      FROM s ${where}
      ORDER BY ${sortExpr} ${dir}, last_date DESC, list_key, account_id
      LIMIT ${limit} OFFSET ${offset}
    ) p ON true
  `);
  const head = result.rows[0];
  const counts = { all: Number(head?.all_n ?? 0), ignored: Number(head?.ignored_n ?? 0), unsubscribed: Number(head?.unsubscribed_n ?? 0) };
  const rows = result.rows.filter((r) => r.account_id !== null);
  if (!rows.length) return { items: [], total: counts[filter], counts };

  const latest = await db
    .select({ id: messages.id, threadId: messages.threadId, fromName: messages.fromName, fromAddress: messages.fromAddress, listInfo: messages.listInfo })
    .from(messages)
    .where(
      inArray(
        messages.id,
        rows.map((r) => Number(r.latest_id)),
      ),
    );
  const byId = new Map(latest.map((m) => [m.id, m]));

  const items = rows.map((r): SubscriptionRow => {
    const m = byId.get(Number(r.latest_id))!;
    const info = m.listInfo ?? {};
    return {
      accountId: r.account_id!,
      listKey: r.list_key,
      name: m.fromName || info.name || m.fromAddress || r.list_key,
      address: m.fromAddress,
      count: Number(r.count),
      unread: Number(r.unread),
      lastDate: new Date(r.last_date).toISOString(),
      latestMessageId: m.id,
      threadId: m.threadId,
      oneClick: Boolean(info.oneClick),
      method: info.oneClick ? 'one-click' : info.mailto ? 'mailto' : 'link',
      url: !info.oneClick && !info.mailto ? info.http : undefined,
      fromBody: info.source === 'body',
      unsubscribed: r.u_method ? { method: r.u_method, status: r.u_status!, at: new Date(r.u_at!).toISOString() } : null,
    };
  });
  return { items, total: counts[filter], counts };
}

/** 会话详情用：每封邮件的退订方式和是否已退订 */
export async function unsubscribeInfoFor(list: Message[]) {
  const withList = (await ensureListInfo(list)).filter((m) => hasUnsubscribe(m.listInfo));
  // link 方式要在用户点击时直接打开网页，所以把地址一起返回
  const out = new Map<
    number,
    { method: 'one-click' | 'mailto' | 'link'; url?: string; fromBody: boolean; unsubscribed: { status: string; at: string } | null }
  >();
  if (!withList.length) return out;
  const done = await db
    .select()
    .from(unsubscriptions)
    .where(
      and(
        inArray(unsubscriptions.accountId, [...new Set(withList.map((m) => m.accountId))]),
        inArray(unsubscriptions.listKey, [...new Set(withList.map(listKeyOf))]),
      ),
    );
  const doneByKey = new Map(done.map((u) => [`${u.accountId}|${u.listKey}`, u]));
  for (const m of withList) {
    const u = doneByKey.get(`${m.accountId}|${listKeyOf(m)}`);
    const method = m.listInfo!.oneClick ? 'one-click' : m.listInfo!.mailto ? 'mailto' : 'link';
    out.set(m.id, {
      method,
      ...(method === 'link' ? { url: m.listInfo!.http } : {}),
      fromBody: m.listInfo!.source === 'body',
      unsubscribed: u ? { status: u.status, at: u.createdAt.toISOString() } : null,
    });
  }
  return out;
}

// ---- 退订 ----

export type UnsubscribeResult =
  | { method: 'one-click'; status: 'done' | 'unconfirmed'; message: string }
  | { method: 'mailto'; status: 'done'; message: string; draftId: number }
  | { method: 'link'; status: 'opened'; message: string; url: string };

async function record(m: Message, method: string, status: string, error: string | null) {
  const values = { sender: m.fromAddress, method, status, error, messageId: m.id, createdAt: new Date() };
  await db
    .insert(unsubscriptions)
    .values({ accountId: m.accountId, listKey: listKeyOf(m), ...values })
    .onConflictDoUpdate({ target: [unsubscriptions.accountId, unsubscriptions.listKey], set: values });
}

function parseMailto(uri: string) {
  const url = new URL(uri);
  const to = decodeURIComponent(url.pathname).split(',')[0]?.trim();
  if (!to || !/^[^@\s]+@[^@\s]+$/.test(to)) throw new ActionError(L('退订邮件地址不正确', 'Invalid unsubscribe email address'));
  return { to, subject: url.searchParams.get('subject') || 'unsubscribe', body: url.searchParams.get('body') || 'unsubscribe' };
}

export async function unsubscribe(auth: AuthContext, messageId: number): Promise<UnsubscribeResult> {
  const [found] = await db.select().from(messages).where(eq(messages.id, messageId));
  if (!found || !inScope(auth.scope, found.accountId)) throw new ActionError(L('邮件不存在', 'Message not found'), 404);
  const [m] = await ensureListInfo([found]);
  const info = m!.listInfo ?? {};
  if (!hasUnsubscribe(info)) throw new ActionError(L('这封邮件没有提供退订方式', 'This message does not offer a way to unsubscribe'));
  const actor = actorOf(auth);
  const auditDetail = { listKey: listKeyOf(m!), sender: m!.fromAddress };

  if (info.oneClick && info.http) {
    try {
      const res = await safeRequest({
        url: info.http,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
        httpsOnly: true,
        timeoutMs: 10_000,
        maxBytes: 4096,
      });
      // 很多发件方回一个跳转到「已退订」页面，也算成功
      if (res.status < 200 || res.status >= 400)
        throw new ActionError(L(`对方返回 HTTP ${res.status}，退订没有成功`, `The sender returned HTTP ${res.status}; unsubscribe failed`));
      await record(m!, 'one-click', 'done', null);
      audit(actor, 'message.unsubscribe', { accountId: m!.accountId, target: `message:${m!.id}`, detail: { ...auditDetail, method: 'one-click' } });
      return { method: 'one-click', status: 'done', message: L('已退订', 'Unsubscribed') };
    } catch (err) {
      if (err instanceof OutboundError && err.code === 'unconfirmed') {
        await record(m!, 'one-click', 'unconfirmed', err.message);
        return {
          method: 'one-click',
          status: 'unconfirmed',
          message: L('对方没有及时响应，退订可能已经生效', 'The sender did not respond in time; the unsubscribe may still have worked'),
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      await record(m!, 'one-click', 'failed', msg);
      throw new ActionError(
        L(
          `一键退订失败：${msg}。可以稍后重试，或在邮件正文里找退订链接`,
          `One-click unsubscribe failed: ${msg}. Try again later, or look for an unsubscribe link in the email`,
        ),
      );
    }
  }

  if (info.mailto) {
    const { to, subject, body } = parseMailto(info.mailto);
    const draft = await createDraft(auth, { accountId: m!.accountId, mode: 'new', to: [to], subject, body }, auth.kind === 'apiKey' ? 'api' : 'web');
    await queueDraft(auth, draft.id);
    await record(m!, 'mailto', 'done', null);
    audit(actor, 'message.unsubscribe', { accountId: m!.accountId, target: `message:${m!.id}`, detail: { ...auditDetail, method: 'mailto', to } });
    return {
      method: 'mailto',
      status: 'done',
      message: L(
        `已向 ${to} 发送退订邮件，发出前可以在「草稿与待发」里撤销`,
        `Sent an unsubscribe email to ${to}; you can undo it in Drafts & outbox before it goes out`,
      ),
      draftId: draft.id,
    };
  }

  // 网页上是否真的退订了无从得知，只记为已打开
  await record(m!, 'link', 'opened', null);
  audit(actor, 'message.unsubscribe', { accountId: m!.accountId, target: `message:${m!.id}`, detail: { ...auditDetail, method: 'link' } });
  return {
    method: 'link',
    status: 'opened',
    message: L('已打开退订网页，请在网页上完成退订', 'Opened the unsubscribe page; finish unsubscribing there'),
    url: info.http!,
  };
}
