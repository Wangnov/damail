import { getLocale, t, type I18n, type Locale } from './i18n';
export type Address = { name?: string; address?: string; /** 通讯录里的备注名，只用于显示 */ alias?: string };

export type AttachmentMeta = {
  index: number;
  filename: string | null;
  contentType: string;
  size: number;
  cid: string | null;
  inline: boolean;
};

/** GitHub 上最新的正式版本（服务端缓存，见 server/src/services/updates.ts） */
export type LatestRelease = { tag: string; name: string; url: string; publishedAt: string | null; body: string };
export type UpdateStatus = { enabled: boolean; repo: string; latest: LatestRelease | null; checkedAt: string | null; error: string | null };

export type AccountSummary = {
  id: number;
  name: string;
  email: string;
  provider: string;
  color: string | null;
  enabled: boolean;
  status: 'connecting' | 'syncing' | 'idle' | 'error' | 'disabled';
  lastError: string | null;
  lastSyncAt: string | null;
  inboxUnread: number;
  messageCount: number;
};

export type Account = {
  id: number;
  name: string;
  email: string;
  displayName: string | null;
  /** 写信时附在正文后的签名 */
  signatureHtml: string | null;
  provider: string;
  color: string | null;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean | null;
  username: string;
  /** password | oauth2 */
  authType: string;
  /** imap：IMAP/SMTP 收发信；graph：微软 Graph API */
  protocol: 'imap' | 'graph';
  syncSinceDays: number;
  /** 轮询间隔（秒），null 用默认 */
  pollIntervalSec: number | null;
  proxyId: number | null;
  enabled: boolean;
  status: AccountSummary['status'];
  lastError: string | null;
  lastSyncAt: string | null;
};

export type Folder = {
  id: number;
  accountId: number;
  path: string;
  name: string;
  specialUse: string | null;
  syncEnabled: boolean;
  totalCount: number;
  unreadCount: number;
  localCount: number;
  lastSyncAt: string | null;
};

export type ThreadSummary = {
  threadId: string;
  latestMessageId: number;
  subject: string;
  snippet: string;
  from: { name: string | null; address: string | null };
  participants: string[];
  lastDate: string;
  messageCount: number;
  unread: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  accountIds: number[];
  insight: InsightBrief | null;
  // 会话里各封邮件的标签合在一起
  labels: LabelBrief[];
  // 只在「等回复」视图里有
  waiting?: WaitingInfo;
};

/** 标签（分类之外的细分，见 docs/labels.md）。name / description 是请求时界面语言的；names / i18n 是所有语言的，切换语言时用 pickText 取 */
export type LabelText = { name: string; description: string };
export type LabelBrief = { id: number; name: string; names: I18n<string>; color: string };
export type Label = LabelBrief & {
  description: string;
  i18n: I18n<LabelText>;
  pinned: boolean;
  source: 'manual' | 'suggested';
  total: number;
  unread: number;
};
export type LabelAdmin = Label & { createdAt: string; updatedAt: string };
export type LabelSuggestion = {
  id: number;
  name: string;
  description: string;
  reason: string;
  i18n: I18n<LabelText & { reason: string }>;
  color: string;
  count: number;
  examples: Array<{ id: number; threadId: string; subject: string; from: string | null; date: string }>;
};
export type LabelSuggestRun = {
  status: 'queued' | 'running' | 'done' | 'failed';
  error: string | null;
  tooFew: boolean;
  createdAt: string;
  finishedAt: string | null;
};

/** 系统内置的分类（只读） */
export type CategoryText = { name: string; description: string };
export type Category = CategoryText & { key: string; i18n: I18n<CategoryText>; color: string; builtin: boolean };

/** 系统内置的提示词（只读） */
export type PromptItem = {
  key: string;
  purpose: string;
  title: I18n<string>;
  description: I18n<string>;
  vars: string[];
  text: I18n<string>;
  builtin: boolean;
  updatedAt?: string;
};

/** open 等待中 / due 已到期提醒 / replied 已收到回复 / done 不用再等 */
export type FollowUpBrief = { id: number; status: 'open' | 'due' | 'replied' | 'done'; dueAt: string | null };
export type WaitingInfo = {
  messageId: number;
  to: { name: string | null; address: string | null };
  sentAt: string;
  baselineHours: number | null;
  followUp: FollowUpBrief | null;
};

export type Priority = 'high' | 'normal' | 'low';
export type InsightBrief = { category: string; priority: Priority; needsReply: boolean; hasCode: boolean };
export type Insight = {
  category: string;
  priority: Priority;
  summary: string;
  needsReply: boolean;
  extracted: {
    codes: string[];
    amounts: { value: number; currency: string; label?: string }[];
    dueDate: string | null;
    trackingNumbers: string[];
    actionItems: string[];
  };
  model: string;
  createdAt: string;
};

