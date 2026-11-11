import { desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { actorOf, requireAuth, requireScope, requireSession, type AppEnv } from '../auth/index.js';
import { db } from '../db/index.js';
import { aiRequests, channels, jobs, rules, type Channel } from '../db/schema.js';
import { L, t } from '../i18n/index.js';
import { audit } from '../lib/audit.js';
import { ActionError } from '../services/actions.js';
import {
  CATEGORIES,
  categoryLabel,
  channelPrice,
  EFFORTS,
  fetchUpstreamModels,
  getAiConfig,
  getAiSettings,
  publicAiSettings,
  saveAiSettings,
  saveAnalysisSettings,
  testAiConfig,
} from '../services/ai.js';
import { aiChannelStatus } from '../services/ai-limit.js';
import { recostAiRequests, referencePrices } from '../services/ai-prices.js';
import { AI_PURPOSES, AI_STATS_RANGES, getAiStats, listAiRequests, type AiStatsRange } from '../services/ai-usage.js';
import { addIgnored, listContacts, listIgnored, removeIgnored, setContactAlias } from '../services/contacts.js';
import {
  CHANNEL_TYPES,
  EVENT_NAMES,
  eventLabels,
  encryptChannelConfig,
  maskedConfig,
  parseChannelConfig,
  readChannelConfig,
  sendToChannel,
} from '../services/notify.js';
import { analysisStatus, backfillInsights } from '../services/pipeline.js';
import { assertRuleScope, createRule, deleteRule, getVisibleRule, listRules, ruleInput, ruleVisible, testRule, updateRule } from '../services/rules.js';

const price = z.number().min(0).max(100_000);

const aiChannelInput = z.object({
  id: z.string().trim().min(1).max(64),
  name: z
    .string()
    .trim()
    .min(1, { error: () => L('请填写渠道名称', 'Enter a channel name') })
    .max(100),
  provider: z.enum(['anthropic', 'openai']),
  baseUrl: z
    .url({ error: () => L('Base URL 格式不正确', 'Invalid base URL') })
    .nullish()
    .or(z.literal('').transform(() => null))
    .transform((v) => v ?? null),
  // 不传表示保留原来的 Key，传空串表示清除
  apiKey: z.string().trim().optional(),
  models: z.array(z.string().trim().min(1).max(200)).max(2000).default([]),
  modelsSyncedAt: z.iso
    .datetime()
    .nullish()
    .transform((v) => v ?? null),
  // 美元 / 百万 tokens
  prices: z.record(z.string().max(200), z.object({ input: price, output: price, cacheRead: price.nullish(), cacheWrite: price.nullish() })).default({}),
  priceRate: z.number().min(0).max(100).default(1),
  // 并发上限，不填表示不限制
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(100)
    .nullish()
    .transform((v) => v ?? null),
});

const aiInput = z.object({
  enabled: z.boolean(),
  channels: z.array(aiChannelInput).max(50),
  channelId: z.string(),
  model: z
    .string()
    .trim()
    .min(1, { error: () => L('请选择默认模型', 'Choose a default model') })
    .max(200),
  effort: z.enum(EFFORTS),
  assistantChannelId: z.string().nullish(),
  assistantModel: z.string().trim().max(200).nullish(),
  assistantEffort: z.enum(EFFORTS).nullish(),
  translateChannelId: z.string().nullish(),
  translateModel: z.string().trim().max(200).nullish(),
  translateLanguage: z.string().trim().max(50).default(''),
});

const analysisInput = z.object({ enabled: z.boolean(), accountIds: z.array(z.number().int()).max(1000).nullish() });

/** 记录里存的是调用时的渠道名，渠道还在时显示现在的名字，删掉的渠道才用记录里的 */
async function channelNames() {
  return new Map((await getAiSettings()).channels.map((ch) => [ch.id, ch.name]));
}

/** 表单里尚未保存的渠道：没填 Key 时用同 id 已保存渠道的 Key */
async function draftChannel(input: z.infer<typeof aiChannelInput>) {
  const saved = (await getAiSettings()).channels.find((ch) => ch.id === input.id);
  return { ...input, apiKey: input.apiKey || (input.apiKey === '' ? null : (saved?.apiKey ?? null)) };
}

const channelInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: () => L('请填写渠道名称', 'Enter a channel name') })
    .max(100),
  type: z.enum(CHANNEL_TYPES as [string, ...string[]]),
  config: z.record(z.string(), z.unknown()),
  events: z.array(z.enum(EVENT_NAMES as [string, ...string[]])).default([]),
  enabled: z.boolean().default(true),
});

