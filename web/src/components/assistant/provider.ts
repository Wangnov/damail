import { AbstractChatProvider, XRequest, type SSEOutput, type TransformMessage, type XRequestOptions } from '@ant-design/x-sdk';
import { getLocale, t } from '../../i18n';
import type { ChatInput, Msg, ServerEvent } from './types';

const CHAT_URL = '/api/admin/assistant/chat';

/** 解析一块 SSE；没有 data 的块（注释、心跳）返回 null */
export function parseEvent(chunk: SSEOutput | undefined): ServerEvent | null {
  const data = chunk?.data;
  if (typeof data !== 'string' || !data) return null;
  return JSON.parse(data) as ServerEvent;
}

/** 刚发出问题时的空回答，界面据此显示「正在思考」 */
export const emptyReply = (): Msg => ({ role: 'assistant', content: '', steps: [] });

/** 回答结束（完成、出错或停止）时收尾：去掉首尾空白，没跑完的步骤标成已停止 */
export function finishReply(m: Msg): Msg {
  return {
    ...m,
    content: m.content.trim(),
    steps: m.steps?.map((s) => (s.status === 'running' ? { ...s, status: 'error', summary: '已停止' } : s)),
  };
}

/** 把一个事件合并进回答；会话、标题这类和消息内容无关的事件原样返回 */
export function applyEvent(m: Msg, e: ServerEvent): Msg {
  switch (e.type) {
    case 'model':
      return { ...m, model: e.model, channelName: e.channelName };
    case 'thinking':
      return { ...m, thinking: (m.thinking ?? '') + e.delta };
    case 'text':
      return { ...m, content: m.content + e.delta };
    case 'tool':
      return { ...m, steps: [...(m.steps ?? []), { id: e.id, label: e.label, status: 'running' }] };
    case 'tool_done':
      return {
        ...m,
        steps: (m.steps ?? []).map((s) => (s.id === e.id ? { ...s, status: e.ok ? 'ok' : 'error', summary: e.summary, draftId: e.draftId } : s)),
      };
    case 'usage': {
      const { type: _t, ...usage } = e;
      return { ...m, usage };
    }
    case 'error':
      return { ...m, error: e.message };
    default:
      return m;
  }
}

/** 和消息内容无关的副作用（切换当前会话、刷新缓存）交给外面处理 */
export type ProviderListeners = {
  onEvent?: (e: ServerEvent) => void;
  /** 一次请求结束，不管成功、失败还是被停止 */
  onSettled?: () => void;
};

export class AssistantChatProvider extends AbstractChatProvider<Msg, ChatInput, SSEOutput> {
  // 思考用时：连续的思考增量算一段，下一个其他事件到来时结束
  private thinkStart: number | null = null;

  transformParams(requestParams: Partial<ChatInput>, options: XRequestOptions<ChatInput, SSEOutput, Msg>): ChatInput {
    this.thinkStart = null;
    return { ...options?.params, ...requestParams, content: requestParams.content ?? '' };
  }

  transformLocalMessage(requestParams: Partial<ChatInput>): Msg {
    return { role: 'user', content: requestParams.content ?? '', ...(requestParams.context ? { context: requestParams.context } : {}) };
  }

  transformMessage({ originMessage, chunk, status }: TransformMessage<Msg, SSEOutput>): Msg {
    // 第一块到来时框架会丢掉占位消息、不传 originMessage，从空回答开始
    let m = originMessage ?? emptyReply();
    const e = parseEvent(chunk);
    if (e) {
      if (e.type === 'thinking') this.thinkStart ??= Date.now();
      else if (this.thinkStart !== null) {
        m = { ...m, thinkingMs: (m.thinkingMs ?? 0) + Date.now() - this.thinkStart };
        this.thinkStart = null;
      }
      m = applyEvent(m, e);
    }
    return status === 'success' ? finishReply(m) : m;
  }
}

export function createAssistantProvider(listeners: ProviderListeners) {
  return new AssistantChatProvider({
    request: XRequest<ChatInput, SSEOutput, Msg>(CHAT_URL, {
      manual: true,
      // Content-Type 由 XRequest 默认带上，这里再写一遍会变成重复的头
      headers: { 'x-damail': '1', 'x-damail-locale': getLocale() },
      credentials: 'same-origin',
      middlewares: {
        // XRequest 遇到非 2xx 只会报「Fetch failed with status」，这里先读出后端给的错误文案
        onResponse: async (res) => {
          if (res.ok) return res;
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? t.common.requestFailed(res.status));
        },
      },
      callbacks: {
        onUpdate: (chunk) => {
          const e = parseEvent(chunk);
          if (e) listeners.onEvent?.(e);
        },
        onSuccess: () => listeners.onSettled?.(),
        onError: () => listeners.onSettled?.(),
      },
    }),
  });
}
