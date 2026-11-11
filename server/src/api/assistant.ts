import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { requireSession, type AppEnv } from '../auth/index.js';
import type { AssistantMessage, AssistantStep } from '../db/schema.js';
import { L } from '../i18n/index.js';
import { EFFORTS, getAiSettings } from '../services/ai.js';
import { runAssistant, type AssistantEvent } from '../services/assistant.js';
import { getThreadSubject } from '../services/mail.js';
import {
  createConversation,
  deleteConversation,
  generateTitle,
  getConversation,
  listConversations,
  renameConversation,
  saveMessages,
} from '../services/assistant-history.js';

const chatInput = z.object({
  conversationId: z.number().int().positive().optional(),
  content: z
    .string()
    .trim()
    .min(1, { error: () => L('消息不能为空', 'Message cannot be empty') })
    .max(20_000),
  // 对话框里临时选的模型和思考强度，不传用模型配置里的设置
  channelId: z.string().max(64).optional(),
  model: z.string().trim().max(200).optional(),
  effort: z.enum(EFFORTS).optional(),
  // 用户正在看的邮件会话，模型需要时用 get_thread 读取
  context: z.object({ threadId: z.string().min(1).max(1000) }).optional(),
});

// 主题来自邮件，是不可信内容：去掉换行和方括号，免得伪造出提示的结构
const clean = (v: string) => v.replace(/[\r\n[\]「」]+/g, ' ').slice(0, 200);

/** 发给模型的用户消息：附带的当前邮件写在问题前面 */
const withContext = (m: AssistantMessage) =>
  m.role === 'user' && m.context
    ? `[用户提问时正在看这封邮件：主题「${clean(m.context.subject)}」，threadId=${clean(m.context.threadId)}。问题里的「这封邮件」指它，需要内容时用 get_thread 读取]\n\n${m.content}`
    : m.content;

const idParam = (v: string) => z.coerce.number().int().positive().parse(v);

type StreamEvent = AssistantEvent | { type: 'conversation'; id: number; title: string } | { type: 'title'; id: number; title: string };