export type MessageDetail = {
  id: number;
  threadId: string;
  accountId: number;
  accountEmail: string;
  folder: string;
  folderSpecialUse: string | null;
  messageId: string | null;
  subject: string;
  from: { name: string | null; address: string | null };
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  date: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  text: string | null;
  html: string | null;
  attachments: AttachmentMeta[];
  truncated: boolean;
  size: number;
  insight: Insight | null;
  labels: LabelBrief[];
  // 只在会话详情里有
  followUp?: FollowUpBrief | null;
  unsubscribe?: UnsubscribeInfo | null;
  // 当前目标语言的译文，没翻译过是 null
  translation?: Translation | null;
};

// html 是只替换了文字的原邮件 HTML，纯文本邮件为 null
export type Translation = { language: string; subject: string; body: string; html: string | null; model: string; createdAt: string };

/** one-click 按 RFC 8058 直接请求；mailto 发一封退订邮件；link 只能打开网页退订 */
export type UnsubscribeMethod = 'one-click' | 'mailto' | 'link';
/** fromBody：发件人没提供 List-Unsubscribe 头，退订链接是从正文里找到的 */
export type UnsubscribeInfo = { method: UnsubscribeMethod; url?: string; fromBody?: boolean; unsubscribed: { status: string; at: string } | null };
export type UnsubscribeResult = { method: UnsubscribeMethod; status: 'done' | 'unconfirmed' | 'opened'; message: string; url?: string; draftId?: number };
export type ContactRow = {
  address: string;
  name: string | null;
  alias: string | null;
  received: number;
  sent: number;
  lastDate: string | null;
  ignored: boolean;
};
export type IgnoredSender = { pattern: string; createdAt: string };

export type SubscriptionRow = {
  accountId: number;
  listKey: string;
  name: string;
  address: string | null;
  count: number;
  unread: number;
  lastDate: string;
  latestMessageId: number;
  threadId: string;
  oneClick: boolean;
  method: UnsubscribeMethod;
  fromBody?: boolean;
  url?: string;
  unsubscribed: { method: string; status: string; at: string } | null;
};

export type SubscriptionFilter = 'all' | 'ignored' | 'unsubscribed';
export type SubscriptionPage = { items: SubscriptionRow[]; total: number; counts: Record<SubscriptionFilter, number> };

export type Thread = { threadId: string; subject: string; messages: MessageDetail[] };

export type Provider = {
  id: string;
  name: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  usernameIsEmail: boolean;
  secretLabel: string;
  help: string;
  requiresOAuth?: boolean;
  domains: string[];
};

export type ApiKey = {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  accountIds: number[] | null;
  lastUsedAt: string | null;
  createdAt: string;
  /** 加密保存了完整密钥，可以随时复制 */
  copyable: boolean;
};

