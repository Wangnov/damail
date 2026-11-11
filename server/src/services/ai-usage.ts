import { and, count, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { aiRequests } from '../db/schema.js';
import { acquireAiSlot, noteAiSuccess, noteRateLimited, RateLimitError } from './ai-limit.js';
import type { AiConfig, ModelPrice } from './ai.js';
import { TZ, addDays, rows, startOfDay } from './reports.js';

export const AI_PURPOSES = ['classify', 'reply', 'report', 'search', 'title', 'assistant', 'translate', 'labels', 'test'] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

export type AiUsage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };

type CallInfo = Pick<AiConfig, 'channelId' | 'channelName' | 'provider' | 'model' | 'price'> & { concurrency?: number | null };

// 记录保留 180 天，写入时偶尔顺手清理
const RETENTION_DAYS = 180;

/** 按单价算费用：输入里缓存命中和缓存写入的部分按各自单价，没设缓存单价时按输入单价 */
export function costOf(price: ModelPrice | null | undefined, u: AiUsage | undefined): number | null {
  if (!price || u?.inputTokens === undefined || u.outputTokens === undefined) return null;
  const read = u.cacheReadTokens ?? 0;
  const write = u.cacheWriteTokens ?? 0;
  const plain = Math.max(0, u.inputTokens - read - write);
  return (plain * price.input + read * (price.cacheRead ?? price.input) + write * (price.cacheWrite ?? price.input) + u.outputTokens * price.output) / 1e6;
}

/** 记一次模型调用；写库失败不影响业务 */
export function recordAiRequest(c: CallInfo, purpose: AiPurpose, r: { started: number; error?: string | null; usage?: AiUsage }) {
  db.insert(aiRequests)
    .values({
      purpose,
      channelId: c.channelId,
      channelName: c.channelName,
      provider: c.provider,
      model: c.model,
      ok: !r.error,
      error: r.error ? r.error.slice(0, 1000) : null,
      durationMs: Date.now() - r.started,
      inputTokens: r.usage?.inputTokens ?? null,
      outputTokens: r.usage?.outputTokens ?? null,
      cacheReadTokens: r.usage?.cacheReadTokens ?? null,
      cacheWriteTokens: r.usage?.cacheWriteTokens ?? null,
      cost: costOf(c.price, r.usage),
    })
    .then(() => {
      if (Math.random() < 0.01) return db.delete(aiRequests).where(lt(aiRequests.createdAt, addDays(new Date(), -RETENTION_DAYS)));
    })
    .catch((err) => console.error('[ai-usage] 记录失败', err));
}

// 被限流时，等渠道暂停结束后再试几次
const RATE_LIMIT_RETRIES = 2;

/**
 * 包一层调用：run 里把接口返回的用量写进 usage，成功失败都会记一条。
 * 按渠道的并发上限排队；被限流（429）时暂停整个渠道，等暂停结束后自动重试。
 */
export async function trackAi<T>(c: CallInfo, purpose: AiPurpose, run: (usage: AiUsage) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const release = await acquireAiSlot(c);
    const started = Date.now();
    const usage: AiUsage = {};
    try {
      const out = await run(usage);
      noteAiSuccess(c.channelId);
      recordAiRequest(c, purpose, { started, usage });
      return out;
    } catch (err) {
      recordAiRequest(c, purpose, { started, usage, error: (err as Error).message || String(err) });
      if (!(err instanceof RateLimitError)) throw err;
      noteRateLimited(c.channelId, err.retryAfterMs);
      if (attempt >= RATE_LIMIT_RETRIES) throw err;
    } finally {
      release();
    }
  }
}

type AnthropicUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
type OpenAIUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null };

/** Anthropic 的 input_tokens 不含缓存部分，这里统一成总输入 */
export function setAnthropicUsage(into: AiUsage, u: AnthropicUsage | null | undefined) {
  if (!u) return;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  into.inputTokens = u.input_tokens + read + write;
  into.outputTokens = u.output_tokens;
  into.cacheReadTokens = read;
  into.cacheWriteTokens = write;
}

export function setOpenAIUsage(into: AiUsage, u: OpenAIUsage | null | undefined) {
  if (!u) return;
  if (typeof u.prompt_tokens === 'number') into.inputTokens = u.prompt_tokens;
  if (typeof u.completion_tokens === 'number') into.outputTokens = u.completion_tokens;
  if (typeof u.prompt_tokens_details?.cached_tokens === 'number') into.cacheReadTokens = u.prompt_tokens_details.cached_tokens;
}

export type AiRequestFilter = { purpose?: AiPurpose; model?: string; channelId?: string; status?: 'ok' | 'error' };

