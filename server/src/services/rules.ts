import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { accounts, folders, messageInsights, messages, rules, type Message, type MessageInsight, type Rule } from '../db/schema.js';
import { ActionError } from './actions.js';
import { CATEGORIES } from './ai.js';
import { allLabelIds, labelsForMessages } from './labels.js';
import type { Scope } from './mail.js';
import { L } from '../i18n/index.js';

export const TEXT_FIELDS = ['from', 'to', 'subject', 'body', 'any'] as const;
export const ENUM_FIELDS = ['category', 'priority'] as const;
/** 标签：value 是标签 id（字符串），op 为 is（有这个标签）/ is_not */
export const LABEL_FIELDS = ['label'] as const;
export const BOOL_FIELDS = ['has_attachment', 'needs_reply', 'has_code', 'unread'] as const;
export const ACTION_TYPES = ['mark_read', 'star', 'archive', 'trash', 'junk', 'move', 'notify', 'ai_reply'] as const;
/** 依赖 AI 分析结果的条件字段 */
export const AI_FIELDS = new Set(['category', 'priority', 'needs_reply', 'has_code']);

const condition = z
  .object({
    field: z.enum([...TEXT_FIELDS, ...ENUM_FIELDS, ...LABEL_FIELDS, ...BOOL_FIELDS]),
    op: z.enum(['contains', 'not_contains', 'equals', 'regex', 'is', 'is_not']),
    value: z.union([z.string().max(500), z.boolean()]).optional(),
  })
  .superRefine((c, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if ((TEXT_FIELDS as readonly string[]).includes(c.field)) {
      if (!['contains', 'not_contains', 'equals', 'regex'].includes(c.op))
        fail(L(`${c.field} 只支持 contains / not_contains / equals / regex`, `${c.field} only supports contains / not_contains / equals / regex`));
      if (typeof c.value !== 'string' || !c.value) fail(L(`${c.field} 条件需要填写内容`, `${c.field} needs a value`));
      if (c.op === 'regex' && typeof c.value === 'string') {
        try {
          new RegExp(c.value, 'i');
        } catch {
          fail(L(`正则表达式无效：${c.value}`, `Invalid regular expression: ${c.value}`));
        }
      }
    } else if (c.field === 'label') {
      if (!['is', 'is_not'].includes(c.op)) fail(L('label 只支持 is / is_not', 'label only supports is / is_not'));
      if (typeof c.value !== 'string' || !/^\d+$/.test(c.value)) fail(L('请选择标签', 'Choose a label'));
    } else if ((ENUM_FIELDS as readonly string[]).includes(c.field)) {
      if (!['is', 'is_not'].includes(c.op)) fail(L(`${c.field} 只支持 is / is_not`, `${c.field} only supports is / is_not`));
      const allowed: readonly string[] = c.field === 'category' ? CATEGORIES : ['high', 'normal', 'low'];
      if (typeof c.value !== 'string' || !allowed.includes(c.value))
        fail(L(`${c.field} 的取值应为 ${allowed.join(' / ')}`, `${c.field} must be one of ${allowed.join(' / ')}`));
    } else {
      if (!['is', 'is_not'].includes(c.op)) fail(L(`${c.field} 只支持 is / is_not`, `${c.field} only supports is / is_not`));
      if (typeof c.value !== 'boolean') fail(L(`${c.field} 的取值应为 true / false`, `${c.field} must be true / false`));
    }
  });

const action = z
  .object({
    type: z.enum(ACTION_TYPES),
    folderId: z.number().int().optional(),
    channelId: z.number().int().optional(),
    instruction: z.string().max(1000).optional(),
  })
  .superRefine((a, ctx) => {
    if (a.type === 'move' && !a.folderId) ctx.addIssue({ code: 'custom', message: L('移动动作需要选择文件夹', 'Choose a folder for the move action') });
    if (a.type === 'notify' && !a.channelId) ctx.addIssue({ code: 'custom', message: L('通知动作需要选择渠道', 'Choose a channel for the notify action') });
  });

