import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { accounts, settings, type Extracted, type Message } from '../db/schema.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { setAnthropicUsage, setOpenAIUsage, trackAi, type AiPurpose } from './ai-usage.js';
import { RetryableError } from './jobs.js';
import { parseRetryAfter, RateLimitError } from './ai-limit.js';
import { getSystemLocale, L, t } from '../i18n/index.js';
import { CATEGORIES, categoryLines, categoryName, prompt } from './catalog.js';

export { CATEGORIES } from './catalog.js';

/** 分类的名字（按当前语言，来自 categories 表）；没有分析过的显示「未分析」 */
export const categoryLabel = (c: string | null | undefined) => (c ? categoryName(c) : t().ai.unanalyzed);

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export type AiProvider = 'anthropic' | 'openai';

/** 模型单价，美元 / 百万 tokens；缓存单价为空时按输入单价算 */
export type ModelPrice = { input: number; output: number; cacheRead?: number | null; cacheWrite?: number | null };

/** 一个模型服务渠道：服务商 + 接口地址 + Key + 这个渠道上可用的模型 */
export type AiChannel = {
  id: string;
  name: string;
  provider: AiProvider;
  baseUrl: string | null;
  apiKey: string | null;
  // 可选的模型列表，来自上游同步或手动添加
  models: string[];
  modelsSyncedAt: string | null;
  // 按模型名的单价；倍率用于中转站按官方价打折 / 加价的情况
  prices: Record<string, ModelPrice>;
  priceRate: number;
  // 同时进行的请求上限，null 表示不限制（中转站账号少时容易被限流）
  concurrency: number | null;
};

export type AiSettings = {
  enabled: boolean;
  channels: AiChannel[];
  // 默认渠道和模型：邮件分析、日报摘要、语义搜索都用它
  channelId: string;
  model: string;
  effort: Effort;
  // AI 助手单独的渠道、模型和思考强度，null 表示跟随默认 / 服务商默认
  assistantChannelId: string | null;
  assistantModel: string | null;
  assistantEffort: Effort | null;
  // 一键翻译的渠道和模型，null 表示跟随默认；目标语言是给模型看的语言名
  translateChannelId: string | null;
  translateModel: string | null;
  translateLanguage: string;
  // 新邮件自动分析：开关和范围（null 表示所有账户），在「邮件分析」页单独保存
  analysisEnabled: boolean;
  accountIds: number[] | null;
};

/** 解析好渠道后实际调用用的配置 */
export type AiConfig = {
  enabled: boolean;
  channelId: string | null;
  channelName: string | null;
  provider: AiProvider;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  effort: Effort;
  analysisEnabled: boolean;
  accountIds: number[] | null;
  // 当前模型的单价（已乘倍率），用于记录费用
  price: ModelPrice | null;
  // 渠道的并发上限
  concurrency: number | null;
};

const DEFAULT_SETTINGS: AiSettings = {
  enabled: false,
  channels: [],
  channelId: '',
  model: 'claude-opus-5-5',
  effort: 'low',
  assistantChannelId: null,
  assistantModel: null,
  assistantEffort: null,
  translateChannelId: null,
  translateModel: null,
  // 新装时按系统语言给默认值（见 getAiSettings）
  translateLanguage: '',
  // 早期版本启用 AI 就会分析新邮件，没存过这个字段时保持开启
  analysisEnabled: true,
  accountIds: null,
};

// 早期的渠道没有价格字段
type StoredChannel = Omit<AiChannel, 'apiKey' | 'prices' | 'priceRate' | 'concurrency'> &
  Partial<Pick<AiChannel, 'prices' | 'priceRate' | 'concurrency'>> & { apiKeyEnc?: string };
// 旧版本只有一组连接信息，平铺在顶层
type LegacyFields = { provider?: AiProvider; baseUrl?: string | null; apiKeyEnc?: string; models?: string[]; modelsSyncedAt?: string | null };

