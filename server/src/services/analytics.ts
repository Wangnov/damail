import { sql } from 'drizzle-orm';
import { categoryLabel } from './ai.js';
import { TZ, addDays, receivedCte, rows, sentCte, startOfDay, startOfWeek } from './reports.js';

/**
 * 分析看板：最近 N 天的收发趋势、时段分布、分类、发件人和积压情况。
 * 口径与日报 / 周报一致（同一封邮件在多个文件夹只算一次，不含自己发的）。
 */

export const ANALYTICS_RANGES = [7, 30, 90, 365] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export async function getAnalytics(days: AnalyticsRange) {
  const until = new Date();
  const start = addDays(startOfDay(until), -(days - 1));
  const prevStart = addDays(start, -days);
  // 一年的范围按周汇总，否则柱子太密
  const bucket = days > 90 ? 'week' : 'day';
  const recv = receivedCte(start, until);
  const sent = sentCte(start, until);

  const [totals] = await rows<{ received: string; senders: string; analyzed: string; needs_reply: string; replied: string }>(sql`
    WITH ${recv}
    SELECT count(*) AS received,
           count(DISTINCT lower(from_address)) AS senders,
           count(i.message_id) AS analyzed,
           count(*) FILTER (WHERE i.needs_reply) AS needs_reply,
           count(*) FILTER (WHERE i.needs_reply AND recv.answered) AS replied
    FROM recv LEFT JOIN message_insights i ON i.message_id = recv.id`);
  const [prev] = await rows<{ n: string }>(sql`WITH ${receivedCte(prevStart, start)} SELECT count(*) AS n FROM recv`);
  const [sentTotal] = await rows<{ n: string }>(sql`WITH ${sent} SELECT count(*) AS n FROM sent`);
  const [sentPrev] = await rows<{ n: string }>(sql`WITH ${sentCte(prevStart, start)} SELECT count(*) AS n FROM sent`);

  const trunc = (col: ReturnType<typeof sql>) =>
    bucket === 'week' ? sql`to_char(date_trunc('week', ${col} AT TIME ZONE ${TZ}), 'YYYY-MM-DD')` : sql`to_char(${col} AT TIME ZONE ${TZ}, 'YYYY-MM-DD')`;
  const recvSeries = await rows<{ d: string; n: string }>(sql`WITH ${recv} SELECT ${trunc(sql`date`)} AS d, count(*) AS n FROM recv GROUP BY 1`);
  const sentSeries = await rows<{ d: string; n: string }>(sql`WITH ${sent} SELECT ${trunc(sql`date`)} AS d, count(*) AS n FROM sent GROUP BY 1`);

  // 星期（0=周日）× 小时
  const heat = await rows<{ dow: number; h: number; n: string }>(sql`
    WITH ${recv}
    SELECT extract(dow FROM date AT TIME ZONE ${TZ})::int AS dow, extract(hour FROM date AT TIME ZONE ${TZ})::int AS h, count(*) AS n
    FROM recv GROUP BY 1, 2`);

  const categories = await rows<{ category: string | null; n: string; unread: string }>(sql`
    WITH ${recv}
    SELECT i.category, count(*) AS n, count(*) FILTER (WHERE NOT m.seen) AS unread
    FROM recv JOIN messages m ON m.id = recv.id LEFT JOIN message_insights i ON i.message_id = recv.id
    GROUP BY i.category ORDER BY count(*) DESC`);

  const senders = await rows<{ address: string; name: string | null; n: string; unread: string; last: Date }>(sql`
    WITH ${recv}
    SELECT lower(recv.from_address) AS address, max(recv.from_name) AS name, count(*) AS n,
           count(*) FILTER (WHERE NOT m.seen) AS unread, max(recv.date) AS last
    FROM recv JOIN messages m ON m.id = recv.id WHERE recv.from_address IS NOT NULL
    GROUP BY lower(recv.from_address) ORDER BY count(*) DESC, max(recv.date) DESC LIMIT 10`);

  const domains = await rows<{ domain: string; n: string }>(sql`
    WITH ${recv}
    SELECT lower(split_part(from_address, '@', 2)) AS domain, count(*) AS n
    FROM recv WHERE from_address LIKE '%@%'
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 8`);

  const accounts = await rows<{ id: number; name: string; email: string; received: string; sent: string }>(sql`
    WITH ${recv}, ${sent}
    SELECT a.id, a.name, a.email,
           (SELECT count(*) FROM recv WHERE recv.account_id = a.id) AS received,
           (SELECT count(*) FROM sent WHERE sent.account_id = a.id) AS sent
    FROM accounts a ORDER BY 4 DESC, a.id`);

  // 收件箱未读积压按邮件年龄分段（不受时间范围影响）
  const [backlog] = await rows<{ d1: string; d7: string; d30: string; older: string }>(sql`
    SELECT count(*) FILTER (WHERE m.date >= now() - interval '1 day') AS d1,
           count(*) FILTER (WHERE m.date < now() - interval '1 day' AND m.date >= now() - interval '7 days') AS d7,
           count(*) FILTER (WHERE m.date < now() - interval '7 days' AND m.date >= now() - interval '30 days') AS d30,
           count(*) FILTER (WHERE m.date < now() - interval '30 days') AS older
    FROM messages m JOIN folders f ON f.id = m.folder_id
    WHERE NOT m.seen AND (f.special_use = '\\Inbox' OR upper(f.path) = 'INBOX')`);

  const recvMap = new Map(recvSeries.map((r) => [r.d, Number(r.n)]));
  const sentMap = new Map(sentSeries.map((r) => [r.d, Number(r.n)]));
  const series: Array<{ date: string; received: number; sent: number }> = [];
  for (let d = bucket === 'week' ? startOfWeek(start) : new Date(start); d < until; d = addDays(d, bucket === 'week' ? 7 : 1)) {
    const key = ymd(d);
    series.push({ date: key, received: recvMap.get(key) ?? 0, sent: sentMap.get(key) ?? 0 });
  }
  const heatmap = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const r of heat) heatmap[r.dow]![r.h] = Number(r.n);

  const label = (c: string | null) => categoryLabel(c);
  const received = Number(totals?.received ?? 0);
  return {
    days,
    start: start.toISOString(),
    until: until.toISOString(),
    bucket,
    totals: {
      received,
      receivedPrev: Number(prev?.n ?? 0),
      sent: Number(sentTotal?.n ?? 0),
      sentPrev: Number(sentPrev?.n ?? 0),
      senders: Number(totals?.senders ?? 0),
      analyzed: Number(totals?.analyzed ?? 0),
      needsReply: Number(totals?.needs_reply ?? 0),
      replied: Number(totals?.replied ?? 0),
    },
    series,
    heatmap,
    categories: categories.map((r) => ({ category: r.category ?? 'unanalyzed', label: label(r.category), count: Number(r.n), unread: Number(r.unread) })),
    senders: senders.map((r) => ({
      address: r.address,
      name: r.name || r.address,
      count: Number(r.n),
      unread: Number(r.unread),
      last: new Date(r.last).toISOString(),
    })),
    domains: domains.map((r) => ({ domain: r.domain, count: Number(r.n) })),
    accounts: accounts.map((r) => ({ accountId: r.id, name: r.name, email: r.email, received: Number(r.received), sent: Number(r.sent) })),
    backlog: { d1: Number(backlog?.d1 ?? 0), d7: Number(backlog?.d7 ?? 0), d30: Number(backlog?.d30 ?? 0), older: Number(backlog?.older ?? 0) },
  };
}

export type Analytics = Awaited<ReturnType<typeof getAnalytics>>;