export const ruleInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: () => L('请填写规则名称', 'Enter a rule name') })
    .max(100),
  enabled: z.boolean().default(true),
  accountIds: z.array(z.number().int()).nullish(),
  match: z.enum(['all', 'any']).default('all'),
  conditions: z
    .array(condition)
    .min(1, { error: () => L('至少需要一个条件', 'Add at least one condition') })
    .max(20),
  actions: z
    .array(action)
    .min(1, { error: () => L('至少需要一个动作', 'Add at least one action') })
    .max(10),
  stopProcessing: z.boolean().default(false),
});

export type RuleInput = z.infer<typeof ruleInput>;

/** labelIds：邮件现有的标签；knownLabels：还存在的标签（引用了已删除标签的条件一律不匹配） */
type Ctx = { message: Message; insight: MessageInsight | null; labelIds?: number[]; knownLabels?: Set<number> };

function textOf(field: string, m: Message): string {
  switch (field) {
    case 'from':
      return `${m.fromName ?? ''} ${m.fromAddress ?? ''}`;
    case 'to':
      return [...m.to, ...m.cc].map((a) => `${a.name ?? ''} ${a.address ?? ''}`).join(' ');
    case 'subject':
      return m.subject;
    case 'body':
      return m.textBody ?? '';
    default:
      return m.searchText;
  }
}

function testCondition(c: Rule['conditions'][number], { message: m, insight, labelIds = [], knownLabels }: Ctx): boolean {
  if (c.field === 'label') {
    const id = Number(c.value);
    if (knownLabels && !knownLabels.has(id)) return false;
    return labelIds.includes(id) === (c.op === 'is');
  }
  if (AI_FIELDS.has(c.field) && !insight) return false;
  let actual: string | boolean;
  switch (c.field) {
    case 'category':
      actual = insight!.category;
      break;
    case 'priority':
      actual = insight!.priority;
      break;
    case 'needs_reply':
      actual = insight!.needsReply;
      break;
    case 'has_code':
      actual = insight!.extracted.codes.length > 0;
      break;
    case 'has_attachment':
      actual = m.hasAttachments;
      break;
    case 'unread':
      actual = !m.seen;
      break;
    default: {
      const text = textOf(c.field, m).toLowerCase();
      const v = String(c.value ?? '').toLowerCase();
      if (c.op === 'contains') return text.includes(v);
      if (c.op === 'not_contains') return !text.includes(v);
      if (c.op === 'equals') return text.trim() === v.trim() || (c.field === 'from' && m.fromAddress === v);
      try {
        return new RegExp(String(c.value), 'i').test(textOf(c.field, m));
      } catch {
        return false;
      }
    }
  }
  return c.op === 'is' ? actual === c.value : actual !== c.value;
}

export function ruleMatches(rule: Pick<Rule, 'accountIds' | 'match' | 'conditions'>, ctx: Ctx): boolean {
  if (rule.accountIds?.length && !rule.accountIds.includes(ctx.message.accountId)) return false;
  if (!rule.conditions.length) return false;
  return rule.match === 'any' ? rule.conditions.some((c) => testCondition(c, ctx)) : rule.conditions.every((c) => testCondition(c, ctx));
}

export function usesAi(rule: Pick<Rule, 'conditions' | 'actions'>) {
  return rule.conditions.some((c) => AI_FIELDS.has(c.field)) || rule.actions.some((a) => a.type === 'ai_reply');
}

/** 限定了账户范围的 API Key 只能看到、管理只作用于这些账户的规则 */
export function ruleVisible(scope: Scope, r: Pick<Rule, 'accountIds'>) {
  const allowed = scope.accountIds;
  if (!allowed) return true;
  return Boolean(r.accountIds?.length && r.accountIds.every((id) => allowed.includes(id)));
}

