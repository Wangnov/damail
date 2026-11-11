/**
 * 标签：分类之外的细分，一封邮件可以有多个（见 docs/labels.md）。
 * - 主要入口是 AI 推荐：按发件人把最近的邮件分组，让模型只看各组概况，归纳出值得单独成标签的类型并写好判断说明；
 *   用户采用后，推荐时覆盖到的历史邮件直接打上，之后的新邮件在 AI 分析时按说明判断。
 * - 用户手动加、去掉的标签优先：手动去掉的留一条 removed 记录，重新分析不会再打回来。
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { jobs, labels, labelSuggestions, messageLabels, messages, rules, type Label } from '../db/schema.js';
import { currentLocale, intlLocale, isLocale, L, LOCALES, pickLocale, withLocale, type I18n, type Locale } from '../i18n/index.js';
import { ActionError } from './actions.js';
import { categoryLabel, generateJson, getAiConfig, type PromptLabel } from './ai.js';
import { CATEGORIES, prompt } from './catalog.js';
import { isIgnoredSql } from './contacts.js';
import { enqueue, registerJob } from './jobs.js';
import type { Scope } from './mail.js';

export const LABEL_LIMIT = 50;
export const LABEL_NAME_MAX = 20;
export const LABEL_DESC_MAX = 200;
/** 和前端 antd Tag 的预设颜色一致 */
export const LABEL_COLORS = ['blue', 'green', 'orange', 'purple', 'cyan', 'magenta', 'gold', 'geekblue', 'volcano', 'lime'] as const;

export type LabelText = { name: string; description: string };
/** 列表、详情里用的简要信息：name 是当前语言的名称，names 是所有语言的（前端切换语言时直接换） */
export type LabelBrief = { id: number; name: string; names: I18n<string>; color: string };

/** 名称、说明分开按语言取：某种语言只填了名称时，说明退回其他语言的 */
export function labelText(i18n: I18n<Partial<LabelText>>, locale?: Locale): LabelText {
  const field = (k: keyof LabelText) => pickLocale(Object.fromEntries(Object.entries(i18n).map(([l, v]) => [l, v?.[k] ?? ''])) as I18n<string>, locale) ?? '';
  return { name: field('name'), description: field('description') };
}

/** 各语言的名称，按 LOCALES 的顺序（jsonb 存进去以后键的顺序会变） */
export const labelNames = (i18n: I18n<Partial<LabelText>>) =>
  Object.fromEntries(LOCALES.filter((l) => i18n[l]?.name).map((l) => [l, i18n[l]!.name!])) as I18n<string>;

const textInput = z.object({
  name: z
    .string()
    .trim()
    .max(LABEL_NAME_MAX, { error: () => L(`标签名称最多 ${LABEL_NAME_MAX} 个字`, `Label names are at most ${LABEL_NAME_MAX} characters`) })
    .default(''),
  description: z
    .string()
    .trim()
    .max(LABEL_DESC_MAX, { error: () => L(`说明最多 ${LABEL_DESC_MAX} 个字`, `Descriptions are at most ${LABEL_DESC_MAX} characters`) })
    .default(''),
});

/** 按语言的名称和说明：每种语言可以只填一部分，但至少要有一种语言的名称和一种语言的说明 */
const i18nInput = z
  .partialRecord(z.enum(LOCALES), textInput)
  .transform((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v && (v.name || v.description))) as I18n<LabelText>)
  .superRefine((m, ctx) => {
    const list = Object.values(m);
    if (!list.some((v) => v?.name))
      ctx.addIssue({ code: 'custom', message: L('请填写标签名称（至少一种语言）', 'Enter a label name (in at least one language)') });
    if (!list.some((v) => v?.description))
      ctx.addIssue({
        code: 'custom',
        message: L(
          '请填写说明（至少一种语言），AI 靠它判断哪些邮件该打这个标签',
          'Enter a description (in at least one language); the AI uses it to decide which mail gets this label',
        ),
      });
  });

