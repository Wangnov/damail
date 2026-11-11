import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { assistantConversations, type AssistantMessage } from '../db/schema.js';
import { L } from '../i18n/index.js';
import { prompt } from './catalog.js';
import { ActionError } from './actions.js';
import { generateJson } from './ai.js';

/** 站内 AI 助手的会话记录：存在数据库里，换设备也能看到 */

const MAX_MESSAGES = 200;

export const placeholderTitle = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 30 ? `${line.slice(0, 30)}…` : line || L('新对话', 'New chat');
};

export async function listConversations(userId: number) {
  return db
    .select({ id: assistantConversations.id, title: assistantConversations.title, updatedAt: assistantConversations.updatedAt })
    .from(assistantConversations)
    .where(eq(assistantConversations.userId, userId))
    .orderBy(desc(assistantConversations.updatedAt))
    .limit(200);
}

export async function getConversation(userId: number, id: number) {
  const row = await db.query.assistantConversations.findFirst({
    where: and(eq(assistantConversations.id, id), eq(assistantConversations.userId, userId)),
  });
  if (!row) throw new ActionError(L('会话不存在', 'Conversation not found'), 404);
  return row;
}

export async function createConversation(userId: number, firstMessage: string) {
  const [row] = await db
    .insert(assistantConversations)
    .values({ userId, title: placeholderTitle(firstMessage), messages: [] })
    .returning();
  return row!;
}

export async function saveMessages(userId: number, id: number, messages: AssistantMessage[]) {
  await db
    .update(assistantConversations)
    .set({ messages: messages.slice(-MAX_MESSAGES), updatedAt: sql`now()` })
    .where(and(eq(assistantConversations.id, id), eq(assistantConversations.userId, userId)));
}

export async function renameConversation(userId: number, id: number, title: string) {
  const [row] = await db
    .update(assistantConversations)
    .set({ title: title.trim().slice(0, 60) || L('新对话', 'New chat') })
    .where(and(eq(assistantConversations.id, id), eq(assistantConversations.userId, userId)))
    .returning({ id: assistantConversations.id, title: assistantConversations.title });
  if (!row) throw new ActionError(L('会话不存在', 'Conversation not found'), 404);
  return row;
}

export async function deleteConversation(userId: number, id: number) {
  const rows = await db
    .delete(assistantConversations)
    .where(and(eq(assistantConversations.id, id), eq(assistantConversations.userId, userId)))
    .returning({ id: assistantConversations.id });
  if (!rows.length) throw new ActionError(L('会话不存在', 'Conversation not found'), 404);
}

const TitleSchema = z.object({ title: z.string().catch('') });

/** 根据用户的第一个问题生成简短标题；失败时保留占位标题 */
export async function generateTitle(question: string) {
  const r = await generateJson(prompt('title'), question.slice(0, 1000), TitleSchema, {
    purpose: 'title',
    shape: L('{"title": "本周账单汇总"}', '{"title": "Bills this week"}'),
    effort: 'low',
    maxTokens: 256,
  });
  return r.title
    .replace(/["“”「」。.]/g, '')
    .trim()
    .slice(0, 30);
}
