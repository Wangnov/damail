import type { AiEffort } from '../../api';

/** 工具调用步骤 */
export type Step = { id: string; label: string; status: 'running' | 'ok' | 'error'; summary?: string; draftId?: number };

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number | null;
  durationMs: number;
  rounds: number;
  genMs?: number;
  ttftMs?: number;
};

/** 一条对话消息；数据库里的历史记录也是这个格式，字段只能加不能改 */
/** 提问时附带的当前邮件 */
export type MsgContext = { threadId: string; subject: string };

export type Msg = {
  role: 'user' | 'assistant';
  content: string;
  context?: MsgContext;
  steps?: Step[];
  error?: string;
  model?: string;
  channelName?: string | null;
  thinking?: string;
  thinkingMs?: number;
  usage?: Usage;
};

export type ConversationSummary = { id: number; title: string; updatedAt: string };
export type ConversationDetail = ConversationSummary & { messages: Msg[] };

/** POST /api/admin/assistant/chat 的请求体 */
export type ChatInput = {
  conversationId?: number;
  content: string;
  channelId?: string;
  model?: string;
  effort?: AiEffort;
  // 服务端只用 threadId，主题以数据库为准；subject 用于本地先显示
  context?: MsgContext;
};

/** 服务端通过 SSE 推过来的事件，每块是 `data: <json>` */
export type ServerEvent =
  | { type: 'conversation'; id: number; title: string }
  | { type: 'title'; id: number; title: string }
  | { type: 'model'; model: string; channelName: string | null }
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; name: string; label: string }
  | { type: 'tool_done'; id: string; ok: boolean; summary: string; draftId?: number }
  | ({ type: 'usage' } & Usage)
  | { type: 'error'; message: string }
  | { type: 'done' };