/** ChatGPT 等 MCP 客户端通过 OAuth 获得的授权 */
export type McpAuthorization = {
  id: number;
  clientId: string;
  clientName: string | null;
  scopes: string[];
  accounts: { id: number; email: string | null }[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
};

export type McpOAuthInfo = {
  enabled: boolean;
  issuer: string;
  resource: string;
  resourceMetadata: string | null;
  clients: string[];
  redirectUris: string[];
  scopes: { name: string; label: string; description: string }[];
  sendLimitPerHour: number;
  settings: McpOAuthSettings & { source: 'env' | 'web' };
};

/** 允许连接 MCP 的 OAuth 客户端：CIMD（client_id 是元数据文档 URL，如 ChatGPT）或预注册的公共客户端 */
export type McpOAuthClient = { type: 'cimd' | 'static'; clientId: string; name: string | null; redirectUris: string[] };

export type McpOAuthSettings = {
  enabled: boolean;
  clients: McpOAuthClient[];
  fetchProxyId: number | null;
  sendLimitPerHour: number;
  scopeChallenge: 'http' | 'tool';
};

/** 读取 CIMD 元数据文档的结果 */
export type McpOAuthClientDoc = {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  authMethod: string | null;
  jwksUri: string | null;
  problems: string[];
};

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';
export type DraftStatus = 'draft' | 'pending' | 'queued' | 'sending' | 'sent' | 'failed' | 'rejected';
export type DraftAttachment = { path: string; filename: string; contentType: string; size: number };

export type Draft = {
  id: number;
  accountId: number;
  mode: ComposeMode;
  sourceMessageId: number | null;
  threadId: string | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  body: string;
  bodyHtml: string | null;
  /** rich：可视化编辑；html：HTML 源码，原样发出 */
  bodyFormat: 'rich' | 'html';
  includeSignature: boolean;
  includeQuote: boolean;
  quoteText: string | null;
  attachments: DraftAttachment[];
  status: DraftStatus;
  source: 'web' | 'api' | 'mcp' | 'rule' | 'assistant';
  note: string | null;
  error: string | null;
  sendAt: string | null;
  sentAt: string | null;
  followUpDays: number | null;
  /** 内容版本号，批准待审批邮件时用来确认审的就是要发的那份 */
  revision: number;
  updatedAt: string;
  sendDelaySec?: number;
};

export type DraftSummary = Pick<
  Draft,
  | 'id'
  | 'accountId'
  | 'mode'
  | 'sourceMessageId'
  | 'threadId'
  | 'to'
  | 'cc'
  | 'bcc'
  | 'subject'
  | 'status'
  | 'source'
  | 'note'
  | 'error'
  | 'sendAt'
  | 'sentAt'
  | 'updatedAt'
> & { accountEmail: string; snippet: string; attachmentCount: number };

export type RuleCondition = { field: string; op: string; value?: string | boolean };
export type RuleAction = { type: string; folderId?: number; channelId?: number; instruction?: string };
export type Rule = {
  id: number;
  name: string;
  enabled: boolean;
  position: number;
  accountIds: number[] | null;
  match: 'all' | 'any';
  conditions: RuleCondition[];
  actions: RuleAction[];
  stopProcessing: boolean;
  matchCount: number;
  lastMatchedAt: string | null;
};
export type RuleTestResult = {
  scanned: number;
  analyzed: number;
  matched: number;
  note?: string;
  samples: { id: number; threadId: string; account: string; from: string; subject: string; date: string; category: string | null }[];
};

export type Channel = {
  id: number;
  name: string;
  type: 'bark' | 'wecom' | 'dingtalk' | 'feishu' | 'telegram' | 'webhook';
  config: Record<string, string>;
  events: string[];
  enabled: boolean;
  createdAt: string;
};
export type ChannelDelivery = {
  id: number;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  error: string | null;
  event: string;
  title: string;
  createdAt: string;
  finishedAt: string | null;
};

export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AiProvider = 'anthropic' | 'openai';

/** 美元 / 百万 tokens */
export type ModelPrice = { input: number; output: number; cacheRead?: number | null; cacheWrite?: number | null };

export type AiChannel = {
  id: string;
  name: string;
  provider: AiProvider;
  baseUrl: string | null;
  models: string[];
  modelsSyncedAt: string | null;
  prices: Record<string, ModelPrice>;
  priceRate: number;
  /** 同时进行的请求上限，null 表示不限制 */
  concurrency: number | null;
  hasApiKey: boolean;
  apiKeyHint: string | null;
};

/** 渠道的实时状态（服务端内存里的，重启后清零） */
export type AiChannelStatus = {
  active: number;
  waiting: number;
  /** 限流暂停到什么时候；没在暂停时为 null */
  pausedUntil: string | null;
  limitedAt: string | null;
  limitedCount: number;
};

export type AiSettings = {
  enabled: boolean;
  channels: AiChannel[];
  channelId: string;
  model: string;
  effort: AiEffort;
  assistantChannelId: string | null;
  assistantModel: string | null;
  assistantEffort: AiEffort | null;
  translateChannelId: string | null;
  translateModel: string | null;
  translateLanguage: string;
  hasApiKey: boolean;
  categories: string[];
  categoryLabels: Record<string, string>;
};

export type AiPurpose = 'classify' | 'reply' | 'report' | 'search' | 'title' | 'assistant' | 'translate' | 'labels' | 'test';

export type AiRequestRow = {
  id: number;
  purpose: AiPurpose;
  channelId: string | null;
  channelName: string | null;
  provider: AiProvider;
  model: string;
  ok: boolean;
  error: string | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cost: number | null;
  createdAt: string;
};

export type AiUsageAgg = {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  avgMs: number;
  cost: number;
  // 有用量但没有价格、没算进费用的请求数
  unpriced: number;
};

export type AiStatsRange = 1 | 7 | 30 | 90;

export type AiStats = {
  days: AiStatsRange;
  bucket: 'hour' | 'day';
  start: string;
  totals: AiUsageAgg;
  prev: AiUsageAgg;
  series: Array<AiUsageAgg & { key: string }>;
  byModel: Array<AiUsageAgg & { key: string }>;
  byPurpose: Array<AiUsageAgg & { key: AiPurpose }>;
  byChannel: Array<AiUsageAgg & { key: string | null; name: string | null }>;
};

export type BatchAction = 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'trash' | 'inbox' | 'junk' | 'move' | 'delete';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** 每个请求都带上当前界面语言，后端的报错、标签等按它返回 */
const baseHeaders = () => ({ 'x-damail': '1', 'x-damail-locale': getLocale() });

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: {
      ...baseHeaders(),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? t.common.requestFailed(res.status), res.status);
  return data as T;
}