export const labelInput = z.object({
  i18n: i18nInput,
  color: z.enum(LABEL_COLORS).default('blue'),
  pinned: z.boolean().default(true),
});
export const labelPatch = labelInput.partial();

const notFound = () => new ActionError(L('标签不存在', 'Label not found'), 404);
const duplicate = (n: string) => new ActionError(L(`已经有叫「${n}」的标签了`, `A label named "${n}" already exists`), 409);

/** 跨文件夹的口径和分类一致：不含已删除、垃圾邮件 */
const NOT_TRASH = sql`coalesce(f.special_use, '') NOT IN ('\\Trash', '\\Junk')`;

function scopeSql(scope: Scope, column: string) {
  if (!scope.accountIds) return sql``;
  return scope.accountIds.length ? sql`AND ${sql.raw(column)} = ANY(${sql.param(scope.accountIds)}::int[])` : sql`AND false`;
}

// ---- 标签本身 ----

/** 标签列表，带邮件数和未读数（按访问范围统计）；name / description 是当前语言的 */
export async function listLabels(scope: Scope) {
  const [list, counts] = await Promise.all([
    db.select().from(labels).orderBy(asc(labels.id)),
    db.execute<{ label_id: number; total: number; unread: number }>(sql`
      SELECT ml.label_id, count(*)::int AS total, (count(*) FILTER (WHERE NOT m.seen))::int AS unread
      FROM message_labels ml
      JOIN messages m ON m.id = ml.message_id
      JOIN folders f ON f.id = m.folder_id
      WHERE NOT ml.removed AND ${NOT_TRASH} ${scopeSql(scope, 'm.account_id')}
      GROUP BY ml.label_id
    `),
  ]);
  const byId = new Map(counts.rows.map((r) => [r.label_id, r]));
  return list.map((l) => ({ ...l, ...labelText(l.i18n), total: byId.get(l.id)?.total ?? 0, unread: byId.get(l.id)?.unread ?? 0 }));
}

/** 分析邮件时交给 AI 的标签列表（当前语言，任务里是系统语言） */
export async function promptLabels(): Promise<PromptLabel[]> {
  const rows = await db.select({ id: labels.id, i18n: labels.i18n }).from(labels).orderBy(asc(labels.id));
  return rows.map((r) => ({ id: r.id, ...labelText(r.i18n) }));
}

/** 所有已有标签的名称（各种语言，小写），查重用 */
async function takenNames(exceptId?: number) {
  const rows = await db.select({ id: labels.id, i18n: labels.i18n }).from(labels);
  const out = new Map<string, number>();
  for (const r of rows) if (r.id !== exceptId) for (const n of Object.values(labelNames(r.i18n))) out.set(n!.toLowerCase(), r.id);
  return out;
}

/** 任何一种语言的名称都不能和别的标签的任何一种语言的名称重复 */
async function assertNamesFree(i18n: I18n<LabelText>, exceptId?: number) {
  const taken = await takenNames(exceptId);
  for (const n of Object.values(labelNames(i18n))) if (taken.has(n!.toLowerCase())) throw duplicate(n!);
}

export async function createLabel(input: z.input<typeof labelInput>, source: 'manual' | 'suggested' = 'manual'): Promise<Label> {
  const data = labelInput.parse(input);
  if ((await db.$count(labels)) >= LABEL_LIMIT)
    throw new ActionError(L(`标签最多 ${LABEL_LIMIT} 个，先删掉不用的`, `You can have at most ${LABEL_LIMIT} labels; delete some first`), 409);
  await assertNamesFree(data.i18n);
  const [row] = await db
    .insert(labels)
    .values({ ...data, source })
    .returning();
  return row!;
}

/** 修改标签；i18n 整体替换（前端会把所有语言一起提交） */
export async function updateLabel(id: number, input: z.input<typeof labelPatch>): Promise<Label> {
  const data = labelPatch.parse(input);
  if (data.i18n) await assertNamesFree(data.i18n, id);
  const [row] = await db
    .update(labels)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(labels.id, id))
    .returning();
  if (!row) throw notFound();
  return row;
}