let cached: AiSettings | null = null;

export async function getAiSettings(): Promise<AiSettings> {
  if (cached) return cached;
  const row = await db.query.settings.findFirst({ where: eq(settings.key, 'ai') });
  const { channels, provider, baseUrl, apiKeyEnc, models, modelsSyncedAt, ...v } = (row?.value ?? {}) as Partial<Omit<AiSettings, 'channels'>> &
    LegacyFields & { channels?: StoredChannel[] };
  let stored = channels;
  if (!stored && row) {
    stored = [
      {
        id: 'default',
        name: provider === 'openai' ? t().ai.openaiCompat : 'Anthropic',
        provider: provider ?? 'anthropic',
        baseUrl: baseUrl ?? null,
        models: models ?? [],
        modelsSyncedAt: modelsSyncedAt ?? null,
        apiKeyEnc,
      },
    ];
    v.channelId = 'default';
  }
  cached = {
    ...DEFAULT_SETTINGS,
    ...v,
    // 没选过目标语言时按系统语言（管理员的界面语言）
    translateLanguage: v.translateLanguage || t(getSystemLocale()).ai.defaultTranslateLanguage,
    channels: (stored ?? []).map(({ apiKeyEnc: enc, ...ch }) => ({
      ...ch,
      prices: ch.prices ?? {},
      priceRate: ch.priceRate ?? 1,
      concurrency: ch.concurrency ?? null,
      apiKey: enc ? decryptSecret(enc) : null,
    })),
  };
  return cached;
}