function publicChannel(ch: Channel) {
  const { configEnc: _enc, ...rest } = ch;
  return { ...rest, config: maskedConfig(ch) };
}

/** 编辑时被遮盖的字段（含 …）表示保持原值 */
function mergeConfig(ch: Channel, input: Record<string, unknown>) {
  const old = readChannelConfig(ch);
  const masked = maskedConfig(ch);
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) merged[k] = v === masked[k] && k in old ? old[k] : v;
  return merged;
}

/** 模型配置和通知渠道里有密钥，只允许网页登录态管理 */
export const automationAdminRoutes = new Hono<AppEnv>()
  .use(requireSession())
  .get('/ai', async (c) =>
    c.json({
      ...publicAiSettings(await getAiSettings()),
      categories: CATEGORIES,
      categoryLabels: Object.fromEntries(CATEGORIES.map((k) => [k, categoryLabel(k)])),
    }),
  )
  .put('/ai', async (c) => {
    const body = aiInput.parse(await c.req.json());
    const ids = body.channels.map((ch) => ch.id);
    if (new Set(ids).size !== ids.length) throw new ActionError(L('渠道 id 重复', 'Duplicate channel id'), 400);
    if (body.channels.length && !ids.includes(body.channelId)) throw new ActionError(L('请选择默认渠道', 'Choose a default channel'), 400);
    if (body.enabled && !body.channels.length) throw new ActionError(L('请先添加一个模型渠道', 'Add a model channel first'), 400);
    const assistantChannelId = body.assistantChannelId && ids.includes(body.assistantChannelId) ? body.assistantChannelId : null;
    const translateChannelId = body.translateChannelId && ids.includes(body.translateChannelId) ? body.translateChannelId : null;
    const { analysisEnabled, accountIds } = await getAiSettings();
    const saved = await saveAiSettings({
      ...body,
      assistantChannelId,
      assistantModel: body.assistantModel || null,
      assistantEffort: body.assistantEffort ?? null,
      translateChannelId,
      translateModel: body.translateModel || null,
      analysisEnabled,
      accountIds,
    });
    const pub = publicAiSettings(saved);
    audit(actorOf(c.var.auth), 'settings.ai', { detail: { ...pub, channels: pub.channels.map(({ apiKeyHint: _h, ...ch }) => ch) } });
    return c.json(pub);
  })
  .post('/ai/test', async (c) => {
    // 允许用表单里尚未保存的渠道测试
    const body = z
      .object({
        channel: aiChannelInput,
        model: z.string().trim().min(1, L('请先选择模型', 'Choose a model first')).max(200),
        effort: z.enum(EFFORTS).nullish(),
      })
      .parse(await c.req.json());
    const ch = await draftChannel(body.channel);
    if (!ch.apiKey) return c.json({ ok: false, error: L('请先填写 API Key', 'Enter the API key first') });
    try {
      return c.json({
        ok: true,
        ...(await testAiConfig({
          ...ch,
          channelId: ch.id,
          channelName: ch.name,
          enabled: true,
          model: body.model,
          effort: body.effort ?? 'low',
          analysisEnabled: true,
          accountIds: null,
          price: channelPrice(ch, body.model),
        })),
      });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message });
    }
  })
  // 各渠道的并发和限流状态（内存里的，重启后清零）
  .get('/ai/channels/status', (c) => c.json(aiChannelStatus()))
  .post('/ai/models/sync', async (c) => {
    // 用表单里的连接信息拉取上游模型列表，只返回不保存，由页面决定保留哪些
    const ch = await draftChannel(z.object({ channel: aiChannelInput }).parse(await c.req.json()).channel);
    if (ch.provider === 'anthropic' && !ch.apiKey) throw new ActionError(L('请先填写 API Key', 'Enter the API key first'), 400);
    try {
      return c.json({ models: await fetchUpstreamModels(ch), syncedAt: new Date().toISOString() });
    } catch (err) {
      throw new ActionError((err as Error).message, 400);
    }
  })
  .get('/ai/requests', async (c) => {
    const q = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
        purpose: z.enum(AI_PURPOSES).optional(),
        model: z.string().max(200).optional(),
        channelId: z.string().max(64).optional(),
        status: z.enum(['ok', 'error']).optional(),
      })
      .parse(c.req.query());
    const [list, models, names] = await Promise.all([
      listAiRequests(q, q.page, q.pageSize),
      db.selectDistinct({ model: aiRequests.model }).from(aiRequests).orderBy(aiRequests.model),
      channelNames(),
    ]);
    const items = list.items.map((r) => ({ ...r, channelName: (r.channelId && names.get(r.channelId)) || r.channelName }));
    return c.json({ ...list, items, models: models.map((m) => m.model) });
  })
  .post('/ai/requests/recost', async (c) => {
    const updated = await recostAiRequests();
    audit(actorOf(c.var.auth), 'settings.ai.recost', { detail: { updated } });
    return c.json({ updated });
  })
  .post('/ai/prices/reference', async (c) => {
    const { models } = z.object({ models: z.array(z.string().trim().min(1).max(200)).max(2000) }).parse(await c.req.json());
    try {
      return c.json(await referencePrices(models));
    } catch (err) {
      throw new ActionError((err as Error).message, 400);
    }
  })
  .get('/ai/stats', async (c) => {
    const days = Number(c.req.query('days') ?? 7);
    if (!AI_STATS_RANGES.includes(days as AiStatsRange)) throw new ActionError(L('days 只能是 1 / 7 / 30 / 90', 'days must be 1 / 7 / 30 / 90'), 400);
    const [stats, names] = await Promise.all([getAiStats(days as AiStatsRange), channelNames()]);
    return c.json({ ...stats, byChannel: stats.byChannel.map((r) => ({ ...r, name: (r.key && names.get(r.key)) || r.name })) });
  })
  .post('/ai/backfill', async (c) => {
    const { limit, accountIds } = z
      .object({ limit: z.number().int().min(1).max(1000).default(100), accountIds: z.array(z.number().int()).optional() })
      .parse(await c.req.json().catch(() => ({})));
    const cfg = await getAiConfig();
    if (!cfg.enabled || !cfg.apiKey) throw new ActionError(L('请先启用 AI 并保存 API Key', 'Enable AI and save an API key first'), 400);
    return c.json(await backfillInsights(limit, accountIds));
  })
  .get('/ai/analysis', async (c) => {
    const s = await getAiSettings();
    const def = s.channels.find((ch) => ch.id === s.channelId);
    return c.json({
      enabled: s.analysisEnabled,
      accountIds: s.accountIds,
      // 分析用的是默认模型，页面上显示并提示去哪里改
      ai: { enabled: s.enabled, hasApiKey: Boolean(def?.apiKey), model: s.model, channelName: def?.name ?? null },
      ...(await analysisStatus()),
    });
  })
  .put('/ai/analysis', async (c) => {
    const body = analysisInput.parse(await c.req.json());
    const saved = await saveAnalysisSettings({ analysisEnabled: body.enabled, accountIds: body.accountIds?.length ? body.accountIds : null });
    audit(actorOf(c.var.auth), 'settings.ai_analysis', { detail: { enabled: saved.analysisEnabled, accountIds: saved.accountIds } });
    return c.json({ enabled: saved.analysisEnabled, accountIds: saved.accountIds });
  })

  // 通讯录和忽略名单：名单里的发件人不做 AI 分析，也不算进日报和概览
  .get('/contacts', async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
    const s = c.req.query('sort');
    const sort = s === 'recent' || s === 'sent' ? s : 'count';
    return c.json(
      await listContacts(c.var.auth.scope, {
        q: c.req.query('q'),
        ignored: c.req.query('ignored') === '1',
        people: c.req.query('people') === '1',
        sort,
        limit,
        offset,
      }),
    );
  })
  .put('/contacts/:address/alias', async (c) => {
    const { alias } = z.object({ alias: z.string().max(100) }).parse(await c.req.json());
    return c.json(await setContactAlias(decodeURIComponent(c.req.param('address')), alias));
  })
  .get('/ignored-senders', async (c) => c.json(await listIgnored()))
  .post('/ignored-senders', async (c) => {
    const { pattern } = z.object({ pattern: z.string().max(320) }).parse(await c.req.json());
    const res = await addIgnored(pattern);
    audit(actorOf(c.var.auth), 'ignored_sender.add', { target: res.pattern, detail: { removedInsights: res.removedInsights } });
    return c.json(res);
  })
  .delete('/ignored-senders/:pattern', async (c) => {
    const res = await removeIgnored(c.req.param('pattern'));
    audit(actorOf(c.var.auth), 'ignored_sender.remove', { target: res.pattern });
    return c.json(res);
  })

  .get('/channels', async (c) => {
    const rows = await db.select().from(channels).orderBy(channels.id);
    return c.json({ items: rows.map(publicChannel), events: eventLabels(), types: CHANNEL_TYPES });
  })
  .post('/channels', async (c) => {
    const data = channelInput.parse(await c.req.json());
    const cfg = parseChannelConfig(data.type, data.config);
    const [row] = await db
      .insert(channels)
      .values({ name: data.name, type: data.type, configEnc: encryptChannelConfig(cfg), events: data.events, enabled: data.enabled })
      .returning();
    audit(actorOf(c.var.auth), 'channel.create', { target: `channel:${row!.id}` });
    return c.json(publicChannel(row!), 201);
  })
  .patch('/channels/:id', async (c) => {
    const ch = await db.query.channels.findFirst({ where: eq(channels.id, Number(c.req.param('id'))) });
    if (!ch) return c.json({ error: L('渠道不存在', 'Channel not found') }, 404);
    const data = channelInput.partial().parse(await c.req.json());
    const patch: Partial<typeof channels.$inferInsert> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.events !== undefined) patch.events = data.events;
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    if (data.config) patch.configEnc = encryptChannelConfig(parseChannelConfig(ch.type, mergeConfig(ch, data.config)));
    const [row] = await db.update(channels).set(patch).where(eq(channels.id, ch.id)).returning();
    audit(actorOf(c.var.auth), 'channel.update', { target: `channel:${ch.id}` });
    return c.json(publicChannel(row!));
  })
  .delete('/channels/:id', async (c) => {
    const id = Number(c.req.param('id'));
    await db.delete(channels).where(eq(channels.id, id));
    audit(actorOf(c.var.auth), 'channel.delete', { target: `channel:${id}` });
    return c.json({ ok: true });
  })
  .post('/channels/test', async (c) => {
    // 测试未保存的配置；编辑已有渠道时被遮盖的字段沿用原值
    const body = await c.req.json();
    const existing = body.id ? await db.query.channels.findFirst({ where: eq(channels.id, Number(body.id)) }) : undefined;
    const type = existing?.type ?? String(body.type);
    const cfg = parseChannelConfig(type, existing && body.config ? mergeConfig(existing, body.config) : (body.config ?? {}));
    const ch = {
      ...(existing ?? { id: 0, name: 'test', events: [], enabled: true, createdAt: new Date() }),
      type,
      configEnc: encryptChannelConfig(cfg),
    } as Channel;
    try {
      await sendToChannel(ch, {
        event: 'test',
        title: L('DaMail 测试通知', 'DaMail test notification'),
        body: L(
          `如果你看到这条消息，说明「${body.name || ch.name}」配置正确。\n验证码示例：123456`,
          `If you can see this message, "${body.name || ch.name}" is set up correctly.\nSample verification code: 123456`,
        ),
        copy: '123456',
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message });
    }
  })
  .get('/channels/:id/deliveries', async (c) => {
    const rows = await db
      .select({
        id: jobs.id,
        status: jobs.status,
        attempts: jobs.attempts,
        error: jobs.error,
        createdAt: jobs.createdAt,
        finishedAt: jobs.finishedAt,
        event: sql<string>`${jobs.payload}->'notice'->>'event'`,
        title: sql<string>`${jobs.payload}->'notice'->>'title'`,
      })
      .from(jobs)
      .where(sql`${jobs.type} = 'notify' AND (${jobs.payload}->>'channelId')::int = ${Number(c.req.param('id'))}`)
      .orderBy(desc(jobs.id))
      .limit(30);
    return c.json(rows);
  });