/** 删除标签；返回条件里引用了它的规则（这些规则之后不会再匹配，规则页会提示） */
export async function deleteLabel(id: number) {
  const res = await db.delete(labels).where(eq(labels.id, id));
  if (!res.rowCount) throw notFound();
  return { rules: await rulesUsingLabel(id) };
}

export async function rulesUsingLabel(id: number) {
  return db
    .select({ id: rules.id, name: rules.name })
    .from(rules)
    .where(sql`${rules.conditions} @> ${JSON.stringify([{ field: 'label', value: String(id) }])}::jsonb`);
}

export async function allLabelIds() {
  return new Set((await db.select({ id: labels.id }).from(labels)).map((r) => r.id));
}

// ---- 邮件上的标签 ----

const brief = (l: { id: number; i18n: I18n<LabelText>; color: string }): LabelBrief => ({
  id: l.id,
  name: labelText(l.i18n).name,
  names: labelNames(l.i18n),
  color: l.color,
});

/** 这些邮件上的标签（不含手动去掉的） */
export async function labelsForMessages(messageIds: number[]): Promise<Map<number, LabelBrief[]>> {
  const out = new Map<number, LabelBrief[]>();
  if (!messageIds.length) return out;
  const rows = await db
    .select({ messageId: messageLabels.messageId, id: labels.id, i18n: labels.i18n, color: labels.color })
    .from(messageLabels)
    .innerJoin(labels, eq(labels.id, messageLabels.labelId))
    .where(and(inArray(messageLabels.messageId, messageIds), eq(messageLabels.removed, false)))
    .orderBy(asc(labels.id));
  for (const { messageId, ...l } of rows) out.set(messageId, [...(out.get(messageId) ?? []), brief(l)]);
  return out;
}

/** 会话里各封邮件的标签合在一起（只算访问范围内的邮件） */
export async function labelsForThreads(threadIds: string[], scope: Scope): Promise<Map<string, LabelBrief[]>> {
  const out = new Map<string, LabelBrief[]>();
  if (!threadIds.length) return out;
  const rows = await db.execute<{ thread_id: string; id: number; i18n: I18n<LabelText>; color: string }>(sql`
    SELECT DISTINCT ON (m.thread_id, l.id) m.thread_id, l.id, l.i18n, l.color
    FROM message_labels ml
    JOIN labels l ON l.id = ml.label_id
    JOIN messages m ON m.id = ml.message_id
    WHERE NOT ml.removed AND m.thread_id = ANY(${sql.param(threadIds)}::text[]) ${scopeSql(scope, 'm.account_id')}
    ORDER BY m.thread_id, l.id
  `);
  for (const { thread_id, ...l } of rows.rows) out.set(thread_id, [...(out.get(thread_id) ?? []), brief(l)]);
  return out;
}

/** 规则用：这封邮件现在有的标签 id */
export async function messageLabelIds(messageId: number) {
  const rows = await db
    .select({ id: messageLabels.labelId })
    .from(messageLabels)
    .where(and(eq(messageLabels.messageId, messageId), eq(messageLabels.removed, false)));
  return rows.map((r) => r.id);
}

/** 用户手动加、去掉标签。去掉的留一条 removed 记录，重新分析不会再打回来 */
export async function setMessageLabels(scope: Scope, messageId: number, change: { add?: number[]; remove?: number[] }) {
  const msg = await db.query.messages.findFirst({ where: eq(messages.id, messageId), columns: { id: true, accountId: true } });
  if (!msg || (scope.accountIds && !scope.accountIds.includes(msg.accountId))) throw new ActionError(L('邮件不存在', 'Message not found'), 404);
  const add = [...new Set(change.add ?? [])];
  const remove = [...new Set(change.remove ?? [])].filter((id) => !add.includes(id));
  const ids = [...add, ...remove];
  if (ids.length) {
    const known = await db.select({ id: labels.id }).from(labels).where(inArray(labels.id, ids));
    if (known.length !== ids.length) throw notFound();
  }
  const upsert = (labelId: number, removed: boolean) =>
    db
      .insert(messageLabels)
      .values({ messageId, labelId, source: 'manual', removed })
      .onConflictDoUpdate({ target: [messageLabels.messageId, messageLabels.labelId], set: { source: 'manual', removed, createdAt: new Date() } });
  for (const id of add) await upsert(id, false);
  for (const id of remove) await upsert(id, true);
  return (await labelsForMessages([messageId])).get(messageId) ?? [];
}

