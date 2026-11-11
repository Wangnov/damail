import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { reports, settings, type Report, type ReportData, type ReportItem } from '../db/schema.js';
import { categoryLabel, generateText, getAiConfig } from './ai.js';
import { isIgnoredSql } from './contacts.js';
import { currentLocale, intlLocale, L, t } from '../i18n/index.js';
import { prompt } from './catalog.js';
import { appUrl, emitEvent } from './notify.js';

/**
 * 日报 / 周报：统计、重要邮件、待回复、账单都直接用 SQL 算出来，AI 只在这些数据上写一段摘要。
 * 日报覆盖前一天，周报覆盖上周一到周日，按服务器时区（TZ）划分。
 */

export type ReportKind = 'daily' | 'weekly';

export const reportSettingsSchema = z.object({
  daily: z.object({ enabled: z.boolean(), hour: z.number().int().min(0).max(23) }),
  weekly: z.object({ enabled: z.boolean(), hour: z.number().int().min(0).max(23) }),
  aiSummary: z.boolean(),
});
export type ReportSettings = z.infer<typeof reportSettingsSchema>;

const DEFAULT_SETTINGS: ReportSettings = {
  daily: { enabled: true, hour: 8 },
  weekly: { enabled: true, hour: 9 },
  aiSummary: true,
};