export function attachmentUrl(messageId: number, index: number, inline = false) {
  return `/api/v1/messages/${messageId}/attachments/${index}${inline ? '?inline=1' : ''}`;
}

export type ThreadBatchAction = 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'trash' | 'delete';

/** 按会话批量操作，服务端决定每个会话里具体处理哪些邮件 */
export function threadBatchAction(threadIds: string[], action: ThreadBatchAction) {
  return api<{ updated?: number; moved?: number; deleted?: number; destination?: string }>('/api/v1/threads/batch', {
    method: 'POST',
    body: { threadIds, action },
  });
}

export function batchAction(ids: number[], action: BatchAction, folderId?: number) {
  return api<{ updated?: number; moved?: number; deleted?: number; destination?: string }>('/api/v1/messages/batch', {
    method: 'POST',
    body: { ids, action, folderId },
  });
}

export async function uploadDraftAttachment(draftId: number, file: File): Promise<Draft> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/v1/drafts/${draftId}/attachments`, {
    method: 'POST',
    headers: baseHeaders(),
    body: form,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? t.common.uploadFailed(res.status), res.status);
  return data as Draft;
}

export type ReportKind = 'daily' | 'weekly';
export type ReportItem = { id: number; threadId: string; subject: string; from: string; summary: string | null; date: string; accountId: number };
export type ReportData = {
  until: string;
  received: number;
  receivedPrev: number;
  sent: number;
  unreadNow: number;
  analyzed: number;
  verificationCount: number;
  byAccount: Array<{ accountId: number; name: string; email: string; received: number; sent: number }>;
  byCategory: Array<{ category: string; label: string; count: number }>;
  byDay: Array<{ date: string; received: number; sent: number }>;
  topSenders: Array<{ name: string; address: string; count: number }>;
  important: ReportItem[];
  needsReply: ReportItem[];
  bills: Array<ReportItem & { amount: string | null; dueDate: string | null }>;
  drafts: { sent: number; failed: number; pending: number };
};
export type ReportSummary = { id: number; kind: ReportKind; title: string; periodStart: string; periodEnd: string; createdAt: string; received: number };
export type Report = ReportSummary & { data: ReportData; summary: string | null; summaryError: string | null };
export type ReportSettings = {
  daily: { enabled: boolean; hour: number };
  weekly: { enabled: boolean; hour: number };
  aiSummary: boolean;
};

export type AnalyticsRange = 7 | 30 | 90 | 365;
export type Analytics = {
  days: AnalyticsRange;
  start: string;
  until: string;
  bucket: 'day' | 'week';
  totals: { received: number; receivedPrev: number; sent: number; sentPrev: number; senders: number; analyzed: number; needsReply: number; replied: number };
  series: Array<{ date: string; received: number; sent: number }>;
  /** [星期 0=周日][小时] */
  heatmap: number[][];
  categories: Array<{ category: string; label: string; count: number; unread: number }>;
  senders: Array<{ address: string; name: string; count: number; unread: number; last: string }>;
  domains: Array<{ domain: string; count: number }>;
  accounts: Array<{ accountId: number; name: string; email: string; received: number; sent: number }>;
  backlog: { d1: number; d7: number; d30: number; older: number };
};

export type SemanticItem = {
  id: number;
  threadId: string;
  accountId: number;
  accountEmail: string;
  folder: string;
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  date: string;
  snippet: string;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  category: string | null;
  priority: Priority | null;
  summary: string | null;
  reason: string;
};
export type SemanticSearchResult = {
  intent: string;
  filters: string;
  keywords: string[][];
  relaxed: 'none' | 'keywords' | 'filters';
  candidates: number;
  items: SemanticItem[];
};

export type OAuthProvider = 'microsoft' | 'google';
export type OAuthConfig = { clientId: string; tenant: string; hasSecret: boolean; secretHint: string | null; redirectUri: string; proxyId: number | null };

export type ProxyProtocol = 'http' | 'https' | 'socks5' | 'socks4';

export type ProxyItem = {
  id: number;
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  hasPassword: boolean;
  /** 使用这个代理的邮箱数 */
  accountCount: number;
};

export type ProxyTestResult = { ok: true; ms: number } | { ok: false; error: string };

export type CurrentUser = { id: number; username: string; locale: Locale };

/** 保存界面语言到账号（换设备也一样，通知、报告、AI 回答也按它生成） */
export const saveLocale = (locale: Locale) => api<CurrentUser>('/api/auth/locale', { method: 'PUT', body: { locale } });