/** 按会话加、去掉标签（列表右键菜单、多选）：会话里范围内的每封邮件都改，规则同 setMessageLabels */
export async function setThreadLabels(scope: Scope, threadIds: string[], change: { add?: number[]; remove?: number[] }) {
  const add = [...new Set(change.add ?? [])];
  const remove = [...new Set(change.remove ?? [])].filter((id) => !add.includes(id));
  const ids = [...add, ...remove];
  if (!ids.length || !threadIds.length) return { updated: 0 };
  const known = await db.select({ id: labels.id }).from(labels).where(inArray(labels.id, ids));
  if (known.length !== ids.length) throw notFound();
  const msgs = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(inArray(messages.threadId, threadIds), scope.accountIds ? inArray(messages.accountId, scope.accountIds.length ? scope.accountIds : [-1]) : undefined),
    );
  if (!msgs.length) return { updated: 0 };
  const rows = msgs.flatMap((m) => [
    ...add.map((labelId) => ({ messageId: m.id, labelId, source: 'manual', removed: false })),
    ...remove.map((labelId) => ({ messageId: m.id, labelId, source: 'manual', removed: true })),
  ]);
  await db
    .insert(messageLabels)
    .values(rows)
    .onConflictDoUpdate({
      target: [messageLabels.messageId, messageLabels.labelId],
      set: { source: 'manual', removed: sql`excluded.removed`, createdAt: new Date() },
    });
  return { updated: msgs.length };
}

/**
 * AI 分析后更新这封邮件上 AI 打的标签：去掉这次没选的，加上新选的。
 * 手动加的、手动去掉的、采用推荐时打的都不动
 */
export async function applyAiLabels(messageId: number, labelIds: number[]) {
  await db
    .delete(messageLabels)
    .where(
      and(
        eq(messageLabels.messageId, messageId),
        eq(messageLabels.source, 'ai'),
        eq(messageLabels.removed, false),
        labelIds.length ? notInArray(messageLabels.labelId, labelIds) : undefined,
      ),
    );
  if (labelIds.length)
    await db
      .insert(messageLabels)
      .values(labelIds.map((labelId) => ({ messageId, labelId, source: 'ai' })))
      .onConflictDoNothing();
}

/** 手动新建的标签补打到最近 N 天的收件箱邮件：重新分析还没有这个标签记录的邮件（会调用 AI） */
export async function backfillLabel(id: number, days: number) {
  const label = await db.query.labels.findFirst({ where: eq(labels.id, id) });
  if (!label) throw notFound();
  const rows = await db.execute<{ id: number }>(sql`
    SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id
    WHERE (f.special_use = '\\Inbox' OR upper(f.path) = 'INBOX')
      AND m.date > now() - make_interval(days => ${Math.min(Math.max(days, 1), 365)})
      AND NOT ${isIgnoredSql(sql`m.from_address`)}
      AND NOT EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id = ${id})
    ORDER BY m.date DESC LIMIT 1000
  `);
  for (const r of rows.rows) await enqueue('process_message', { messageId: Number(r.id), analyzeOnly: true, reanalyze: true });
  return { queued: rows.rows.length };
}

// ---- AI 推荐 ----

