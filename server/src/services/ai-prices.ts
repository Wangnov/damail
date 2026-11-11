import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { aiRequests } from '../db/schema.js';
import { channelPrice, getAiSettings, type ModelPrice } from './ai.js';
import { L } from '../i18n/index.js';

// LiteLLM 格式的价格表（键是模型名，单价是美元 / token），可以用环境变量换成别的源
const PRICE_URL = process.env.AI_PRICE_URL || 'https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.json';
const TTL = 6 * 3600_000;

type Entry = { input_cost_per_token?: number; output_cost_per_token?: number; cache_read_input_token_cost?: number; cache_creation_input_token_cost?: number };

let cache: { at: number; table: Record<string, Entry> } | null = null;

async function loadTable() {
  if (cache && Date.now() - cache.at < TTL) return cache.table;
  let res: Response;
  try {
    res = await fetch(PRICE_URL, { signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new Error(L(`无法获取价格表：${(err as Error).message}`, `Could not fetch the price list: ${(err as Error).message}`));
  }
  if (!res.ok) throw new Error(L(`获取价格表失败 ${res.status}`, `Failed to fetch the price list (${res.status})`));
  const table = (await res.json()) as Record<string, Entry>;
  if (!table || typeof table !== 'object') throw new Error(L('价格表格式不对', 'Invalid price list format'));
  cache = { at: Date.now(), table };
  return table;
}

// 美元 / token 换成美元 / 百万 tokens，去掉浮点误差
const perMillion = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Number((v * 1e6).toPrecision(6)) : null);

/** 依次尝试：原名、去掉 models/ 或厂商前缀、去掉日期后缀 */
function lookup(table: Record<string, Entry>, model: string) {
  const base = model.replace(/^models\//, '').replace(/^[\w-]+\//, '');
  for (const k of [model, base, base.replace(/-\d{8}$|-\d{4}-\d{2}-\d{2}$/, '')]) {
    const e = table[k] ?? table[k.toLowerCase()];
    if (e && typeof e.input_cost_per_token === 'number' && typeof e.output_cost_per_token === 'number') return e;
  }
  return null;
}

/** 从公开价格表查一批模型的参考单价，查不到的不返回 */
export async function referencePrices(models: string[]) {
  const table = await loadTable();
  const prices: Record<string, ModelPrice> = {};
  for (const m of models) {
    const e = lookup(table, m);
    if (!e) continue;
    prices[m] = {
      input: perMillion(e.input_cost_per_token)!,
      output: perMillion(e.output_cost_per_token)!,
      cacheRead: perMillion(e.cache_read_input_token_cost),
      cacheWrite: perMillion(e.cache_creation_input_token_cost),
    };
  }
  return { prices, source: PRICE_URL };
}

/** 用渠道里当前的价格给还没有费用的请求补算费用，返回补算的条数 */
export async function recostAiRequests() {
  const s = await getAiSettings();
  let updated = 0;
  for (const ch of s.channels) {
    for (const model of Object.keys(ch.prices)) {
      const p = channelPrice(ch, model);
      if (!p) continue;
      const read = sql`coalesce(${aiRequests.cacheReadTokens}, 0)`;
      const write = sql`coalesce(${aiRequests.cacheWriteTokens}, 0)`;
      const cost = sql`(greatest(${aiRequests.inputTokens} - ${read} - ${write}, 0) * ${p.input}::float8
        + ${read} * ${p.cacheRead ?? p.input}::float8 + ${write} * ${p.cacheWrite ?? p.input}::float8
        + ${aiRequests.outputTokens} * ${p.output}::float8) / 1e6`;
      const rows = await db
        .update(aiRequests)
        .set({ cost })
        .where(
          and(
            eq(aiRequests.channelId, ch.id),
            eq(aiRequests.model, model),
            isNull(aiRequests.cost),
            isNotNull(aiRequests.inputTokens),
            isNotNull(aiRequests.outputTokens),
          ),
        )
        .returning({ id: aiRequests.id });
      updated += rows.length;
    }
  }
  return updated;
}