export async function listAiRequests(f: AiRequestFilter, page: number, pageSize: number) {
  const where: SQL[] = [];
  if (f.purpose) where.push(eq(aiRequests.purpose, f.purpose));
  if (f.model) where.push(eq(aiRequests.model, f.model));
  if (f.channelId) where.push(eq(aiRequests.channelId, f.channelId));
  if (f.status) where.push(eq(aiRequests.ok, f.status === 'ok'));
  const cond = where.length ? and(...where) : undefined;
  const [items, [total]] = await Promise.all([
    db
      .select()
      .from(aiRequests)
      .where(cond)
      .orderBy(desc(aiRequests.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(aiRequests).where(cond),
  ]);
  return { items, total: total?.n ?? 0 };
}

export const AI_STATS_RANGES = [1, 7, 30, 90] as const;
export type AiStatsRange = (typeof AI_STATS_RANGES)[number];

type Agg = {
  requests: string;
  errors: string;
  input: string | null;
  output: string | null;
  cache: string | null;
  avg_ms: string | null;
  cost: number | string | null;
  unpriced: string;
};

const AGG = sql`count(*) AS requests, count(*) FILTER (WHERE NOT ok) AS errors,
  sum(input_tokens) AS input, sum(output_tokens) AS output, sum(cache_read_tokens) AS cache, avg(duration_ms) AS avg_ms,
  sum(cost) AS cost, count(*) FILTER (WHERE cost IS NULL AND input_tokens IS NOT NULL) AS unpriced`;

const num = (v: number | string | null | undefined) => Number(v ?? 0);
const agg = (r: Agg | undefined) => ({
  requests: num(r?.requests),
  errors: num(r?.errors),
  inputTokens: num(r?.input),
  outputTokens: num(r?.output),
  cacheReadTokens: num(r?.cache),
  avgMs: Math.round(num(r?.avg_ms)),
  cost: num(r?.cost),
  // 有用量但没有价格、没算进费用的请求数
  unpriced: num(r?.unpriced),
});

/** 最近 N 天的用量：总数、和上一周期对比、按天 / 按小时趋势、按模型 / 用途 / 渠道汇总 */
export async function getAiStats(days: AiStatsRange) {
  const until = new Date();
  // 1 天看最近 24 小时，按小时汇总
  const hourly = days === 1;
  const start = hourly ? new Date(until.getTime() - 24 * 3600_000) : addDays(startOfDay(until), -(days - 1));
  const prevStart = new Date(start.getTime() - (until.getTime() - start.getTime()));
  const range = and(gte(aiRequests.createdAt, start), lt(aiRequests.createdAt, until));
  const bucket = hourly
    ? sql`to_char(date_trunc('hour', created_at AT TIME ZONE ${TZ}), 'YYYY-MM-DD"T"HH24')`
    : sql`to_char(created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD')`;

  const [totals, prev, series, byModel, byPurpose, byChannel] = await Promise.all([
    rows<Agg>(sql`SELECT ${AGG} FROM ai_requests WHERE ${range}`),
    rows<Agg>(sql`SELECT ${AGG} FROM ai_requests WHERE created_at >= ${prevStart} AND created_at < ${start}`),
    rows<Agg & { k: string }>(sql`SELECT ${bucket} AS k, ${AGG} FROM ai_requests WHERE ${range} GROUP BY 1`),
    rows<Agg & { k: string }>(sql`SELECT model AS k, ${AGG} FROM ai_requests WHERE ${range} GROUP BY 1 ORDER BY count(*) DESC`),
    rows<Agg & { k: string }>(sql`SELECT purpose AS k, ${AGG} FROM ai_requests WHERE ${range} GROUP BY 1 ORDER BY count(*) DESC`),
    rows<Agg & { k: string | null; name: string | null }>(
      sql`SELECT channel_id AS k, max(channel_name) AS name, ${AGG} FROM ai_requests WHERE ${range} GROUP BY 1 ORDER BY count(*) DESC`,
    ),
  ]);

  // 没有调用的时段也补上 0，图表才是连续的
  const byKey = new Map(series.map((r) => [r.k, agg(r)]));
  const keys: string[] = [];
  if (hourly) {
    const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
    for (let i = 23; i >= 0; i--) keys.push(fmt.format(new Date(until.getTime() - i * 3600_000)).replace(' ', 'T'));
  } else {
    const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    for (let i = 0; i < days; i++) keys.push(fmt.format(addDays(start, i)));
  }

  return {
    days,
    bucket: hourly ? ('hour' as const) : ('day' as const),
    start: start.toISOString(),
    totals: agg(totals[0]),
    prev: agg(prev[0]),
    series: keys.map((k) => ({ key: k, ...(byKey.get(k) ?? agg(undefined)) })),
    byModel: byModel.map((r) => ({ key: r.k, ...agg(r) })),
    byPurpose: byPurpose.map((r) => ({ key: r.k, ...agg(r) })),
    byChannel: byChannel.map((r) => ({ key: r.k, name: r.name, ...agg(r) })),
  };
}