export const rulesRoutes = new Hono<AppEnv>()
  .use(requireAuth('read'), requireScope('automation'))
  .get('/', async (c) => c.json((await listRules()).filter((r) => ruleVisible(c.var.auth.scope, r))))
  .post('/', async (c) => {
    const data = ruleInput.parse(await c.req.json());
    assertRuleScope(c.var.auth.scope, data.accountIds);
    const row = await createRule(data);
    audit(actorOf(c.var.auth), 'rule.create', { target: `rule:${row.id}`, detail: { name: row.name } });
    return c.json(row, 201);
  })
  .post('/test', async (c) => {
    const body = await c.req.json();
    const data = ruleInput.parse(body);
    assertRuleScope(c.var.auth.scope, data.accountIds);
    return c.json(await testRule(data, Number(body.limit) || 200));
  })
  .post('/reorder', async (c) => {
    const { ids } = z.object({ ids: z.array(z.number().int()) }).parse(await c.req.json());
    const visible = new Set((await listRules()).filter((r) => ruleVisible(c.var.auth.scope, r)).map((r) => r.id));
    await db.transaction(async (tx) => {
      for (const [i, id] of ids.entries())
        if (visible.has(id))
          await tx
            .update(rules)
            .set({ position: i + 1 })
            .where(eq(rules.id, id));
    });
    return c.json((await listRules()).filter((r) => ruleVisible(c.var.auth.scope, r)));
  })
  .get('/:id', async (c) => c.json(await getVisibleRule(c.var.auth.scope, Number(c.req.param('id')))))
  .patch('/:id', async (c) => {
    const rule = await getVisibleRule(c.var.auth.scope, Number(c.req.param('id')));
    const body = await c.req.json();
    if ('accountIds' in body) assertRuleScope(c.var.auth.scope, body.accountIds);
    const row = await updateRule(rule.id, body);
    audit(actorOf(c.var.auth), 'rule.update', { target: `rule:${rule.id}` });
    return c.json(row);
  })
  .delete('/:id', async (c) => {
    const rule = await getVisibleRule(c.var.auth.scope, Number(c.req.param('id')));
    await deleteRule(rule.id);
    audit(actorOf(c.var.auth), 'rule.delete', { target: `rule:${rule.id}`, detail: { name: rule.name } });
    return c.json({ ok: true });
  });

/** 给 Agent / 规则编辑器用的渠道列表，不含任何配置 */
export const channelListRoutes = new Hono<AppEnv>().use(requireAuth('read'), requireScope('automation')).get('/', async (c) => {
  const rows = await db.select({ id: channels.id, name: channels.name, type: channels.type, enabled: channels.enabled }).from(channels).orderBy(channels.id);
  return c.json(rows);
});