export const SUGGEST_DAYS = 90;
const MIN_GROUP = 3;
const MAX_GROUPS = 120;
/** 个人邮箱服务商：同域名的发件人互不相干，不按域名合并 */
const PUBLIC_DOMAINS = new Set(
  'gmail.com googlemail.com qq.com foxmail.com 163.com 126.com yeah.net sina.com sina.cn sohu.com aliyun.com 139.com outlook.com hotmail.com live.com msn.com msn.cn icloud.com me.com mac.com yahoo.com yahoo.co.jp protonmail.com proton.me gmx.com mail.ru'.split(
    ' ',
  ),
);

type GroupRow = {
  id: number;
  from_address: string | null;
  from_name: string | null;
  subject: string;
  summary: string | null;
  category: string | null;
  date: Date;
};

export type SuggestGroup = {
  key: string;
  sender: string;
  addresses: Array<{ address: string; count: number }>;
  count: number;
  categories: string[];
  samples: Array<{ subject: string; summary: string | null }>;
  messageIds: number[];
};

/** 主域名：mail.notice.example.com → example.com；example.com.cn 这类保留三段 */
function baseDomain(domain: string) {
  const parts = domain.split('.');
  const n = /\.(com|net|org|gov|edu|co|ac)\.[a-z]{2}$/.test(domain) ? 3 : 2;
  return parts.slice(-n).join('.');
}

/**
 * 不用 AI 先分组：最近 90 天（不含已删除、垃圾邮件、忽略名单、AI 判为垃圾的），按发件人地址分组，
 * 同一公司域名下的多个地址合成一组；去掉太小的组和已经基本被现有标签覆盖的组
 */
