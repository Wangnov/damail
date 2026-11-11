import { useXChat, type SSEOutput } from '@ant-design/x-sdk';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { createAssistantProvider, emptyReply, finishReply, type AssistantChatProvider } from './provider';
import type { ChatInput, ConversationDetail, ConversationSummary, Msg, ServerEvent } from './types';

export const LIST_KEY = ['assistant-conversations'];
const ACTIVE_KEY = 'damail.assistant.active';

export function readLocal(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 只是记住界面状态，存不下不影响使用
  }
}

/** 直接改 React Query 缓存里的会话标题，不用重新拉列表 */
export function setConversationTitle(qc: QueryClient, id: number, title: string) {
  qc.setQueryData<{ items: ConversationSummary[] }>(LIST_KEY, (d) => d && { items: d.items.map((c) => (c.id === id ? { ...c, title } : c)) });
}

/**
 * useXChat 的 conversationKey。每次进入一个会话都换一个新 key：
 * - 切回某个会话时会重新建 store、从接口拉最新的历史（服务端可能已经存下了被中止的回答）
 * - 被丢下的旧请求只会写进旧 key 的 store，不会串到当前会话
 * - 新对话收到会话 id 后 key 不变，本地已有的消息不用重新拉
 */
let keySeq = 0;
const keyFor = (id: number | null) => `${id ?? 'new'}:${++keySeq}`;
/** key 创建时对应的会话 id；新对话是 null，之后拿到 id 也不变 */
const initialIdOf = (key: string) => Number(key.split(':')[0]) || null;

type Active = { key: string; id: number | null };
export type SendOptions = Pick<ChatInput, 'channelId' | 'model' | 'effort' | 'context'>;
export type ChatItem = { key: string | number; msg: Msg; streaming: boolean };

export function useAssistantChat() {
  const qc = useQueryClient();
  const [active, setActive] = useState<Active>(() => {
    const id = Number(readLocal(ACTIVE_KEY)) || null;
    return { key: keyFor(id), id };
  });
  // 事件回调是异步来的，用 ref 读最新的当前会话
  const activeRef = useRef(active);
  activeRef.current = active;
  const activate = (next: Active) => {
    activeRef.current = next;
    setActive(next);
  };

  // 每个会话 key 一个 Provider：请求、中止和思考计时互不干扰
  const providers = useRef(new Map<string, AssistantChatProvider>());
  const getProvider = (key: string) => {
    let p = providers.current.get(key);
    if (!p) {
      const onEvent = (e: ServerEvent) => {
        if (e.type === 'conversation') {
          // 只有还停留在这个新对话上时才切过去
          const cur = activeRef.current;
          if (cur.key === key && cur.id === null) activate({ key, id: e.id });
          void qc.invalidateQueries({ queryKey: LIST_KEY });
        } else if (e.type === 'title') setConversationTitle(qc, e.id, e.title);
        else if (e.type === 'tool_done' && e.draftId) void qc.invalidateQueries({ queryKey: ['drafts'] });
      };
      p = createAssistantProvider({ onEvent, onSettled: () => void qc.invalidateQueries({ queryKey: LIST_KEY }) });
      providers.current.set(key, p);
    }
    return p;
  };

  const chat = useXChat<Msg, Msg, ChatInput, SSEOutput>({
    provider: getProvider(active.key),
    conversationKey: active.key,
    defaultMessages: async (info: { conversationKey?: string }) => {
      const key = info.conversationKey ?? '';
      const id = initialIdOf(key);
      if (!id) return [];
      try {
        const c = await api<ConversationDetail>(`/api/admin/assistant/conversations/${id}`);
        return c.messages.map((message) => ({ message }));
      } catch {
        // 会话被删了（比如在别的设备上），回到新对话
        if (activeRef.current.key === key) switchTo(null);
        return [];
      }
    },
    requestPlaceholder: emptyReply,
    // 出错和用户停止都走这里；messageInfo 是正在更新的那条回答
    requestFallback: (_, { error, messageInfo }) => {
      const m = messageInfo?.message ?? emptyReply();
      if (error.name !== 'AbortError') return finishReply({ ...m, error: error.message });
      return finishReply(m.content || m.steps?.length ? m : { ...m, error: '已停止' });
    },
  });
  const busy = chat.isRequesting;

  useEffect(() => writeLocal(ACTIVE_KEY, active.id ? String(active.id) : null), [active.id]);
  // 旧版本存在浏览器里的对话已经不用了
  useEffect(() => writeLocal('damail.assistant', null), []);

  /** 切换会话时丢掉正在进行的回答（服务端会把已生成的部分存下来） */
  const switchTo = (id: number | null) => {
    const cur = activeRef.current;
    const p = providers.current.get(cur.key);
    // 点的就是当前会话：只停掉回答，不重新加载
    if (id !== null && id === cur.id) {
      if (p?.request.isRequesting) p.request.abort();
      return;
    }
    if (p?.request.isRequesting) p.request.abort();
    providers.current.delete(cur.key);
    activate({ key: keyFor(id), id });
  };

  /** 发送成功返回 true，界面据此清空输入框 */
  const send = (text: string, opts: SendOptions = {}) => {
    const content = text.trim();
    if (!content || busy) return false;
    chat.onRequest({ conversationId: active.id ?? undefined, content, ...opts });
    return true;
  };

  const stop = () => {
    if (busy) chat.abort();
  };

  const messages: ChatItem[] = chat.messages.map(({ id, message, status }) => ({
    key: id,
    msg: message,
    streaming: status === 'loading' || status === 'updating',
  }));

  return {
    activeId: active.id,
    messages,
    busy,
    // 新对话的 store 也会异步初始化一下，不算加载历史，免得闪一下加载圈
    loading: chat.isDefaultMessagesRequesting && initialIdOf(active.key) !== null,
    send,
    stop,
    switchTo,
  };
}
