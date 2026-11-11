import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, followUps, messages, type Address, type FollowUp } from '../db/schema.js';
import { bus } from '../lib/events.js';
import { ActionError } from './actions.js';
import { inScope, type Scope } from './mail.js';
import { appUrl, emitEvent } from './notify.js';
import { dateTimeFormat, L } from '../i18n/index.js';

/**
 * 等回复与跟进提醒。
 * 等回复：会话最后一封是我发的、在等对方回答，并且已经超过 max(48 小时, 对方平时回复用时中位数的 3 倍)，全部按邮件头计算，不调用模型。
 * 跟进提醒：给发出的邮件定一个时间，到点还没有回信（按回信的 In-Reply-To / References 判断）就推送到通知渠道。
 */

const HOUR = 3600_000;
const DAY = 24 * HOUR;
// 太久以前发出的邮件不再算在等（设了提醒的除外）
const WINDOW_DAYS = 14;
const MIN_WAIT = 48 * HOUR;
// 平时回得慢的人，最多等一周也该列出来了
const MAX_WAIT = 7 * DAY;
const MAX_REMIND_DAYS = 365;

// 机器发信和职能邮箱：不会有人回复，也不该等它们
const NOREPLY = /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer(-daemon)?|bounces?|postmaster|alerts?)([._+-].*)?@/i;
const ROLE =
  /^(billing|receipts?|invoices?|orders?|shipping|renewals?|subscriptions?|support|help|info|sales|news(letter)?|marketing|deals?|updates?|digest|hello|team|contact|accounts?|security|admin|feedback|service|kefu|calendar(-notification)?)@/i;
const isMachine = (address: string) => NOREPLY.test(address) || ROLE.test(address);

// 我主动发起的对话，或者信里在提问、请对方做事，才算在等回复；只是回一句「收到」不算
const ASKS =
  /[?？]|请(你|您)?(确认|回复|告知|查收|提供|看下|看一下|审批|反馈)|麻烦|能否|可否|是否|能不能|可不可以|盼复|望复|期待.{0,6}回复|let me know|please (confirm|reply|advise|review)|could you|can you|would you/i;

type FollowUpBrief = { id: number; status: string; dueAt: string | null };

export type WaitingInfo = {
  // 我发出的那封（库里的 id）
  messageId: number;
  to: { name: string | null; address: string | null };
  sentAt: string;
  // 对方平时多久回我，没有记录时为 null
  baselineHours: number | null;
  followUp: FollowUpBrief | null;
};

export type WaitingRow = { threadId: string; latestId: number; lastDate: Date; waiting: WaitingInfo };

const brief = (f: Pick<FollowUp, 'id' | 'status' | 'dueAt'>): FollowUpBrief => ({ id: f.id, status: f.status, dueAt: f.dueAt?.toISOString() ?? null });

async function selfAddresses() {
  const rows = await db.select({ email: accounts.email }).from(accounts);
  return rows.map((r) => r.email.toLowerCase());
}

function scopeSql(scope: Scope, accountId?: number, alias = sql`m`) {
  const parts = [];
  if (scope.accountIds) parts.push(scope.accountIds.length ? sql`AND ${alias}.account_id = ANY(${sql.param(scope.accountIds)}::int[])` : sql`AND false`);
  if (accountId) parts.push(sql`AND ${alias}.account_id = ${accountId}`);
  return sql.join(parts, sql` `);
}

