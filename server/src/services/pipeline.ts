import { and, arrayOverlaps, desc, eq, inArray, isNull, not, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/index.js';
import { db } from '../db/index.js';
import { accounts, channels, folders, jobs, messageInsights, messages, rules, type Message, type MessageInsight, type Rule } from '../db/schema.js';
import { L } from '../i18n/index.js';
import { audit } from '../lib/audit.js';
import { bus } from '../lib/events.js';
import { moveMessages, setFlags } from './actions.js';
import { classifyMessage, getAiConfig, categoryLabel } from './ai.js';
import { isIgnoredSender, isIgnoredSql } from './contacts.js';
import { createDraft, submitDraft, updateDraft } from './drafts.js';
import { DeferredError, enqueue, registerJob, RetryableError } from './jobs.js';
import { appUrl, notifyChannel, type EventName, type Notice } from './notify.js';
import { listRules, ruleMatches } from './rules.js';
import { allLabelIds, applyAiLabels, messageLabelIds, promptLabels } from './labels.js';

const ALL = { accountIds: null };

function messageNotice(m: Message, insight: MessageInsight | null, event: EventName): Notice {
  const from = m.fromName || m.fromAddress || L('未知发件人', 'Unknown sender');
  const code = insight?.extracted.codes[0];
  const lines = [insight?.summary || m.snippet];
  if (code) lines.unshift(L(`验证码：${code}`, `Code: ${code}`));
  if (insight?.extracted.dueDate) lines.push(L(`截止：${insight.extracted.dueDate}`, `Due: ${insight.extracted.dueDate}`));
  return {
    event,
    title:
      event === 'message.verification' && code
        ? L(`验证码 ${code}（${from}）`, `Code ${code} (${from})`)
        : `${from}${L('：', ': ')}${m.subject || L('(无主题)', '(no subject)')}`,
    body: lines.filter(Boolean).join('\n'),
    url: appUrl(`/mail?thread=${encodeURIComponent(m.threadId)}`),
    copy: code,
    data: {
      messageId: m.id,
      threadId: m.threadId,
      accountId: m.accountId,
      from: { name: m.fromName, address: m.fromAddress },
      subject: m.subject,
      date: m.date.toISOString(),
      ...(insight
        ? {
            category: insight.category,
            categoryLabel: categoryLabel(insight.category),
            priority: insight.priority,
            summary: insight.summary,
            needsReply: insight.needsReply,
            extracted: insight.extracted,
          }
        : {}),
    },
  };
}

export async function saveInsight(messageId: number, insight: Omit<MessageInsight, 'messageId' | 'createdAt'>) {
  const [row] = await db
    .insert(messageInsights)
    .values({ messageId, ...insight })
    .onConflictDoUpdate({ target: messageInsights.messageId, set: { ...insight, createdAt: new Date() } })
    .returning();
  return row!;
}

/** 规则动作：先执行不改变位置的动作，最后再移动，避免邮件被移走后后续动作找不到它 */
async function runActions(rule: Rule, m: Message, insight: MessageInsight | null, notified: Set<number>) {
  const done: string[] = [];
  const auth: AuthContext = { kind: 'session', userId: 0, scopes: [], scope: ALL, actor: `rule:${rule.id}` };
  const ordered = [...rule.actions].sort(
    (a, b) => Number(['archive', 'trash', 'junk', 'move'].includes(a.type)) - Number(['archive', 'trash', 'junk', 'move'].includes(b.type)),
  );
  for (const a of ordered) {
    try {
      switch (a.type) {
        case 'mark_read':
          await setFlags(ALL, [m.id], { seen: true });
          break;
        case 'star':
          await setFlags(ALL, [m.id], { flagged: true });
          break;
        case 'notify':
          if (a.channelId && !notified.has(a.channelId)) {
            notified.add(a.channelId);
            const notice = messageNotice(m, insight, 'message.received');
            await notifyChannel(a.channelId, { ...notice, event: 'rule.matched', data: { ...notice.data, rule: { id: rule.id, name: rule.name } } });
          }
          break;
        case 'ai_reply': {
          // AI 起草的回复只进入待审批，绝不自动发出；自己账户之间的来信不起草，避免互相回复形成循环
          const own = await db.query.accounts.findFirst({ where: sql`lower(${accounts.email}) = lower(${m.fromAddress ?? ''})` });
          if (own) {
            done.push('ai_reply:跳过(来自自己的账户)');
            continue;
          }
          const { draftReplyBody } = await import('./ai.js');
          const body = await draftReplyBody(m, a.instruction ?? '');
          const d = await createDraft(auth, { mode: 'reply', sourceMessageId: m.id, body }, 'rule');
          await updateDraft(auth, d.id, { note: L(`规则「${rule.name}」自动起草`, `Rule "${rule.name}" drafted`) });
          await submitDraft(auth, d.id);
          break;
        }
        case 'archive':
        case 'trash':
        case 'junk':
          await moveMessages(ALL, [m.id], a.type);
          break;
        case 'move':
          await moveMessages(ALL, [m.id], { folderId: a.folderId! });
          break;
      }
      done.push(a.type);
    } catch (err) {
      done.push(`${a.type}:失败(${(err as Error).message})`);
    }
  }
  return done;
}

registerJob(
  'process_message',
  async (payload, ctx) => {
    const messageId = Number(payload.messageId);
    const m = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
    if (!m) return { skipped: '邮件已不存在' };
    const result: Record<string, unknown> = {};

    // 1. AI 分析
    let insight = (await db.query.messageInsights.findFirst({ where: eq(messageInsights.messageId, m.id) })) ?? null;
    const ai = await getAiConfig();
    // 自动分析看开关和范围；补做（analyzeOnly）和重新分析是手动发起的，只要求 AI 启用
    const auto = ai.analysisEnabled && (!ai.accountIds || ai.accountIds.includes(m.accountId));
    // 忽略名单里的发件人一律不送给 AI，手动重新分析也一样
    const ignored = await isIgnoredSender(m.fromAddress);
    if (ignored) result.ai = '发件人在忽略名单里';
    const aiApplies = ai.enabled && !ignored && (auto || !!payload.analyzeOnly || !!payload.reanalyze);
    if ((!insight || payload.reanalyze) && aiApplies) {
      try {
        const out = await classifyMessage(m, ai, await promptLabels());
        insight = await saveInsight(m.id, out.insight);
        await applyAiLabels(m.id, out.labelIds);
        result.category = insight.category;
        if (out.labelIds.length) result.labels = out.labelIds;
        bus.publish({ type: 'messages.updated', accountId: m.accountId, folderId: m.folderId });
      } catch (err) {
        // 可重试的错误先重试；最后一次仍失败就跳过 AI，规则和通知照常执行。
        // AI 排队已满这类「暂时没空」的错误总是交给任务队列推迟，不算失败
        if (err instanceof DeferredError || (err instanceof RetryableError && !ctx.lastAttempt)) throw err;
        result.aiError = (err as Error).message;
      }
    }
    if (payload.analyzeOnly) return result;

    // 2. 规则
    const notified = new Set<number>();
    const matched: string[] = [];
    const [labelIds, knownLabels] = await Promise.all([messageLabelIds(m.id), allLabelIds()]);
    for (const rule of (await listRules()).filter((r) => r.enabled)) {
      if (!ruleMatches(rule, { message: m, insight, labelIds, knownLabels })) continue;
      const actions = await runActions(rule, m, insight, notified);
      matched.push(`${rule.name}: ${actions.join(', ')}`);
      await db
        .update(rules)
        .set({ matchCount: sql`${rules.matchCount} + 1`, lastMatchedAt: new Date() })
        .where(eq(rules.id, rule.id));
      audit(`rule:${rule.id}`, 'rule.matched', { accountId: m.accountId, target: `message:${m.id}`, detail: { actions } });
      if (rule.stopProcessing) break;
    }
    if (matched.length) result.rules = matched;

    // 3. 订阅了事件的渠道：每个渠道只推送一次，取最具体的事件
    const events: EventName[] = ['message.received'];
    if (insight?.priority === 'high') events.unshift('message.important');
    if (insight?.extracted.codes.length) events.unshift('message.verification');
    const subscribed = await db
      .select({ id: channels.id, events: channels.events })
      .from(channels)
      .where(and(eq(channels.enabled, true), arrayOverlaps(channels.events, events)));
    for (const ch of subscribed) {
      if (notified.has(ch.id)) continue;
      const event = events.find((e) => ch.events.includes(e))!;
      notified.add(ch.id);
      await notifyChannel(ch.id, messageNotice(m, insight, event));
    }
    if (notified.size) result.notified = [...notified];
    return result;
  },
  3,
);

/** 同步到新邮件时调用：只处理收件箱里的、近期的邮件（首次回溯和移回收件箱的旧邮件不触发） */
export async function onNewMessage(messageId: number, date: Date) {
  if (Date.now() - date.getTime() > 3 * 86400_000) return;
  await enqueue('process_message', { messageId });
}

/** 对最近的收件箱邮件补做 AI 分析（不执行规则、不推送） */
const IN_INBOX = sql`(${folders.specialUse} = '\\Inbox' OR upper(${folders.path}) = 'INBOX')`;

export async function backfillInsights(limit: number, accountIds?: number[]) {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(folders, eq(folders.id, messages.folderId))
    .leftJoin(messageInsights, eq(messageInsights.messageId, messages.id))
    .where(
      and(
        isNull(messageInsights.messageId),
        IN_INBOX,
        not(isIgnoredSql(sql`${messages.fromAddress}`)),
        accountIds?.length ? inArray(messages.accountId, accountIds) : undefined,
      ),
    )
    .orderBy(desc(messages.date))
    .limit(Math.min(limit, 1000));
  for (const r of rows) await enqueue('process_message', { messageId: r.id, analyzeOnly: true });
  return { queued: rows.length };
}

/** 自动分析进度：各邮箱收件箱已分析 / 总数、近 24 小时分析了多少、队列里还有多少 */
export async function analysisStatus() {
  const n = sql<number>`count(*)::int`;
  const [byAccount, [recent], [queue]] = await Promise.all([
    db
      .select({ accountId: messages.accountId, inbox: n, analyzed: sql<number>`count(${messageInsights.messageId})::int` })
      .from(messages)
      .innerJoin(folders, eq(folders.id, messages.folderId))
      .leftJoin(messageInsights, eq(messageInsights.messageId, messages.id))
      // 忽略名单里的发件人不分析，也不算进待分析总数
      .where(and(IN_INBOX, not(isIgnoredSql(sql`${messages.fromAddress}`))))
      .groupBy(messages.accountId),
    db
      .select({ n })
      .from(messageInsights)
      .where(sql`${messageInsights.createdAt} > now() - interval '24 hours'`),
    db
      .select({ n })
      .from(jobs)
      .where(and(eq(jobs.type, 'process_message'), inArray(jobs.status, ['queued', 'running']))),
  ]);
  return { accounts: byAccount, last24h: recent?.n ?? 0, queued: queue?.n ?? 0 };
}