/** 渠道的 apiKey 传 undefined 表示保持不变（按 id 对应已保存的渠道），传空字符串表示清除 */
export async function saveAiSettings(
  next: Omit<AiSettings, 'channels'> & { channels: Array<Omit<AiChannel, 'apiKey' | 'concurrency'> & { apiKey?: string; concurrency?: number | null }> },
) {
  const current = await getAiSettings();
  const channels: StoredChannel[] = next.channels.map(({ apiKey, ...ch }) => {
    const key = apiKey === undefined ? (current.channels.find((c) => c.id === ch.id)?.apiKey ?? null) : apiKey || null;
    return { ...ch, ...(key ? { apiKeyEnc: encryptSecret(key) } : {}) };
  });
  const value = { ...next, channels };
  await db
    .insert(settings)
    .values({ key: 'ai', value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  cached = null;
  return getAiSettings();
}

/** 只改自动分析的开关和范围，渠道、模型和 Key 保持不变 */
export async function saveAnalysisSettings(next: Pick<AiSettings, 'analysisEnabled' | 'accountIds'>) {
  const cur = await getAiSettings();
  return saveAiSettings({ ...cur, ...next, channels: cur.channels.map(({ apiKey: _k, ...ch }) => ch) });
}

function resolve(s: AiSettings, channelId: string | null, model: string, effort: Effort): AiConfig {
  const ch = s.channels.find((c) => c.id === channelId) ?? s.channels.find((c) => c.id === s.channelId) ?? s.channels[0];
  return {
    enabled: s.enabled,
    channelId: ch?.id ?? null,
    channelName: ch?.name ?? null,
    provider: ch?.provider ?? 'anthropic',
    baseUrl: ch?.baseUrl ?? null,
    apiKey: ch?.apiKey ?? null,
    model,
    effort,
    analysisEnabled: s.analysisEnabled,
    accountIds: s.accountIds,
    price: ch ? channelPrice(ch, model) : null,
    concurrency: ch?.concurrency ?? null,
  };
}

/** 渠道里某个模型乘过倍率的单价 */
export function channelPrice(ch: Pick<AiChannel, 'prices' | 'priceRate'>, model: string): ModelPrice | null {
  const p = ch.prices[model];
  if (!p) return null;
  const r = ch.priceRate ?? 1;
  const scale = (v: number | null | undefined) => (v === null || v === undefined ? null : v * r);
  return { input: p.input * r, output: p.output * r, cacheRead: scale(p.cacheRead), cacheWrite: scale(p.cacheWrite) };
}

/** 默认渠道和模型的配置 */
export async function getAiConfig(): Promise<AiConfig> {
  const s = await getAiSettings();
  return resolve(s, s.channelId, s.model, s.effort);
}

export type AssistantOverride = { channelId?: string; model?: string; effort?: Effort };

/**
 * 助手用的配置：渠道、模型和思考强度可以单独设置；换了渠道又没选模型时用那个渠道的第一个模型。
 * override 是对话框里临时选的模型和思考强度，优先于设置。
 */
export async function getAssistantAiConfig(override: AssistantOverride = {}) {
  const s = await getAiSettings();
  if (override.model) {
    const picked = s.channels.find((c) => c.id === override.channelId);
    if (!picked) throw new AiError(t().ai.errors.channelMissing);
    return { ...resolve(s, picked.id, override.model, s.effort), effort: override.effort ?? s.assistantEffort };
  }
  const ch = s.assistantChannelId && s.assistantChannelId !== s.channelId ? s.channels.find((c) => c.id === s.assistantChannelId) : undefined;
  const model = s.assistantModel || (ch ? (ch.models[0] ?? s.model) : s.model);
  return { ...resolve(s, ch?.id ?? s.channelId, model, s.effort), effort: override.effort ?? s.assistantEffort };
}

/** 翻译用的配置：和助手一样可以单独选渠道和模型，换了渠道又没选模型时用那个渠道的第一个模型 */
export async function getTranslateAiConfig() {
  const s = await getAiSettings();
  const ch = s.translateChannelId && s.translateChannelId !== s.channelId ? s.channels.find((c) => c.id === s.translateChannelId) : undefined;
  const model = s.translateModel || (ch ? (ch.models[0] ?? s.model) : s.model);
  return { ...resolve(s, ch?.id ?? s.channelId, model, s.effort), language: s.translateLanguage };
}

export function publicAiSettings(s: AiSettings) {
  const def = s.channels.find((c) => c.id === s.channelId);
  return {
    ...s,
    channels: s.channels.map(({ apiKey, ...ch }) => ({
      ...ch,
      hasApiKey: Boolean(apiKey),
      // 只给前端看首尾几位，中间用星号
      apiKeyHint: apiKey ? (apiKey.length > 12 ? `${apiKey.slice(0, 4)}${'*'.repeat(8)}${apiKey.slice(-4)}` : '*'.repeat(8)) : null,
    })),
    // 默认渠道是否有 Key，收信规则等页面用来提示
    hasApiKey: Boolean(def?.apiKey),
  };
}

/** 从上游拉取可用模型：Anthropic 用 Models API，OpenAI 兼容接口用 GET {baseUrl}/models */
export async function fetchUpstreamModels(c: Pick<AiChannel, 'provider' | 'baseUrl' | 'apiKey'>): Promise<string[]> {
  let ids: string[] = [];
  if (c.provider === 'anthropic') {
    const client = anthropicClient(c);
    try {
      for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
    } catch (err) {
      mapAnthropicError(err);
    }
  } else {
    if (!c.baseUrl) throw new AiError(t().ai.errors.baseUrlRequired);
    let res: Response;
    try {
      res = await fetch(`${c.baseUrl.replace(/\/+$/, '')}/models`, {
        headers: c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {},
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new AiError(t().ai.errors.connectFailed((err as Error).message));
    }
    const text = await res.text();
    if (!res.ok) throw new AiError(t().ai.errors.modelsFailed(res.status, text.slice(0, 200)));
    let data: { data?: Array<{ id?: unknown }>; models?: Array<{ id?: unknown; name?: unknown }> };
    try {
      data = JSON.parse(text);
    } catch {
      throw new AiError(t().ai.errors.modelsNotJson);
    }
    // 标准格式是 {data: [{id}]}，少数网关返回 {models: [{name}]}
    ids = (data.data ?? data.models ?? []).map((m) => String((m as { id?: unknown }).id ?? (m as { name?: unknown }).name ?? '')).filter(Boolean);
  }
  if (!ids.length) throw new AiError(t().ai.errors.noModels);
  return [...new Set(ids.map((id) => id.replace(/^models\//, '')))].sort((a, b) => a.localeCompare(b));
}

const InsightSchema = z.object({
  category: z.enum(CATEGORIES),
  priority: z.enum(['high', 'normal', 'low']),
  summary: z.string(),
  needs_reply: z.boolean(),
  verification_codes: z.array(z.string()),
  amounts: z.array(z.object({ value: z.number(), currency: z.string(), label: z.string() })),
  due_date: z.string().nullable(),
  tracking_numbers: z.array(z.string()),
  action_items: z.array(z.string()),
});

type InsightOutput = z.infer<typeof InsightSchema> & { labels?: string[] };

/** 分析邮件时一起判断的标签（用户的标签列表）；提示词里用 L<id> 指代，避免名字里的特殊字符 */
export type PromptLabel = { id: number; name: string; description: string };
const labelKey = (id: number) => `L${id}`;

/** 标签列表单独作为第二段系统提示：标签不变时和第一段一样能命中提示缓存 */
function labelsSystem(labels: PromptLabel[]) {
  return prompt('labels.classify', {
    labels: labels.map((l) => `- ${labelKey(l.id)} ${l.name}${L('：', ': ')}${l.description}`).join('\n'),
    example: labelKey(labels[0]!.id),
  });
}

function labelIdsOf(out: InsightOutput, labels: PromptLabel[]) {
  const byKey = new Map(labels.map((l) => [labelKey(l.id), l.id]));
  return [...new Set((out.labels ?? []).map((k) => byKey.get(String(k).trim().toUpperCase())).filter((id): id is number => id !== undefined))];
}

export type Insight = {
  category: (typeof CATEGORIES)[number];
  priority: 'high' | 'normal' | 'low';
  summary: string;
  needsReply: boolean;
  extracted: Extracted;
  model: string;
};

// 固定不变的系统提示放在最前面，便于命中提示缓存；内容在 prompts 表（src/catalog/prompts.ts），按语言取
const classifySystem = () => prompt('classify', { categories: categoryLines() });

const MAX_BODY_CHARS = 20_000;

function describeEmail(m: Message, accountEmail: string) {
  const fmt = (a: { name?: string; address?: string }) => (a.name ? `${a.name} <${a.address}>` : (a.address ?? ''));
  const body = m.textBody ?? '';
  const files = m.attachments.filter((a) => !a.inline).map((a) => a.filename ?? '未命名');
  return [
    `收件邮箱：${accountEmail}`,
    `发件人：${fmt({ name: m.fromName ?? undefined, address: m.fromAddress ?? undefined })}`,
    `收件人：${m.to.map(fmt).join(', ')}`,
    ...(m.cc.length ? [`抄送：${m.cc.map(fmt).join(', ')}`] : []),
    `日期：${m.date.toISOString()}`,
    `主题：${m.subject}`,
    ...(files.length ? [`附件：${files.join('、')}`] : []),
    '',
    '<email_body>',
    body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n…（正文过长，后续内容省略）` : body,
    '</email_body>',
  ].join('\n');
}

function toInsight(o: InsightOutput, model: string): Insight {
  return {
    category: o.category,
    priority: o.priority,
    summary: o.summary.slice(0, 200),
    needsReply: o.needs_reply,
    extracted: {
      // 验证码一般是 4~10 位字母数字；更长的多半是链接里的 token，模型偶尔会误提取
      codes: [...new Set(o.verification_codes.map((c) => c.trim()).filter((c) => /^[A-Za-z0-9-]{4,10}$/.test(c)))],
      amounts: o.amounts,
      dueDate: o.due_date && /^\d{4}-\d{2}-\d{2}$/.test(o.due_date) ? o.due_date : null,
      trackingNumbers: o.tracking_numbers,
      actionItems: o.action_items.slice(0, 5),
    },
    model,
  };
}

export class AiError extends Error {}

// 服务端 refusal fallback 只在 Claude API 上、且这些模型支持 "default" 形式
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

function anthropicClient(c: Pick<AiConfig, 'apiKey' | 'baseUrl'>) {
  if (!c.apiKey) throw new AiError(t().ai.errors.noApiKey);
  return new Anthropic({ apiKey: c.apiKey, baseURL: c.baseUrl || undefined, timeout: 120_000, maxRetries: 2 });
}

function fallbackParams(c: AiConfig) {
  return !c.baseUrl && FALLBACK_MODELS.has(c.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {};
}

/** 把 SDK 错误转成任务队列能理解的错误：限流 / 网络 / 5xx 可重试，其余直接失败 */
function mapAnthropicError(err: unknown): never {
  if (err instanceof Anthropic.AuthenticationError) throw new AiError(t().ai.errors.invalidKey);
  if (err instanceof Anthropic.PermissionDeniedError) throw new AiError(t().ai.errors.forbidden(err.message));
  if (err instanceof Anthropic.NotFoundError) throw new AiError(t().ai.errors.modelNotFound(err.message));
  if (err instanceof Anthropic.BadRequestError) throw new AiError(t().ai.errors.badRequest(err.message));
  if (err instanceof Anthropic.RateLimitError) throw new RateLimitError(t().ai.errors.rateLimited, parseRetryAfter(err.headers?.get('retry-after')));
  if (err instanceof Anthropic.APIConnectionError) throw new RetryableError(t().ai.errors.connectFailed(err.message));
  if (err instanceof Anthropic.APIError) throw new RetryableError(t().ai.errors.apiError(err.status, err.message));
  throw err;
}

async function classifyWithAnthropic(c: AiConfig, content: string, purpose: AiPurpose, labels: PromptLabel[]): Promise<InsightOutput> {
  // 有标签时输出多一个 labels 字段，取值限定为现有标签的编号
  const keys = labels.map((l) => labelKey(l.id));
  const schema = keys.length ? InsightSchema.extend({ labels: z.array(z.enum(keys as [string, ...string[]])) }) : InsightSchema;
  return trackAi(c, purpose, async (usage) => {
    const client = anthropicClient(c);
    let res;
    try {
      res = await client.beta.messages.parse({
        model: c.model,
        max_tokens: 4096,
        ...fallbackParams(c),
        system: [
          { type: 'text', text: classifySystem(), cache_control: { type: 'ephemeral' } },
          ...(labels.length ? [{ type: 'text' as const, text: labelsSystem(labels), cache_control: { type: 'ephemeral' as const } }] : []),
        ],
        messages: [{ role: 'user', content }],
        output_config: { effort: c.effort, format: betaZodOutputFormat(schema) },
      });
    } catch (err) {
      mapAnthropicError(err);
    }
    setAnthropicUsage(usage, res.usage);
    if (res.stop_reason === 'refusal') throw new AiError(t().ai.errors.refusedEmail);
    if (res.stop_reason === 'max_tokens') throw new AiError(t().ai.errors.truncated);
    if (!res.parsed_output) throw new AiError(t().ai.errors.unparsable);
    return res.parsed_output;
  });
}

/** OpenAI 兼容接口（DeepSeek、通义千问、Kimi、本地 Ollama 等）：用 JSON 模式输出，再用同一个 schema 校验 */
async function chatCompletions(c: AiConfig, system: string, user: string, json: boolean, purpose: AiPurpose): Promise<string> {
  if (!c.baseUrl) throw new AiError(t().ai.errors.baseUrlRequired);
  const url = `${c.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return trackAi(c, purpose, async (usage) => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
        body: JSON.stringify({
          model: c.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new RetryableError(t().ai.errors.connectFailed((err as Error).message));
    }
    const text = await res.text();
    if (res.status === 429) throw new RateLimitError(t().ai.errors.apiError(res.status, text.slice(0, 200)), parseRetryAfter(res.headers.get('retry-after')));
    if (res.status >= 500) throw new RetryableError(t().ai.errors.apiError(res.status, text.slice(0, 200)));
    if (!res.ok) throw new AiError(t().ai.errors.apiError(res.status, text.slice(0, 300)));
    const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }>; usage?: Parameters<typeof setOpenAIUsage>[1] };
    setOpenAIUsage(usage, data.usage);
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new AiError(t().ai.errors.noContent);
    return content;
  });
}

const JSON_SHAPE = `只输出一个 JSON 对象，不要其他文字，字段如下：
{"category": "${CATEGORIES.join('|')}", "priority": "high|normal|low", "summary": "...", "needs_reply": false,
 "verification_codes": [], "amounts": [{"value": 0, "currency": "CNY", "label": "..."}], "due_date": null,
 "tracking_numbers": [], "action_items": []}`;
const JSON_LABELS = `\n另外加一个字段 "labels": []（标签编号数组，没有符合的就是空数组）。`;

const LenientInsight = InsightSchema.extend({
  summary: z.string().catch(''),
  needs_reply: z.boolean().catch(false),
  verification_codes: z.array(z.coerce.string()).catch([]),
  amounts: z.array(z.object({ value: z.coerce.number(), currency: z.string().catch('CNY'), label: z.string().catch('') })).catch([]),
  due_date: z.string().nullable().catch(null),
  tracking_numbers: z.array(z.coerce.string()).catch([]),
  action_items: z.array(z.string()).catch([]),
  labels: z.array(z.coerce.string()).catch([]),
});

async function classifyWithOpenAI(c: AiConfig, content: string, purpose: AiPurpose, labels: PromptLabel[]): Promise<InsightOutput> {
  const system = labels.length ? `${classifySystem()}\n\n${labelsSystem(labels)}\n\n${JSON_SHAPE}${JSON_LABELS}` : `${classifySystem()}\n\n${JSON_SHAPE}`;
  const raw = await chatCompletions(c, system, content, true, purpose);
  const json = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new AiError(t().ai.errors.notJson(raw.slice(0, 120)));
  }
  const parsed = LenientInsight.safeParse(data);
  if (!parsed.success) throw new AiError(t().ai.errors.badShape(parsed.error.issues[0]?.message));
  return parsed.data;
}

/** 分析一封邮件：分类、摘要、抽取信息，并从用户的标签里挑出符合的（labelIds） */
export async function classifyMessage(m: Message, config?: AiConfig, labels: PromptLabel[] = []): Promise<{ insight: Insight; labelIds: number[] }> {
  const c = config ?? (await getAiConfig());
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, m.accountId) });
  const content = describeEmail(m, account?.email ?? '');
  const out =
    c.provider === 'anthropic' ? await classifyWithAnthropic(c, content, 'classify', labels) : await classifyWithOpenAI(c, content, 'classify', labels);
  return { insight: toInsight(out, c.model), labelIds: labelIdsOf(out, labels) };
}

/** 通用的文本生成（回复起草、日报摘要等），按配置走 Anthropic 或 OpenAI 兼容接口 */
export async function generateText(system: string, user: string, opts: { purpose: AiPurpose; maxTokens?: number; config?: AiConfig }): Promise<string> {
  const c = opts.config ?? (await getAiConfig());
  if (!c.enabled) throw new AiError(t().ai.errors.disabled);
  if (c.provider === 'openai') return (await chatCompletions(c, system, user, false, opts.purpose)).trim();

  return trackAi(c, opts.purpose, async (usage) => {
    const client = anthropicClient(c);
    let res;
    try {
      res = await client.beta.messages.create({
        model: c.model,
        max_tokens: opts.maxTokens ?? 8192,
        ...fallbackParams(c),
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
        output_config: { effort: c.effort },
      });
    } catch (err) {
      mapAnthropicError(err);
    }
    setAnthropicUsage(usage, res.usage);
    setAnthropicUsage(usage, res.usage);
    if (res.stop_reason === 'refusal') throw new AiError(t().ai.errors.refused);
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text) throw new AiError(t().ai.errors.emptyResponse);
    return text;
  });
}

/** 按用户的要求为某封邮件起草回复正文 */
export async function draftReplyBody(m: Message, instruction: string): Promise<string> {
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, m.accountId) });
  const user = `${describeEmail(m, account?.email ?? '')}\n\n回复要求：${instruction || '礼貌地确认收到，并说明会尽快处理'}${
    account?.displayName ? `\n署名：${account.displayName}` : ''
  }`;
  return generateText(prompt('reply'), user, { purpose: 'reply' });
}

