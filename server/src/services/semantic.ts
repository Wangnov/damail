import { z } from 'zod';
import { db } from '../db/index.js';
import { intlLocale, L } from '../i18n/index.js';
import { prompt } from './catalog.js';
import { CATEGORIES, generateJson, getAiConfig } from './ai.js';
import { searchCandidates, type Scope, type SearchCandidate } from './mail.js';
import { TZ } from './reports.js';

/**
 * 语义搜索：用户用自然语言描述想找的邮件，模型先把它拆成过滤条件和几组同义关键词（中英文、简称都覆盖），
 * 用现有索引召回候选，再让模型按摘要挑出真正相关的几封并说明理由。
 * 不依赖向量库和 Embeddings 接口，任何能对话的模型都能用。
 */

const PlanSchema = z.object({
  intent: z.string().catch(''),
  filters: z.string().catch(''),
  keywords: z.array(z.array(z.string())).catch([]),
});

const PLAN_SHAPE = `{"intent": "一句话复述用户要找什么", "filters": "搜索语法写的过滤条件，没有就留空", "keywords": [["同义词1", "同义词2"], ["另一组"]]}`;

function planSystem(accounts: Array<{ name: string; email: string }>) {
  const now = new Date();
  return prompt('search.plan', {
    today: new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(now),
    weekday: new Intl.DateTimeFormat(intlLocale(), { timeZone: TZ, weekday: 'long' }).format(now),
    tz: TZ,
    categories: CATEGORIES.join('|'),
    accounts: accounts.map((a) => `${a.name} <${a.email}>`).join(L('，', ', ')) || L('无', 'none'),
  });
}

const RankSchema = z.object({
  results: z.array(z.object({ id: z.number().int(), reason: z.string().catch('') })).catch([]),
});

const RANK_SHAPE = `{"results": [{"id": 123, "reason": "为什么相关，一句话"}]}`;

const rankSystem = () => prompt('search.rank');

export type SemanticResult = SearchCandidate & { reason: string };

export async function semanticSearch(scope: Scope, query: string, opts: { limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const config = await getAiConfig();
  const accounts = (await db.query.accounts.findMany({ columns: { id: true, name: true, email: true } })).filter(
    (a) => !scope.accountIds || scope.accountIds.includes(a.id),
  );

  const plan = await generateJson(planSystem(accounts), query, PlanSchema, { purpose: 'search', shape: PLAN_SHAPE, effort: 'low', maxTokens: 2048, config });
  const filters = sanitizeFilters(plan.filters);
  const groups = plan.keywords
    .map((g) => [...new Set(g.map((t) => t.trim()).filter((t) => t.length >= 2 && t.length <= 40))].slice(0, 8))
    .filter((g) => g.length)
    .slice(0, 4);

  // 召回：过滤条件 + 关键词；太少时依次放宽
  let candidates = await searchCandidates(scope, filters, groups, 150);
  let relaxed: 'none' | 'keywords' | 'filters' = 'none';
  if (candidates.length < 3 && groups.length && filters) {
    candidates = await searchCandidates(scope, filters, [], 150);
    relaxed = 'keywords';
  }
  if (candidates.length < 3 && groups.length) {
    candidates = await searchCandidates(scope, '', groups, 150);
    relaxed = 'filters';
  }

  // 同一会话只留一封（多个文件夹里的副本、同一会话的多封）
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const key = `${c.accountId}:${c.threadId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const pool = unique.slice(0, 60);
  let items: SemanticResult[] = [];
  if (pool.length) {
    const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ });
    const list = pool
      .map((c) =>
        JSON.stringify({
          id: c.id,
          date: fmt.format(c.date),
          from: c.fromName ? `${c.fromName} <${c.fromAddress ?? ''}>` : (c.fromAddress ?? ''),
          subject: c.subject.slice(0, 160),
          summary: (c.summary || c.snippet).slice(0, 200),
        }),
      )
      .join('\n');
    const ranked = await generateJson(rankSystem(), `用户要找：${query}\n\n候选邮件（每行一个 JSON）：\n${list}`, RankSchema, {
      purpose: 'search',
      shape: RANK_SHAPE,
      effort: 'low',
      maxTokens: 4096,
      config,
    });
    const byId = new Map(pool.map((c) => [c.id, c]));
    const used = new Set<number>();
    for (const r of ranked.results) {
      const c = byId.get(r.id);
      if (!c || used.has(r.id)) continue;
      used.add(r.id);
      items.push({ ...c, reason: r.reason.slice(0, 120) });
      if (items.length >= limit) break;
    }
  }
  items = items.slice(0, limit);

  return { intent: plan.intent, filters, keywords: groups, relaxed, candidates: unique.length, items };
}

/** 只保留认得的语法，防止模型把自然语言塞进 filters 变成必须命中的关键词 */
function sanitizeFilters(raw: string) {
  const allowed = /^-?(from|to|subject|account|folder|after|before|has|is|category|priority):\S+$/i;
  const tokens = raw.match(/\S+:"[^"]*"|\S+/g) ?? [];
  const kept = tokens.filter((t) => allowed.test(t) || /^(from|to|subject|account):"[^"]+"$/i.test(t));
  // 解析不出的日期等由解析器自行忽略
  return kept.join(' ');
}