export function assertRuleScope(scope: Scope, accountIds: number[] | null | undefined) {
  if (!ruleVisible(scope, { accountIds: accountIds ?? null }))
    throw new ActionError(
      L(
        `该 API Key 只能管理作用于账户 ${scope.accountIds!.join(', ')} 的规则，请设置 accountIds`,
        `This API key can only manage rules for accounts ${scope.accountIds!.join(', ')}; set accountIds`,
      ),
      403,
    );
}

export async function getVisibleRule(scope: Scope, id: number) {
  const rule = await db.query.rules.findFirst({ where: eq(rules.id, id) });
  if (!rule || !ruleVisible(scope, rule)) throw new ActionError(L('规则不存在', 'Rule not found'), 404);
  return rule;
}

export async function listRules() {
  return db.select().from(rules).orderBy(asc(rules.position), asc(rules.id));
}

export async function createRule(input: RuleInput) {
  const data = ruleInput.parse(input);
  const [{ max }] = await db.select({ max: sql<number>`coalesce(max(${rules.position}), 0)::int` }).from(rules);
  const [row] = await db
    .insert(rules)
    .values({ ...data, accountIds: data.accountIds?.length ? data.accountIds : null, position: max + 1 })
    .returning();
  return row!;
}

export async function updateRule(id: number, input: Partial<RuleInput> & { position?: number }) {
  const data = ruleInput.partial().extend({ position: z.number().int().optional() }).parse(input);
  const patch: Partial<typeof rules.$inferInsert> = { ...data };
  if ('accountIds' in data) patch.accountIds = data.accountIds?.length ? data.accountIds : null;
  const [row] = await db.update(rules).set(patch).where(eq(rules.id, id)).returning();
  return row ?? null;
}

export async function deleteRule(id: number) {
  const res = await db.delete(rules).where(eq(rules.id, id));
  return (res.rowCount ?? 0) > 0;
}

/** 试运行：用最近的收件箱邮件检验规则会命中哪些（不执行动作） */
export async function testRule(input: RuleInput, limit = 200) {
  const rule = ruleInput.parse(input);
  const rows = await db
    .select({ m: messages, insight: messageInsights, accountEmail: accounts.email })
    .from(messages)
    .innerJoin(folders, eq(folders.id, messages.folderId))
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .leftJoin(messageInsights, eq(messageInsights.messageId, messages.id))
    .where(
      and(
        sql`(${folders.specialUse} = '\\Inbox' OR upper(${folders.path}) = 'INBOX')`,
        rule.accountIds?.length ? inArray(messages.accountId, rule.accountIds) : undefined,
      ),
    )
    .orderBy(desc(messages.date))
    .limit(Math.min(limit, 1000));
  const [labelMap, knownLabels] = await Promise.all([labelsForMessages(rows.map((r) => r.m.id)), allLabelIds()]);
  const matched = rows.filter((r) =>
    ruleMatches(
      { accountIds: rule.accountIds ?? null, match: rule.match, conditions: rule.conditions as Rule['conditions'] },
      {
        message: r.m,
        insight: r.insight,
        labelIds: (labelMap.get(r.m.id) ?? []).map((l) => l.id),
        knownLabels,
      },
    ),
  );
  const analyzed = rows.filter((r) => r.insight).length;
  return {
    scanned: rows.length,
    analyzed,
    matched: matched.length,
    // 规则用到了 AI 字段但很多邮件还没分析过时，提示结果可能偏少
    note:
      usesAi(rule as Rule) && analyzed < rows.length
        ? L(
            `其中 ${rows.length - analyzed} 封还没有 AI 分析结果，涉及 AI 字段的条件对它们不会命中`,
            `${rows.length - analyzed} of them have no AI analysis yet, so conditions on AI fields won't match them`,
          )
        : undefined,
    samples: matched.slice(0, 20).map((r) => ({
      id: r.m.id,
      threadId: r.m.threadId,
      account: r.accountEmail,
      from: r.m.fromName || r.m.fromAddress,
      subject: r.m.subject,
      date: r.m.date,
      category: r.insight?.category ?? null,
    })),
  };
}