/** 用一封虚构邮件测试配置是否可用 */
export async function testAiConfig(c: AiConfig) {
  const sample = {
    accountId: 0,
    fromName: '招商银行',
    fromAddress: 'service@cmbchina.example',
    to: [{ address: 'me@example.com' }],
    cc: [],
    subject: '您的信用卡账单已出',
    date: new Date(),
    attachments: [],
    textBody: '尊敬的客户：您本期信用卡账单金额为 ¥3,280.50，最后还款日为 2026-11-25，请按时还款。如需验证请输入动态码 482913。',
  } as unknown as Message;
  const started = Date.now();
  const content = describeEmail(sample, 'me@example.com');
  const out = c.provider === 'anthropic' ? await classifyWithAnthropic(c, content, 'test', []) : await classifyWithOpenAI(c, content, 'test', []);
  return { ms: Date.now() - started, insight: toInsight(out, c.model) };
}

/**
 * 让模型按 zod schema 输出 JSON。Anthropic 用结构化输出；OpenAI 兼容接口用 JSON 模式，
 * shape 是给模型看的字段说明（JSON 模式不支持传 schema）。
 */
export async function generateJson<T>(
  system: string,
  user: string,
  schema: z.ZodType<T>,
  opts: { purpose: AiPurpose; shape: string; maxTokens?: number; effort?: AiConfig['effort']; config?: AiConfig },
): Promise<T> {
  const c = opts.config ?? (await getAiConfig());
  if (!c.enabled) throw new AiError(t().ai.errors.disabled);
  if (c.provider === 'openai') {
    const raw = await chatCompletions(
      c,
      `${system}\n\n${L('只输出一个 JSON 对象，不要其他文字，格式：', 'Output only one JSON object and nothing else, in this format:')}\n${opts.shape}`,
      user,
      true,
      opts.purpose,
    );
    let data: unknown;
    try {
      data = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      throw new AiError(t().ai.errors.notJson(raw.slice(0, 120)));
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new AiError(t().ai.errors.badShape(parsed.error.issues[0]?.message));
    return parsed.data;
  }

  return trackAi(c, opts.purpose, async (usage) => {
    const client = anthropicClient(c);
    let res;
    try {
      res = await client.beta.messages.parse({
        model: c.model,
        max_tokens: opts.maxTokens ?? 4096,
        ...fallbackParams(c),
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
        output_config: { effort: opts.effort ?? c.effort, format: betaZodOutputFormat(schema as z.ZodType<T> & z.ZodObject) },
      });
    } catch (err) {
      mapAnthropicError(err);
    }
    if (res.stop_reason === 'refusal') throw new AiError(t().ai.errors.refused);
    if (res.stop_reason === 'max_tokens') throw new AiError(t().ai.errors.truncated);
    if (!res.parsed_output) throw new AiError(t().ai.errors.unparsable);
    return res.parsed_output as T;
  });
}