/** 等对方回复的会话，设了提醒且到期的排在最前，其余按等待时间从久到近 */
export async function findWaiting(scope: Scope, accountId?: number): Promise<WaitingRow[]> {
  const self = await selfAddresses();
  if (!self.length) return [];
  const selfParam = sql.param(self);
  const latest = await db.execute<{
    id: string;
    thread_id: string;
    account_id: number;
    message_id: string | null;
    in_reply_to: string | null;
    subject: string;
    snippet: string;
    to: Address[];
    cc: Address[];
    from_address: string | null;
    date: Date;
  }>(sql`
    WITH cand AS (
      SELECT m.thread_id FROM messages m
      WHERE m.date > now() - make_interval(days => ${WINDOW_DAYS}) AND lower(m.from_address) = ANY(${selfParam}::text[]) ${scopeSql(scope, accountId)}
      UNION
      SELECT m.thread_id FROM messages m
      JOIN follow_ups fu ON fu.account_id = m.account_id AND fu.message_id = m.message_id
      WHERE fu.status IN ('open', 'due') ${scopeSql(scope, accountId)}
    )
    SELECT DISTINCT ON (m.thread_id) m.id, m.thread_id, m.account_id, m.message_id, m.in_reply_to, m.subject, m.snippet, m.to, m.cc, m.from_address, m.date
    FROM messages m JOIN folders f ON f.id = m.folder_id
    WHERE m.thread_id IN (SELECT thread_id FROM cand) AND coalesce(f.special_use, '') NOT IN ('\\Trash', '\\Junk') ${scopeSql(scope, accountId)}
    ORDER BY m.thread_id, m.date DESC, m.id DESC
  `);
  const mine = latest.rows.filter((r) => r.from_address && self.includes(r.from_address.toLowerCase()));
  if (!mine.length) return [];

  // 会话里的跟进提醒：优先取挂在最后一封上的
  const fus = await db.execute<{ id: number; status: string; due_at: Date | null; thread_id: string; message_id: string; account_id: number }>(sql`
    SELECT DISTINCT ON (fu.id) fu.id, fu.status, fu.due_at, m.thread_id, fu.message_id, fu.account_id
    FROM follow_ups fu JOIN messages m ON m.account_id = fu.account_id AND m.message_id = fu.message_id
    WHERE m.thread_id = ANY(${sql.param(mine.map((r) => r.thread_id))}::text[])
  `);
  const fuOf = (r: (typeof mine)[number]) => {
    const list = fus.rows.filter((f) => f.thread_id === r.thread_id);
    return (
      list.find((f) => f.account_id === r.account_id && f.message_id === r.message_id) ?? list.find((f) => f.status === 'open' || f.status === 'due') ?? null
    );
  };

  const now = Date.now();
  type Candidate = { row: (typeof mine)[number]; primary: Address; fu: ReturnType<typeof fuOf>; reminded: boolean };
  const candidates: Candidate[] = [];
  for (const row of mine) {
    const fu = fuOf(row);
    const reminded = fu?.status === 'open' || fu?.status === 'due';
    // 标了「不用再等」或者已经收到回复
    if (fu && !reminded && fu.message_id === row.message_id) continue;
    const humans = [...row.to, ...row.cc].filter((a) => a.address && !self.includes(a.address.toLowerCase()) && !isMachine(a.address));
    const primary = humans[0] ?? row.to[0];
    if (!primary) continue;
    if (!reminded) {
      if (!humans.length) continue;
      if (row.in_reply_to && !ASKS.test(`${row.subject}\n${row.snippet}`)) continue;
      const age = now - new Date(row.date).getTime();
      if (age < MIN_WAIT || age > WINDOW_DAYS * DAY) continue;
    }
    candidates.push({ row, primary, fu, reminded });
  }
  if (!candidates.length) return [];

  // 对方平时回我的用时（近半年、两周内回的才算）
  const addrs = [...new Set(candidates.map((c) => c.primary.address!.toLowerCase()))];
  const base = await db.execute<{ addr: string; med: number }>(sql`
    SELECT lower(r.from_address) AS addr, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.date - s.date)) AS med
    FROM messages r JOIN messages s ON s.account_id = r.account_id AND s.message_id = r.in_reply_to
    WHERE lower(r.from_address) = ANY(${sql.param(addrs)}::text[]) AND lower(s.from_address) = ANY(${selfParam}::text[])
      AND r.date > s.date AND r.date - s.date < make_interval(days => ${WINDOW_DAYS}) AND r.date > now() - interval '180 days'
    GROUP BY 1
  `);
  const baseline = new Map(base.rows.map((b) => [b.addr, Number(b.med) * 1000]));

  const out: WaitingRow[] = [];
  for (const c of candidates) {
    const sentAt = new Date(c.row.date);
    const med = baseline.get(c.primary.address!.toLowerCase()) ?? null;
    if (!c.reminded && now - sentAt.getTime() < Math.min(MAX_WAIT, Math.max(MIN_WAIT, med === null ? 0 : 3 * med))) continue;
    out.push({
      threadId: c.row.thread_id,
      latestId: Number(c.row.id),
      lastDate: sentAt,
      waiting: {
        messageId: Number(c.row.id),
        to: { name: c.primary.name || null, address: c.primary.address ?? null },
        sentAt: sentAt.toISOString(),
        baselineHours: med === null ? null : Math.round((med / HOUR) * 10) / 10,
        followUp: c.fu ? brief({ id: c.fu.id, status: c.fu.status, dueAt: c.fu.due_at ? new Date(c.fu.due_at) : null }) : null,
      },
    });
  }
  const rank = (w: WaitingInfo) => (w.followUp?.status === 'due' ? 0 : 1);
  return out.sort((a, b) => rank(a.waiting) - rank(b.waiting) || a.lastDate.getTime() - b.lastDate.getTime());
}