export async function buildSuggestGroups(scope: Scope = { accountIds: null }): Promise<SuggestGroup[]> {
  const rows = await db.execute<GroupRow & { labeled: boolean }>(sql`
    SELECT m.id, m.from_address, m.from_name, m.subject, i.summary, i.category, m.date,
           EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND NOT ml.removed) AS labeled
    FROM messages m
    JOIN folders f ON f.id = m.folder_id
    LEFT JOIN message_insights i ON i.message_id = m.id
    WHERE m.date > now() - make_interval(days => ${SUGGEST_DAYS})
      AND ${NOT_TRASH} AND coalesce(f.special_use, '') <> '\\Sent'
      AND m.from_address IS NOT NULL
      AND coalesce(i.category, '') <> 'spam'
      AND NOT ${isIgnoredSql(sql`m.from_address`)}
      ${scopeSql(scope, 'm.account_id')}
    ORDER BY m.date DESC
    LIMIT 5000
  `);

  // 先按地址，再把同一公司域名下的地址合并
  const byKey = new Map<string, (GroupRow & { labeled: boolean })[]>();
  for (const r of rows.rows) {
    const address = r.from_address!.toLowerCase();
    const domain = address.split('@')[1] ?? '';
    const key = domain && !PUBLIC_DOMAINS.has(domain) ? `@${baseDomain(domain)}` : address;
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }

  const groups: SuggestGroup[] = [];
  for (const [key, list] of byKey) {
    if (list.length < MIN_GROUP) continue;
    if (list.filter((r) => r.labeled).length / list.length > 0.8) continue;
    const count = <T extends string>(values: T[]) => {
      const m = new Map<T, number>();
      for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const names = count(list.map((r) => r.from_name?.trim()).filter((n): n is string => !!n));
    groups.push({
      key,
      sender: names[0]?.[0] ?? key,
      addresses: count(list.map((r) => r.from_address!.toLowerCase()))
        .slice(0, 4)
        .map(([address, n]) => ({ address, count: n })),
      count: list.length,
      categories: count(list.map((r) => r.category).filter((c): c is string => !!c))
        .slice(0, 3)
        .map(([c]) => c),
      // 主题去重，避免同一种通知占满例子
      samples: [...new Map(list.map((r) => [r.subject, r])).values()]
        .slice(0, 5)
        .map((r) => ({ subject: r.subject.slice(0, 100), summary: r.summary?.slice(0, 100) ?? null })),
      messageIds: list.map((r) => Number(r.id)),
    });
  }
  groups.sort((a, b) => b.count - a.count);
  return groups.slice(0, MAX_GROUPS).map((g, i) => ({ ...g, key: `g${i + 1}` }));
}

type SuggestText = LabelText & { reason: string };
const suggestText = z.object({ name: z.string().catch(''), description: z.string().catch(''), reason: z.string().catch('') });

/** 每条建议都要写出所有支持的语言：一次调用生成，切换界面语言时不用再调 AI */
const suggestSchema = () =>
  z.object({
    suggestions: z
      .array(
        z.object({
          i18n: z.object(
            Object.fromEntries(LOCALES.map((l) => [l, suggestText.optional().catch(undefined)])) as Record<
              Locale,
              z.ZodCatch<z.ZodOptional<typeof suggestText>>
            >,
          ),
          groups: z.array(z.string()),
        }),
      )
      .catch([]),
  });

const SHAPE_EXAMPLE: Record<Locale, SuggestText> = {
  'zh-CN': { name: '券商交易通知', description: 'Interactive Brokers、富途等券商发的成交确认、持仓日报；不包括营销邮件', reason: '两家券商共 37 封，每周都有' },
  en: {
    name: 'Broker trades',
    description: 'Trade confirmations and daily statements from brokers such as Interactive Brokers; not marketing mail',
    reason: '37 emails from two brokers, every week',
  },
};
const suggestShape = () => JSON.stringify({ suggestions: [{ i18n: Object.fromEntries(LOCALES.map((l) => [l, SHAPE_EXAMPLE[l]])), groups: ['g3', 'g17'] }] });

/** 语言名称用提示词所用的语言写（加新语言不用改这里） */
const languageName = (l: Locale) => new Intl.DisplayNames([intlLocale()], { type: 'language' }).of(l) ?? l;

/** 提示词按发起推荐时的界面语言选，输出一律要所有语言 */
function suggestSystem() {
  return prompt('labels.suggest', {
    days: SUGGEST_DAYS,
    categories: CATEGORIES.map((c) => categoryLabel(c)).join(L('、', ', ')),
    languages: LOCALES.map((l) => `${l}: ${languageName(l)}`).join(L('；', '; ')),
  });
}

function suggestUser(groups: SuggestGroup[], existing: Array<{ names: I18n<string>; description: string }>, dismissed: string[]) {
  const lines = groups.map((g) =>
    [
      `[${g.key}] ${g.sender} · ${L(`${g.count} 封`, `${g.count} emails`)} · ${g.addresses.map((a) => `${a.address}(${a.count})`).join(', ')}${
        g.categories.length ? ` · ${L('分类：', 'categories: ')}${g.categories.map((c) => categoryLabel(c)).join(L('、', ', '))}` : ''
      }`,
      ...g.samples.map((s) => `  - ${s.subject}${s.summary ? ` —— ${s.summary}` : ''}`),
    ].join('\n'),
  );
  return [
    existing.length
      ? `${L('用户已有的标签：', 'Existing labels:')}\n${existing.map((l) => `- ${Object.values(l.names).join(' / ')}${L('：', ': ')}${l.description}`).join('\n')}`
      : L('用户还没有标签。', 'The user has no labels yet.'),
    dismissed.length ? `${L('用户忽略过的推荐：', 'Recommendations the user dismissed: ')}${dismissed.join(L('、', ', '))}` : '',
    `${L(`邮件分组（共 ${groups.length} 组）：`, `Mail groups (${groups.length}):`)}\n<groups>\n${lines.join('\n')}\n</groups>`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** 超长时在最后一个句子 / 分句边界截断，不在词中间切断；找不到边界才硬截 */
export function clip(text: string, max: number) {
  const s = text.trim().replace(/\s+/g, ' ');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = Math.max(...['。', '；', '. ', '; ', '，', ', '].map((p) => cut.lastIndexOf(p)));
  if (at >= max * 0.5)
    return cut
      .slice(0, at + 1)
      .trim()
      .replace(/[，,;；]$/, '');
  const space = cut.lastIndexOf(' ');
  return (space >= max * 0.5 ? cut.slice(0, space) : cut).trim();
}

/** 推荐任务：分组 → 一次 AI 调用（同时生成所有语言）→ 把建议和覆盖的邮件存下来 */
export async function runLabelSuggestions() {
  const runId = randomUUID();
  await db.update(labelSuggestions).set({ status: 'expired' }).where(eq(labelSuggestions.status, 'pending'));
  const groups = await buildSuggestGroups();
  if (groups.length < MIN_GROUP) return { runId, suggestions: 0, groups: groups.length, tooFew: true };

  const [existing, dismissed] = await Promise.all([
    db.select({ i18n: labels.i18n }).from(labels).orderBy(asc(labels.id)),
    db
      .select({ i18n: labelSuggestions.i18n })
      .from(labelSuggestions)
      .where(eq(labelSuggestions.status, 'dismissed'))
      .orderBy(desc(labelSuggestions.id))
      .limit(50)
      .then((r) => [...new Set(r.flatMap((x) => Object.values(labelNames(x.i18n)) as string[]))]),
  ]);
  const out = await generateJson(
    suggestSystem(),
    suggestUser(
      groups,
      existing.map((l) => ({ names: labelNames(l.i18n), description: labelText(l.i18n).description })),
      dismissed,
    ),
    suggestSchema(),
    { purpose: 'labels', shape: suggestShape(), maxTokens: 12_000 },
  );

  const byKey = new Map(groups.map((g) => [g.key, g]));
  const taken = await takenNames();
  const values: (typeof labelSuggestions.$inferInsert)[] = [];
  for (const s of out.suggestions.slice(0, 12)) {
    const i18n: I18n<SuggestText> = {};
    for (const l of LOCALES) {
      const v = s.i18n[l];
      const name = v?.name.trim().slice(0, LABEL_NAME_MAX);
      if (name) i18n[l] = { name, description: clip(v!.description, LABEL_DESC_MAX), reason: clip(v!.reason, 200) };
    }
    const names = Object.values(i18n).map((v) => v!.name.toLowerCase());
    const ids = [...new Set(s.groups.flatMap((k) => byKey.get(k.trim())?.messageIds ?? []))];
    if (!names.length || !Object.values(i18n).some((v) => v!.description) || !ids.length || names.some((n) => taken.has(n))) continue;
    for (const n of names) taken.set(n, 0);
    values.push({ runId, i18n, color: LABEL_COLORS[(existing.length + values.length) % LABEL_COLORS.length]!, messageIds: ids });
  }
  if (values.length) await db.insert(labelSuggestions).values(values);
  return { runId, suggestions: values.length, groups: groups.length };
}

// 提示词按发起推荐时的界面语言选（没有记录时用系统语言）；输出一律是所有语言
registerJob('suggest_labels', (payload) => (isLocale(payload.locale) ? withLocale(payload.locale, runLabelSuggestions) : runLabelSuggestions()), 1);

/** 最近一次推荐任务的状态 */
async function latestRun() {
  const [job] = await db.select().from(jobs).where(eq(jobs.type, 'suggest_labels')).orderBy(desc(jobs.createdAt)).limit(1);
  if (!job) return null;
  return {
    status: job.status as 'queued' | 'running' | 'done' | 'failed',
    error: job.error,
    tooFew: Boolean(job.result?.tooFew),
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

export async function startLabelSuggestions() {
  const ai = await getAiConfig();
  if (!ai.enabled) throw new ActionError(L('先在「AI → 模型设置」里启用 AI', 'Enable AI in AI → Models first'), 400);
  const run = await latestRun();
  if (run && (run.status === 'queued' || run.status === 'running'))
    throw new ActionError(L('推荐正在进行，请稍候', 'A recommendation is already running'), 409);
  await enqueue('suggest_labels', { locale: currentLocale() });
  return { started: true };
}

/** 待处理的推荐，每条带几封例子 */
export async function listSuggestions(scope: Scope) {
  const [run, pending] = await Promise.all([
    latestRun(),
    db.select().from(labelSuggestions).where(eq(labelSuggestions.status, 'pending')).orderBy(asc(labelSuggestions.id)),
  ]);
  const ids = [...new Set(pending.flatMap((s) => s.messageIds))];
  const rows = ids.length
    ? await db.execute<{ id: number; thread_id: string; subject: string; from_name: string | null; from_address: string | null; date: Date }>(sql`
        SELECT m.id, m.thread_id, m.subject, m.from_name, m.from_address, m.date FROM messages m
        WHERE m.id = ANY(${sql.param(ids)}::bigint[]) ${scopeSql(scope, 'm.account_id')}
      `)
    : { rows: [] };
  const byId = new Map(rows.rows.map((r) => [Number(r.id), r]));
  return {
    run,
    days: SUGGEST_DAYS,
    suggestions: pending.map((s) => {
      const msgs = s.messageIds
        .map((id) => byId.get(Number(id)))
        .filter((m): m is NonNullable<typeof m> => !!m)
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      return {
        id: s.id,
        i18n: s.i18n,
        ...labelText(s.i18n),
        reason: pickLocale(Object.fromEntries(Object.entries(s.i18n).map(([l, v]) => [l, v?.reason ?? ''])) as I18n<string>) ?? '',
        color: s.color,
        count: msgs.length,
        examples: msgs
          .slice(0, 5)
          .map((m) => ({ id: Number(m.id), threadId: m.thread_id, subject: m.subject, from: m.from_name || m.from_address, date: m.date })),
      };
    }),
  };
}

async function pendingSuggestion(id: number) {
  const s = await db.query.labelSuggestions.findFirst({ where: eq(labelSuggestions.id, id) });
  if (!s || s.status !== 'pending') throw new ActionError(L('这条推荐已经处理过或已过期', 'This recommendation was already handled or has expired'), 404);
  return s;
}

export const acceptInput = z.object({
  /** 采用前改过名称 / 说明时传入（所有语言一起） */
  i18n: i18nInput.optional(),
  color: z.enum(LABEL_COLORS).optional(),
  /** 和已有标签重名时，可以合并到这个标签 */
  mergeInto: z.number().int().optional(),
});

/** 采用推荐：建标签（或合并到已有标签），推荐时覆盖到的历史邮件直接打上 */
export async function acceptSuggestion(id: number, input: z.input<typeof acceptInput>) {
  const opts = acceptInput.parse(input);
  const s = await pendingSuggestion(id);
  let label: Label;
  if (opts.mergeInto) {
    const found = await db.query.labels.findFirst({ where: eq(labels.id, opts.mergeInto) });
    if (!found) throw notFound();
    label = found;
  } else {
    const i18n =
      opts.i18n ?? (Object.fromEntries(Object.entries(s.i18n).map(([l, v]) => [l, { name: v!.name, description: v!.description }])) as I18n<LabelText>);
    label = await createLabel({ i18n, color: opts.color ?? (s.color as (typeof LABEL_COLORS)[number]) }, 'suggested');
  }
  // 邮件可能已经被删掉了，只给还在的打；用户手动去掉过的保持去掉
  const res = await db.execute(sql`
    INSERT INTO message_labels (message_id, label_id, source)
    SELECT m.id, ${label.id}, 'suggestion' FROM messages m WHERE m.id = ANY(${sql.param(s.messageIds)}::bigint[])
    ON CONFLICT DO NOTHING
  `);
  await db.update(labelSuggestions).set({ status: 'accepted', labelId: label.id }).where(eq(labelSuggestions.id, id));
  return { label: { ...label, ...labelText(label.i18n) }, labeled: res.rowCount ?? 0 };
}

export async function dismissSuggestion(id: number) {
  await pendingSuggestion(id);
  await db.update(labelSuggestions).set({ status: 'dismissed' }).where(eq(labelSuggestions.id, id));
  return { ok: true };
}