/** 站内 AI 助手，只对网页登录会话开放；以 SSE 推送文字增量和工具调用进度，对话存进数据库 */
export const assistantRoutes = new Hono<AppEnv>()
  .use(requireSession())
  .get('/assistant/models', async (c) => {
    // 对话框里的模型下拉：各渠道的模型，以及模型配置里助手默认用的模型
    const s = await getAiSettings();
    const followDefault = !s.assistantChannelId || s.assistantChannelId === s.channelId;
    const ch = s.channels.find((x) => x.id === (followDefault ? s.channelId : s.assistantChannelId));
    return c.json({
      channels: s.channels.map(({ id, name, provider, models }) => ({ id, name, provider, models })),
      default: {
        channelId: ch?.id ?? null,
        model: s.assistantModel || (followDefault ? s.model : (ch?.models[0] ?? s.model)),
        provider: ch?.provider ?? 'anthropic',
        effort: s.assistantEffort,
      },
    });
  })
  .get('/assistant/conversations', async (c) => c.json({ items: await listConversations(c.var.auth.userId) }))
  .get('/assistant/conversations/:id', async (c) => {
    const row = await getConversation(c.var.auth.userId, idParam(c.req.param('id')));
    return c.json({ id: row.id, title: row.title, messages: row.messages, updatedAt: row.updatedAt });
  })
  .patch('/assistant/conversations/:id', async (c) => {
    const { title } = z
      .object({
        title: z
          .string()
          .trim()
          .min(1, { error: () => L('标题不能为空', 'Title cannot be empty') })
          .max(60),
      })
      .parse(await c.req.json());
    return c.json(await renameConversation(c.var.auth.userId, idParam(c.req.param('id')), title));
  })
  .delete('/assistant/conversations/:id', async (c) => {
    await deleteConversation(c.var.auth.userId, idParam(c.req.param('id')));
    return c.json({ ok: true });
  })
  .post('/assistant/chat', async (c) => {
    const { conversationId, content, channelId, model, effort, context } = chatInput.parse(await c.req.json());
    const userId = c.var.auth.userId;
    const auth = c.var.auth;
    const isNew = !conversationId;
    // 只接受当前登录用户能看到的会话，主题以数据库为准
    const subject = context ? await getThreadSubject(auth.scope, context.threadId) : null;
    const attached = context && subject ? { threadId: context.threadId, subject } : undefined;
    const conv = conversationId ? await getConversation(userId, conversationId) : await createConversation(userId, content);
    // 用户的问题先存下来，回答中途断开也不丢
    const messages: AssistantMessage[] = [...conv.messages, { role: 'user', content, ...(attached ? { context: attached } : {}) }];
    await saveMessages(userId, conv.id, messages);

    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      stream.onAbort(() => ac.abort());
      const write = (e: StreamEvent) => {
        if (!ac.signal.aborted) void stream.writeSSE({ data: JSON.stringify(e) });
      };
      write({ type: 'conversation', id: conv.id, title: conv.title });

      // 新会话边回答边起标题，失败就保留第一句话做标题
      const titling = isNew
        ? generateTitle(content)
            .then(async (title) => {
              if (!title) return;
              await renameConversation(userId, conv.id, title);
              write({ type: 'title', id: conv.id, title });
            })
            .catch((err) => console.warn('[assistant] 生成标题失败', (err as Error).message))
        : Promise.resolve();

      // 服务端自己拼出完整回答，结束时存库
      const reply: AssistantMessage = { role: 'assistant', content: '' };
      const steps: Array<Omit<AssistantStep, 'status'> & { status: AssistantStep['status'] | 'running' }> = [];
      let thinkStart: number | null = null;
      const emit = (e: AssistantEvent) => {
        // 思考用时：连续的思考增量算一段，下一个非思考事件到来时结束
        const now = Date.now();
        if (e.type === 'thinking') {
          reply.thinking = (reply.thinking ?? '') + e.delta;
          thinkStart ??= now;
        } else if (thinkStart !== null) {
          reply.thinkingMs = (reply.thinkingMs ?? 0) + (now - thinkStart);
          thinkStart = null;
        }
        if (e.type === 'model') Object.assign(reply, { model: e.model, channelName: e.channelName });
        else if (e.type === 'usage') {
          const { type: _t, ...usage } = e;
          reply.usage = usage;
        } else if (e.type === 'text') reply.content += e.delta;
        else if (e.type === 'tool') steps.push({ id: e.id, label: e.label, status: 'running' });
        else if (e.type === 'tool_done') {
          const s = steps.find((x) => x.id === e.id);
          if (s) Object.assign(s, { status: e.ok ? 'ok' : 'error', summary: e.summary, draftId: e.draftId });
        }
        write(e);
      };

      const history = messages.filter((m) => m.content.trim() && !m.error).map((m) => ({ role: m.role, content: withContext(m) }));
      try {
        await runAssistant(auth, history, emit, ac.signal, { channelId, model, effort });
      } catch (err) {
        if (!ac.signal.aborted) {
          reply.error = (err as Error).message;
          write({ type: 'error', message: reply.error });
        }
      }
      if (ac.signal.aborted && !reply.content.trim() && !steps.length) reply.error = '已停止';
      if (thinkStart !== null) reply.thinkingMs = (reply.thinkingMs ?? 0) + (Date.now() - thinkStart);
      reply.thinking = reply.thinking?.trim() || undefined;
      reply.content = reply.content.trim();
      if (steps.length) reply.steps = steps.map((s) => (s.status === 'running' ? { ...s, status: 'error', summary: '已停止' } : (s as AssistantStep)));
      await saveMessages(userId, conv.id, [...messages, reply]);
      await titling;
      write({ type: 'done' });
    });
  });