/** 一组邮件上的跟进提醒，给会话详情显示 */
export async function followUpsFor(list: { accountId: number; messageId: string | null }[]) {
  const ids = [...new Set(list.map((m) => m.messageId).filter((x): x is string => Boolean(x)))];
  if (!ids.length) return new Map<string, FollowUpBrief>();
  const rows = await db
    .select()
    .from(followUps)
    .where(and(inArray(followUps.messageId, ids), inArray(followUps.accountId, [...new Set(list.map((m) => m.accountId))])));
  return new Map(rows.map((f) => [`${f.accountId}|${f.messageId}`, brief(f)]));
}

async function sentMessage(scope: Scope, id: number) {
  const [m] = await db.select().from(messages).where(eq(messages.id, id));
  if (!m || !inScope(scope, m.accountId)) throw new ActionError(L('邮件不存在', 'Message not found'), 404);
  if (!m.messageId) throw new ActionError(L('这封邮件没有 Message-ID，无法跟踪回复', 'This message has no Message-ID, so replies cannot be tracked'));
  return m;
}

/** 设置或修改提醒时间；done 表示不用再等，从等回复里拿掉 */
export async function setFollowUp(scope: Scope, id: number, input: { dueAt?: Date; done?: boolean }) {
  const m = await sentMessage(scope, id);
  if (!input.done) {
    const due = input.dueAt?.getTime() ?? NaN;
    if (!Number.isFinite(due) || due <= Date.now()) throw new ActionError(L('提醒时间要晚于现在', 'The reminder time must be in the future'));
    if (due > Date.now() + MAX_REMIND_DAYS * DAY) throw new ActionError(L('提醒最多只能设在一年以内', 'Reminders can be set at most one year ahead'));
  }
  const values = {
    subject: m.subject,
    to: m.to,
    dueAt: input.done ? null : input.dueAt!,
    status: input.done ? 'done' : 'open',
    notifiedAt: null,
    repliedAt: null,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(followUps)
    .values({ accountId: m.accountId, messageId: m.messageId!, ...values })
    .onConflictDoUpdate({ target: [followUps.accountId, followUps.messageId], set: values })
    .returning();
  bus.publish({ type: 'followups.updated', accountId: m.accountId });
  return brief(row!);
}

/** 取消提醒，邮件回到按规则判断的等回复 */
export async function clearFollowUp(scope: Scope, id: number) {
  const m = await sentMessage(scope, id);
  await db.delete(followUps).where(and(eq(followUps.accountId, m.accountId), eq(followUps.messageId, m.messageId!)));
  bus.publish({ type: 'followups.updated', accountId: m.accountId });
}

/** 写信时选了「几天没回复提醒我」：发送成功后创建提醒 */
export async function createFollowUpForSent(input: { accountId: number; messageId: string; subject: string; to: Address[]; days: number }) {
  const values = {
    subject: input.subject,
    to: input.to,
    dueAt: new Date(Date.now() + input.days * DAY),
    status: 'open',
    notifiedAt: null,
    repliedAt: null,
    updatedAt: new Date(),
  };
  await db
    .insert(followUps)
    .values({ accountId: input.accountId, messageId: input.messageId, ...values })
    .onConflictDoUpdate({ target: [followUps.accountId, followUps.messageId], set: values });
  bus.publish({ type: 'followups.updated', accountId: input.accountId });
}

export async function dueFollowUpCount(accountIds: number[]) {
  if (!accountIds.length) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(followUps)
    .where(and(eq(followUps.status, 'due'), inArray(followUps.accountId, accountIds)));
  return row?.n ?? 0;
}

// ---- 后台检查 ----

const names = (to: Address[]) => {
  const list = to.map((a) => a.name || a.address).filter(Boolean);
  const sep = L('、', ', ');
  return list.length > 2
    ? L(`${list.slice(0, 2).join(sep)} 等 ${list.length} 人`, `${list.slice(0, 2).join(sep)} and ${list.length - 2} more`)
    : list.join(sep) || L('对方', 'The recipient');
};

async function tick() {
  // 先结束已经收到回复的（自己账户发的不算回复）
  const replied = await db.execute<{ account_id: number }>(sql`
    UPDATE follow_ups fu SET status = 'replied', replied_at = now(), updated_at = now()
    WHERE fu.status IN ('open', 'due') AND EXISTS (
      SELECT 1 FROM messages m
      WHERE m.account_id = fu.account_id
        AND (m.in_reply_to = fu.message_id OR m.references @> ARRAY[fu.message_id])
        AND lower(coalesce(m.from_address, '')) NOT IN (SELECT lower(email) FROM accounts)
    )
    RETURNING fu.account_id
  `);
  const due = await db
    .update(followUps)
    .set({ status: 'due', notifiedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(followUps.status, 'open'), lte(followUps.dueAt, new Date())))
    .returning();
  for (const f of due) {
    const [m] = await db
      .select({ threadId: messages.threadId, date: messages.date })
      .from(messages)
      .where(and(eq(messages.accountId, f.accountId), eq(messages.messageId, f.messageId)))
      .limit(1);
    const lines = [L(`${names(f.to)} 还没有回复`, `${names(f.to)} has not replied yet`)];
    if (m)
      lines.push(
        L(
          `发出于 ${dateTimeFormat(m.date)}，已等 ${Math.max(1, Math.round((Date.now() - m.date.getTime()) / DAY))} 天`,
          `Sent ${dateTimeFormat(m.date)}, waiting for ${Math.max(1, Math.round((Date.now() - m.date.getTime()) / DAY))} days`,
        ),
      );
    await emitEvent('followup.due', {
      title: L(`跟进提醒：${f.subject || '(无主题)'}`, `Follow-up: ${f.subject || '(no subject)'}`),
      body: lines.join('\n'),
      url: appUrl(m ? `/mail?view=waiting&thread=${encodeURIComponent(m.threadId)}` : '/mail?view=waiting'),
      data: { followUpId: f.id, accountId: f.accountId, subject: f.subject, to: f.to },
    }).catch((err) => console.error('[followups]', err));
  }
  for (const accountId of new Set([...replied.rows.map((r) => r.account_id), ...due.map((f) => f.accountId)])) {
    bus.publish({ type: 'followups.updated', accountId });
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startFollowUps() {
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      console.warn('[followups]', err);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void run(), 20_000);
  timer = setInterval(() => void run(), 60_000);
}

export function stopFollowUps() {
  if (timer) clearInterval(timer);
  timer = null;
}
