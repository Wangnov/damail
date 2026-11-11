import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, type AccountSummary, type Category, type DraftSummary, type Folder, type Label, type PromptItem, type ProxyItem } from '../api';
import { setCategoryCatalog } from '../components/Insight';

export function useAccounts() {
  return useQuery({ queryKey: ['accounts'], queryFn: () => api<AccountSummary[]>('/api/v1/accounts') });
}

export function useFolders() {
  return useQuery({ queryKey: ['folders'], queryFn: () => api<Folder[]>('/api/v1/folders') });
}

export type Stats = {
  receivedToday: number;
  importantUnread: number;
  inboxUnreadTotal: number;
  followUpsDue: number;
  unreadTotal: number;
  starredTotal: number;
  sentTotal: number;
  allTotal: number;
  waitingTotal: number;
  draftsTotal: number;
  // AI 分类 → 总数 / 未读，没有邮件的分类不在里面
  categories: Record<string, { total: number; unread: number }>;
  // 标签 id → 总数 / 未读
  labels: Record<string, { total: number; unread: number }>;
};

export function useStats() {
  return useQuery({ queryKey: ['stats'], queryFn: () => api<Stats>('/api/v1/stats') });
}

/** 标签列表（侧栏、邮件详情加标签、规则条件共用） */
export function useLabels() {
  return useQuery({ queryKey: ['labels'], queryFn: () => api<Label[]>('/api/v1/labels') });
}

/** 系统内置的分类（只读）；拿到后分类名称改用服务端的（含所有语言） */
export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: async () => {
      const list = await api<Category[]>('/api/v1/categories');
      setCategoryCatalog(list);
      return list;
    },
    staleTime: Infinity,
  });
}

/** 系统内置的提示词（只读） */
export function usePrompts() {
  return useQuery({ queryKey: ['prompts'], queryFn: () => api<PromptItem[]>('/api/admin/prompts'), staleTime: Infinity });
}

export function useProxies() {
  return useQuery({ queryKey: ['proxies'], queryFn: () => api<ProxyItem[]>('/api/admin/proxies') });
}

/** 邮箱、OAuth 应用选代理用的下拉选项 */
export function useProxyOptions() {
  const proxies = useProxies();
  return (proxies.data ?? []).map((p) => ({ value: p.id, label: `${p.name}（${p.protocol}://${p.host}:${p.port}）` }));
}

export function usePendingDrafts() {
  return useQuery({ queryKey: ['drafts', 'pending'], queryFn: () => api<DraftSummary[]>('/api/v1/drafts?status=pending') });
}

/** 按状态列出草稿（逗号分隔多个状态）；草稿页和侧栏的数量共用这份缓存 */
export function useDraftList(status: string) {
  return useQuery({ queryKey: ['drafts', 'list', status], queryFn: () => api<DraftSummary[]>(`/api/v1/drafts?status=${status}`) });
}

/** 订阅服务端 SSE：有新邮件或状态变化时刷新相关查询 */
export function useLiveEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    let timer: number | undefined;
    let retryTimer: number | undefined;
    let retries = 0;
    let connected = false;
    let disposed = false;
    const pending = new Set<string>();
    const schedule = (...keys: string[]) => {
      keys.forEach((k) => pending.add(k));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        for (const k of pending) void qc.invalidateQueries({ queryKey: [k] });
        pending.clear();
      }, 600);
    };

    // 服务端每 25 秒发一次 ping；代理没把断开传过来时连接看着还在，其实已经收不到事件
    let lastSeen = Date.now();
    const seen = () => (lastSeen = Date.now());
    const watchdog = window.setInterval(() => {
      if (es && es.readyState !== EventSource.CLOSED && Date.now() - lastSeen > 60_000) {
        es.close();
        connect();
      }
    }, 15_000);

    const connect = () => {
      seen();
      es = new EventSource('/api/v1/events');
      es.addEventListener('ping', seen);
      es.addEventListener('message', seen);
      es.addEventListener('ready', () => {
        seen();
        // 断开期间漏掉的事件没法补发，重连上以后整体刷新一次
        if (connected || retries) schedule('threads', 'thread', 'accounts', 'folders', 'stats', 'drafts', 'draft');
        connected = true;
        retries = 0;
      });
      // 服务重启时代理会返回 502，浏览器收到错误状态就不再自动重连，这里自己重建
      es.addEventListener('error', () => {
        if (es?.readyState !== EventSource.CLOSED || disposed) return;
        es.close();
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** retries++));
      });
      es.addEventListener('messages.new', () => (seen(), schedule('threads', 'thread', 'accounts', 'folders', 'stats')));
      es.addEventListener('messages.updated', () => (seen(), schedule('threads', 'thread', 'accounts', 'folders', 'stats')));
      es.addEventListener('account.status', () => (seen(), schedule('accounts', 'folders')));
      es.addEventListener('followups.updated', () => (seen(), schedule('threads', 'thread', 'stats')));
      es.addEventListener('drafts.updated', (e) => {
        seen();
        schedule('drafts', 'draft', 'stats');
        // 写信组件据此提示「已发送 / 发送失败」
        window.dispatchEvent(new CustomEvent('damail:draft', { detail: JSON.parse((e as MessageEvent).data) }));
      });
    };
    connect();
    return () => {
      disposed = true;
      window.clearInterval(watchdog);
      window.clearTimeout(timer);
      window.clearTimeout(retryTimer);
      es?.close();
    };
  }, [qc]);
}