export async function getReportSettings(): Promise<ReportSettings> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, 'reports') });
  const parsed = reportSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...((row?.value as object) ?? {}) });
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function saveReportSettings(input: unknown) {
  const value = reportSettingsSchema.parse(input);
  await db
    .insert(settings)
    .values({ key: 'reports', value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  return value;
}

// ---- 周期 ----

export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DAY = 86_400_000;

export function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** 周一为一周的开始 */
export function startOfWeek(d: Date) {
  const x = startOfDay(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function periodOf(kind: ReportKind, anchor: Date) {
  const start = kind === 'daily' ? startOfDay(anchor) : startOfWeek(anchor);
  const end = addDays(start, kind === 'daily' ? 1 : 7);
  return { start, end };
}

const WEEKDAYS = () =>
  currentLocale() === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const md = (d: Date) => L(`${d.getMonth() + 1}月${d.getDate()}日`, d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));

function titleOf(kind: ReportKind, start: Date, end: Date) {
  if (kind === 'daily') return `${L('日报', 'Daily report')} · ${md(start)} ${WEEKDAYS()[start.getDay()]}`;
  return `${L('周报', 'Weekly report')} · ${md(start)} – ${md(addDays(end, -1))}`;
}

// ---- 统计 ----

type Row = Record<string, unknown>;
export const rows = async <T extends Row>(q: ReturnType<typeof sql>) => (await db.execute<T>(q)).rows;

/**
 * 收到的邮件：排除已发送 / 草稿 / 垃圾箱和自己发的，同一封在多个文件夹（Gmail 标签）里只算一次，优先取收件箱里的那份。
 * skipIgnored 时再排除忽略名单里的发件人（日报用；统计页看的是全部来信）
 */
export function receivedCte(start: Date, until: Date, opts: { skipIgnored?: boolean } = {}) {
  return sql`
    own AS (SELECT lower(email) AS e FROM accounts),
    recv AS (
      SELECT DISTINCT ON (m.account_id, coalesce(m.message_id, m.id::text))
             m.id, m.account_id, m.thread_id, m.subject, m.from_name, m.from_address, m.date, m.answered,
             (f.special_use = '\\Inbox' OR upper(f.path) = 'INBOX') AS in_inbox
      FROM messages m JOIN folders f ON f.id = m.folder_id
      WHERE m.date >= ${start.toISOString()}::timestamptz AND m.date < ${until.toISOString()}::timestamptz
        AND coalesce(f.special_use, '') NOT IN ('\\Sent', '\\Drafts', '\\Junk')
        AND lower(coalesce(m.from_address, '')) NOT IN (SELECT e FROM own)
        ${opts.skipIgnored ? sql`AND NOT ${isIgnoredSql(sql`m.from_address`)}` : sql``}
      ORDER BY m.account_id, coalesce(m.message_id, m.id::text), (f.special_use = '\\Inbox' OR upper(f.path) = 'INBOX') DESC, m.id
    )`;
}

export function sentCte(start: Date, until: Date) {
  return sql`
    own_s AS (SELECT lower(email) AS e FROM accounts),
    sent AS (
      SELECT DISTINCT ON (m.account_id, coalesce(m.message_id, m.id::text)) m.id, m.account_id, m.date
      FROM messages m JOIN folders f ON f.id = m.folder_id
      WHERE m.date >= ${start.toISOString()}::timestamptz AND m.date < ${until.toISOString()}::timestamptz
        AND (f.special_use = '\\Sent' OR lower(coalesce(m.from_address, '')) IN (SELECT e FROM own_s))
        AND coalesce(f.special_use, '') NOT IN ('\\Drafts', '\\Trash')
      ORDER BY m.account_id, coalesce(m.message_id, m.id::text), m.id
    )`;
}

type ItemRow = {
  id: string;
  thread_id: string;
  subject: string;
  from_name: string | null;
  from_address: string | null;
  date: Date;
  account_id: number;
  summary: string | null;
};

const toItem = (r: ItemRow): ReportItem => ({
  id: Number(r.id),
  threadId: r.thread_id,
  subject: r.subject || L('(无主题)', '(no subject)'),
  from: r.from_name || r.from_address || L('(未知)', '(unknown)'),
  summary: r.summary,
  date: new Date(r.date).toISOString(),
  accountId: r.account_id,
});

export async function collectReportData(start: Date, until: Date, prevStart: Date): Promise<ReportData> {
  const recv = receivedCte(start, until, { skipIgnored: true });
  const [totals] = await rows<{ received: string; analyzed: string; verification: string }>(sql`
    WITH ${recv}
    SELECT count(*) AS received,
           count(i.message_id) AS analyzed,
           count(*) FILTER (WHERE i.category = 'verification' OR jsonb_array_length(coalesce(i.extracted->'codes', '[]'::jsonb)) > 0) AS verification
    FROM recv LEFT JOIN message_insights i ON i.message_id = recv.id`);

  const [prev] = await rows<{ n: string }>(sql`WITH ${receivedCte(prevStart, start, { skipIgnored: true })} SELECT count(*) AS n FROM recv`);

  const sentByAccount = await rows<{ account_id: number; n: string }>(sql`
    WITH ${sentCte(start, until)} SELECT account_id, count(*) AS n FROM sent GROUP BY account_id`);

  const byAccountRows = await rows<{ id: number; name: string; email: string; received: string }>(sql`
    WITH ${recv}
    SELECT a.id, a.name, a.email, count(recv.id) AS received
    FROM accounts a LEFT JOIN recv ON recv.account_id = a.id
    GROUP BY a.id ORDER BY count(recv.id) DESC, a.id`);

  const byCategoryRows = await rows<{ category: string | null; n: string }>(sql`
    WITH ${recv}
    SELECT i.category, count(*) AS n FROM recv LEFT JOIN message_insights i ON i.message_id = recv.id
    GROUP BY i.category ORDER BY count(*) DESC`);

  const byDayRecv = await rows<{ d: string; n: string }>(sql`
    WITH ${recv}
    SELECT to_char(date AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS d, count(*) AS n FROM recv GROUP BY 1`);
  const byDaySent = await rows<{ d: string; n: string }>(sql`
    WITH ${sentCte(start, until)}
    SELECT to_char(date AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS d, count(*) AS n FROM sent GROUP BY 1`);

  const topSenders = await rows<{ address: string; name: string | null; n: string }>(sql`
    WITH ${recv}
    SELECT lower(from_address) AS address, max(from_name) AS name, count(*) AS n
    FROM recv WHERE from_address IS NOT NULL
    GROUP BY lower(from_address) ORDER BY count(*) DESC, max(date) DESC LIMIT 8`);

  const important = await rows<ItemRow>(sql`
    WITH ${recv}
    SELECT recv.*, i.summary FROM recv JOIN message_insights i ON i.message_id = recv.id
    WHERE i.priority = 'high' AND i.category NOT IN ('verification', 'spam', 'marketing')
    ORDER BY recv.date DESC LIMIT 10`);

  // 待回复：周期内收到、AI 判断需要回复、还没回复、仍在收件箱
  const needsReply = await rows<ItemRow>(sql`
    WITH ${recv}
    SELECT recv.*, i.summary FROM recv JOIN message_insights i ON i.message_id = recv.id
    WHERE i.needs_reply AND NOT recv.answered AND recv.in_inbox
    ORDER BY recv.date DESC LIMIT 10`);

  const bills = await rows<ItemRow & { amounts: Array<{ value: number; currency: string; label: string }> | null; due_date: string | null }>(sql`
    WITH ${recv}
    SELECT recv.*, i.summary, i.extracted->'amounts' AS amounts, i.extracted->>'dueDate' AS due_date
    FROM recv JOIN message_insights i ON i.message_id = recv.id
    WHERE i.category = 'finance' AND (i.extracted->>'dueDate' IS NOT NULL OR jsonb_array_length(coalesce(i.extracted->'amounts', '[]'::jsonb)) > 0)
    ORDER BY (i.extracted->>'dueDate') NULLS LAST, recv.date DESC LIMIT 8`);

  const [unread] = await rows<{ n: string }>(sql`
    SELECT coalesce(sum(unread_count), 0) AS n FROM folders WHERE special_use = '\\Inbox' OR upper(path) = 'INBOX'`);

  const [drafts] = await rows<{ sent: string; failed: string; pending: string }>(sql`
    SELECT count(*) FILTER (WHERE status = 'sent' AND sent_at >= ${start.toISOString()}::timestamptz AND sent_at < ${until.toISOString()}::timestamptz) AS sent,
           count(*) FILTER (WHERE status = 'failed' AND updated_at >= ${start.toISOString()}::timestamptz AND updated_at < ${until.toISOString()}::timestamptz) AS failed,
           count(*) FILTER (WHERE status = 'pending') AS pending
    FROM drafts`);

  const sentMap = new Map(sentByAccount.map((r) => [r.account_id, Number(r.n)]));
  const recvDay = new Map(byDayRecv.map((r) => [r.d, Number(r.n)]));
  const sentDay = new Map(byDaySent.map((r) => [r.d, Number(r.n)]));
  const byDay: ReportData['byDay'] = [];
  for (let d = new Date(start); d < until; d = addDays(d, 1)) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    byDay.push({ date: key, received: recvDay.get(key) ?? 0, sent: sentDay.get(key) ?? 0 });
  }
  const fmtAmount = (a: { value: number; currency: string } | undefined) => {
    if (!a) return null;
    try {
      return new Intl.NumberFormat(intlLocale(), { style: 'currency', currency: a.currency || 'CNY' }).format(a.value);
    } catch {
      return `${a.currency} ${a.value}`;
    }
  };

  return {
    until: until.toISOString(),
    received: Number(totals?.received ?? 0),
    receivedPrev: Number(prev?.n ?? 0),
    sent: [...sentMap.values()].reduce((a, b) => a + b, 0),
    unreadNow: Number(unread?.n ?? 0),
    analyzed: Number(totals?.analyzed ?? 0),
    verificationCount: Number(totals?.verification ?? 0),
    byAccount: byAccountRows.map((r) => ({ accountId: r.id, name: r.name, email: r.email, received: Number(r.received), sent: sentMap.get(r.id) ?? 0 })),
    byCategory: byCategoryRows.map((r) => ({
      category: r.category ?? 'unanalyzed',
      label: categoryLabel(r.category),
      count: Number(r.n),
    })),
    byDay,
    topSenders: topSenders.map((r) => ({ address: r.address, name: r.name || r.address, count: Number(r.n) })),
    important: important.map(toItem),
    needsReply: needsReply.map(toItem),
    bills: bills.map((r) => ({ ...toItem(r), amount: fmtAmount(r.amounts?.[0]), dueDate: r.due_date })),
    drafts: { sent: Number(drafts?.sent ?? 0), failed: Number(drafts?.failed ?? 0), pending: Number(drafts?.pending ?? 0) },
  };
}

// ---- AI 摘要 ----

const summarySystem = () => prompt('report.summary');

function describeForSummary(kind: ReportKind, title: string, d: ReportData) {
  const lines = [
    `${title}（${kind === 'daily' ? '与前一天' : '与上周'}相比）`,
    `收到 ${d.received} 封（之前 ${d.receivedPrev} 封），发出 ${d.sent} 封，验证码 ${d.verificationCount} 封，收件箱当前未读 ${d.unreadNow} 封，待审批草稿 ${d.drafts.pending} 封`,
    `分类：${d.byCategory.map((c) => `${c.label} ${c.count}`).join('，') || '无'}`,
    `发件最多：${
      d.topSenders
        .slice(0, 5)
        .map((s) => `${s.name}（${s.count}）`)
        .join('，') || '无'
    }`,
  ];
  const item = (i: ReportItem) => `- ${i.from}：${i.subject}${i.summary ? `｜${i.summary}` : ''}`;
  if (d.important.length) lines.push('重要邮件：', ...d.important.map(item));
  if (d.needsReply.length) lines.push('待回复：', ...d.needsReply.map(item));
  if (d.bills.length) lines.push('账单：', ...d.bills.map((b) => `${item(b)}${b.amount ? `｜金额 ${b.amount}` : ''}${b.dueDate ? `｜到期 ${b.dueDate}` : ''}`));
  return lines.join('\n');
}

async function writeSummary(kind: ReportKind, title: string, data: ReportData) {
  const [s, ai] = await Promise.all([getReportSettings(), getAiConfig()]);
  if (!s.aiSummary || !ai.enabled) return { summary: null, summaryError: null };
  if (data.received === 0 && data.sent === 0) return { summary: null, summaryError: null };
  try {
    const summary = await generateText(summarySystem(), describeForSummary(kind, title, data), { purpose: 'report', maxTokens: 2048, config: ai });
    return { summary: summary.slice(0, 4000), summaryError: null };
  } catch (err) {
    return { summary: null, summaryError: (err as Error).message };
  }
}

// ---- 生成与推送 ----

function noticeBody(r: Report) {
  const d = r.data;
  const lines = [
    L(
      `收到 ${d.received} 封，发出 ${d.sent} 封，重要 ${d.important.length}，待回复 ${d.needsReply.length}`,
      `Received ${d.received}, sent ${d.sent}, important ${d.important.length}, needs reply ${d.needsReply.length}`,
    ),
  ];
  if (r.summary) lines.push('', r.summary.length > 600 ? `${r.summary.slice(0, 600)}…` : r.summary);
  else if (d.important.length) lines.push('', ...d.important.slice(0, 3).map((i) => `- ${i.from}${L('：', ': ')}${i.subject}`));
  return lines.join('\n');
}

const inflight = new Set<string>();

/**
 * 生成（或重新生成）某个周期的报告。anchor 是周期内的任意时刻，默认取上一个完整周期。
 * 自动生成的完整周期首次生成时推送给订阅了 report.daily / report.weekly 的渠道。
 */
export async function generateReport(kind: ReportKind, anchor?: Date, opts: { notify?: boolean } = {}) {
  const now = new Date();
  const { start, end } = periodOf(kind, anchor ?? new Date(now.getTime() - (kind === 'daily' ? DAY : 7 * DAY)));
  if (start > now) throw new Error(L('这个周期还没开始', 'This period has not started yet'));
  const key = `${kind}:${start.toISOString()}`;
  if (inflight.has(key)) throw new Error(L('报告正在生成，请稍候', 'This report is already being generated; please wait'));
  inflight.add(key);
  try {
    const until = end < now ? end : now;
    const prevStart = kind === 'daily' ? addDays(start, -1) : addDays(start, -7);
    const data = await collectReportData(start, until, prevStart);
    const title =
      titleOf(kind, start, end) +
      (until < end
        ? L('（截至 {t}）', ' (as of {t})').replace('{t}', `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`)
        : '');
    const { summary, summaryError } = await writeSummary(kind, title, data);
    const existed = await db.query.reports.findFirst({ where: and(eq(reports.kind, kind), eq(reports.periodStart, start)), columns: { id: true } });
    const [row] = await db
      .insert(reports)
      .values({ kind, periodStart: start, periodEnd: end, title, data, summary, summaryError })
      .onConflictDoUpdate({
        target: [reports.kind, reports.periodStart],
        set: { title, data, summary, summaryError, createdAt: new Date() },
      })
      .returning();
    if (opts.notify && !existed && until >= end) {
      await emitEvent(`report.${kind}`, {
        title: `DaMail ${title}`,
        body: noticeBody(row!),
        url: appUrl(`/reports/${row!.id}`),
        data: { reportId: row!.id, kind },
      });
    }
    return row!;
  } finally {
    inflight.delete(key);
  }
}

export async function listReports(kind?: ReportKind, limit = 60) {
  return db
    .select({
      id: reports.id,
      kind: reports.kind,
      title: reports.title,
      periodStart: reports.periodStart,
      periodEnd: reports.periodEnd,
      createdAt: reports.createdAt,
      received: sql<number>`(${reports.data}->>'received')::int`,
    })
    .from(reports)
    .where(kind ? eq(reports.kind, kind) : undefined)
    .orderBy(desc(reports.periodStart), desc(reports.id))
    .limit(Math.min(limit, 200));
}

export async function getReport(id: number) {
  return db.query.reports.findFirst({ where: eq(reports.id, id) });
}

export async function latestReport(kind: ReportKind) {
  return db.query.reports.findFirst({ where: eq(reports.kind, kind), orderBy: desc(reports.periodStart) });
}

export async function deleteReport(id: number) {
  await db.delete(reports).where(eq(reports.id, id));
}

// ---- 定时 ----

let timer: NodeJS.Timeout | null = null;

/** 每分钟检查一次：到了设定的时刻、上一个周期还没有报告，就生成并推送。停机期间错过的只补最近一期 */
async function checkSchedule() {
  const s = await getReportSettings();
  const hasAccounts = await db.execute(sql`SELECT 1 FROM accounts LIMIT 1`);
  if (!hasAccounts.rows.length) return;
  const now = new Date();
  const due: Array<{ kind: ReportKind; anchor: Date }> = [];
  if (s.daily.enabled && now.getHours() >= s.daily.hour) due.push({ kind: 'daily', anchor: addDays(startOfDay(now), -1) });
  // 周报在周一的设定时刻生成；周一没开机的话，本周内开机时补上
  const weekStart = startOfWeek(now);
  if (s.weekly.enabled && (now.getTime() - weekStart.getTime() >= DAY || now.getHours() >= s.weekly.hour))
    due.push({ kind: 'weekly', anchor: addDays(weekStart, -7) });
  for (const { kind, anchor } of due) {
    const exists = await db.query.reports.findFirst({
      where: and(eq(reports.kind, kind), eq(reports.periodStart, periodOf(kind, anchor).start)),
      columns: { id: true },
    });
    if (exists) continue;
    try {
      const r = await generateReport(kind, anchor, { notify: true });
      console.log(`[reports] 已生成 ${r.title}`);
    } catch (err) {
      console.warn(`[reports] 生成${kind === 'daily' ? '日报' : '周报'}失败：`, (err as Error).message);
    }
  }
}

export function startReports() {
  // 启动后稍等同步跑起来再检查
  setTimeout(() => void checkSchedule().catch(() => {}), 30_000);
  timer = setInterval(() => void checkSchedule().catch((err) => console.warn('[reports]', err)), 60_000);
}

export function stopReports() {
  if (timer) clearInterval(timer);
  timer = null;
}
