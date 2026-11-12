import { sql } from 'drizzle-orm';
import { bigint, boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { I18n } from '../i18n/context.js';

export type Address = { name?: string; address?: string };
export type AttachmentMeta = {
  index: number;
  filename: string | null;
  contentType: string;
  size: number;
  cid: string | null;
  inline: boolean;
};

/** 邮件列表的退订信息（List-Unsubscribe / List-Unsubscribe-Post / List-Id）；空对象表示没有 */
export type ListInfo = {
  id?: string;
  name?: string;
  http?: string;
  mailto?: string;
  oneClick?: boolean;
  /** http 来自正文里的退订链接，而不是 List-Unsubscribe 头 */
  source?: 'body';
  /** 按第几版规则找过正文里的退订链接 */
  bodyScan?: number;
};

export const users = pgTable('users', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  username: text().notNull().unique(),
  passwordHash: text().notNull(),
  // 界面语言（zh-CN / en），也决定通知、报告、AI 回答等用哪种语言
  locale: text().notNull().default('zh-CN'),
  // 退出登录时加一，之前签发的会话（包括被复制走的 cookie）全部失效
  sessionEpoch: integer().notNull().default(0),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  userId: integer()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  prefix: text().notNull(),
  keyHash: text().notNull().unique(),
  // MASTER_KEY 加密的完整密钥，用于列表里复制；早期创建的只有哈希，为 null
  keyEnc: text(),
  // read | draft | send | admin（P0 只用到 read）
  scopes: text()
    .array()
    .notNull()
    .default(sql`ARRAY['read']::text[]`),
  // null 表示可访问全部账户
  accountIds: integer().array(),
  lastUsedAt: timestamp({ withTimezone: true }),
  revokedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * ChatGPT 等 MCP 客户端通过 OAuth 获得的授权（DaMail 作为授权服务器签发给客户端）。
 * 和邮件服务商（Gmail / Microsoft）发给 DaMail 的 OAuth 令牌是两条完全独立的链路。
 * 一条记录对应 oidc-provider 的一个 Grant；撤销后该授权下的 access / refresh token 全部失效。
 */
export const mcpAuthorizations = pgTable(
  'mcp_authorizations',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    grantId: text().notNull().unique(),
    userId: integer()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text().notNull(),
    clientName: text(),
    // 签发令牌的 audience（MCP 资源的 canonical URI）
    resource: text().notNull(),
    // 用户在同意页实际勾选的权限，如 mail:read mail:draft
    scopes: text().array().notNull(),
    // 用户选择的邮箱范围，null 表示全部邮箱
    accountIds: integer().array(),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    // user 用户撤销 / replay 检测到授权码或 refresh token 重放 / grant 授权服务器撤销
    revokeReason: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mcp_authorizations_user').on(t.userId, t.createdAt)],
);

export type McpAuthorization = typeof mcpAuthorizations.$inferSelect;

/**
 * oidc-provider 的持久化存储（授权码、access / refresh token、Grant、交互、会话）。
 * id 只存 SHA-256 摘要，payload 里也去掉了令牌值（jti），数据库泄露不能直接拿来用。
 */
export const oauthPayloads = pgTable(
  'oauth_payloads',
  {
    model: text().notNull(),
    idHash: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    grantId: text(),
    uid: text(),
    expiresAt: timestamp({ withTimezone: true }),
    consumedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.model, t.idHash] }),
    index('oauth_payloads_grant').on(t.grantId),
    index('oauth_payloads_uid').on(t.model, t.uid),
    index('oauth_payloads_expires').on(t.expiresAt),
  ],
);

// 邮箱连接用的代理，密码加密保存
export const proxies = pgTable('proxies', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text().notNull(),
  // http | https | socks5 | socks4
  protocol: text().notNull(),
  host: text().notNull(),
  port: integer().notNull(),
  username: text(),
  passwordEnc: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable('accounts', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text().notNull(),
  email: text().notNull(),
  // 发信时的发件人名称
  displayName: text(),
  provider: text().notNull().default('custom'),
  color: text(),
  imapHost: text().notNull(),
  imapPort: integer().notNull().default(993),
  imapSecure: boolean().notNull().default(true),
  smtpHost: text(),
  smtpPort: integer(),
  smtpSecure: boolean(),
  username: text().notNull(),
  authType: text().notNull().default('password'),
  // imap：IMAP 收信、SMTP 发信；graph：微软 Graph API 收发信（imap/smtp 字段不再使用）
  protocol: text().notNull().default('imap'),
  secretEnc: text().notNull(),
  syncSinceDays: integer().notNull().default(90),
  // 轮询间隔（秒），null 表示用 POLL_INTERVAL_SEC 的默认值；IMAP 收件箱另有 IDLE 实时推送
  pollIntervalSec: integer(),
  // 写信时附在正文后面的签名（HTML），为空表示不用签名
  signatureHtml: text(),
  // IMAP、SMTP 和 OAuth 刷新令牌都走这个代理，为空表示直连
  proxyId: integer().references(() => proxies.id, { onDelete: 'set null' }),
  enabled: boolean().notNull().default(true),
  // connecting | syncing | idle | error | disabled
  status: text().notNull().default('connecting'),
  lastError: text(),
  lastSyncAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const folders = pgTable(
  'folders',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    path: text().notNull(),
    name: text().notNull(),
    delimiter: text(),
    specialUse: text(),
    syncEnabled: boolean().notNull().default(false),
    uidValidity: bigint({ mode: 'bigint' }),
    lastUid: bigint({ mode: 'number' }).notNull().default(0),
    highestModseq: bigint({ mode: 'bigint' }),
    // Graph 账户：文件夹 ID 和增量同步游标
    remoteId: text(),
    deltaLink: text(),
    totalCount: integer().notNull().default(0),
    unreadCount: integer().notNull().default(0),
    lastSyncAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex('folders_account_path').on(t.accountId, t.path)],
);

export const messages = pgTable(
  'messages',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    folderId: integer()
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    // Graph 账户没有 UID，由本地按文件夹递增分配
    uid: bigint({ mode: 'number' }).notNull(),
    // Graph 账户的邮件 ID（ImmutableId，移动文件夹后不变）
    remoteId: text(),
    messageId: text(),
    threadId: text().notNull(),
    inReplyTo: text(),
    references: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    subject: text().notNull().default(''),
    fromName: text(),
    fromAddress: text(),
    to: jsonb().$type<Address[]>().notNull().default([]),
    cc: jsonb().$type<Address[]>().notNull().default([]),
    replyTo: jsonb().$type<Address[]>().notNull().default([]),
    date: timestamp({ withTimezone: true }).notNull(),
    snippet: text().notNull().default(''),
    textBody: text(),
    htmlBody: text(),
    attachments: jsonb().$type<AttachmentMeta[]>().notNull().default([]),
    hasAttachments: boolean().notNull().default(false),
    flags: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    seen: boolean().notNull().default(false),
    flagged: boolean().notNull().default(false),
    answered: boolean().notNull().default(false),
    size: integer().notNull().default(0),
    truncated: boolean().notNull().default(false),
    rawPath: text(),
    // null 表示还没解析（旧邮件由后台补算）
    listInfo: jsonb().$type<ListInfo>(),
    searchText: text().notNull().default(''),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('messages_folder_uid').on(t.folderId, t.uid),
    index('messages_account_date').on(t.accountId, t.date.desc()),
    index('messages_date').on(t.date.desc()),
    index('messages_thread').on(t.threadId),
    index('messages_message_id').on(t.accountId, t.messageId),
    index('messages_remote_id').on(t.accountId, t.remoteId),
    index('messages_references').using('gin', t.references),
    index('messages_search_trgm').using('gin', sql`${t.searchText} gin_trgm_ops`),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type Proxy = typeof proxies.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;

/** 草稿附件存放在 data/uploads；转发时会把原邮件附件复制过来，原邮件之后被移动也不受影响 */
export type DraftAttachment = { path: string; filename: string; contentType: string; size: number };

/**
 * 草稿与发件箱。状态流转：
 * draft → pending（Agent 提交，等待网页审批）→ queued（到 sendAt 后发送，期间可撤销）→ sending → sent / failed
 */
export const drafts = pgTable(
  'drafts',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // new | reply | replyAll | forward
    mode: text().notNull().default('new'),
    sourceMessageId: bigint({ mode: 'number' }).references(() => messages.id, { onDelete: 'set null' }),
    threadId: text(),
    inReplyTo: text(),
    references: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    to: jsonb().$type<Address[]>().notNull().default([]),
    cc: jsonb().$type<Address[]>().notNull().default([]),
    bcc: jsonb().$type<Address[]>().notNull().default([]),
    subject: text().notNull().default(''),
    // 用户撰写的纯文本正文；引用的原文在发送时拼接
    body: text().notNull().default(''),
    // 网页富文本编辑器的 HTML 正文；为空时按纯文本 body 生成 HTML
    bodyHtml: text(),
    // rich：可视化编辑器写的；html：HTML 源码模式，原样发出，不再加样式
    bodyFormat: text().notNull().default('rich'),
    // 发送时在正文后附上发件邮箱的签名
    includeSignature: boolean().notNull().default(true),
    includeQuote: boolean().notNull().default(true),
    // 创建时快照的引用原文（原邮件之后可能被移动或删除）
    quoteText: text(),
    quoteHtml: text(),
    attachments: jsonb().$type<DraftAttachment[]>().notNull().default([]),
    status: text().notNull().default('draft'),
    // web | api | mcp
    source: text().notNull().default('web'),
    createdByKeyId: integer().references(() => apiKeys.id, { onDelete: 'set null' }),
    // 通过 MCP OAuth 授权创建的草稿只能由同一授权修改 / 发送
    createdByOauthId: integer().references(() => mcpAuthorizations.id, { onDelete: 'set null' }),
    // Agent 提交审批时的说明
    note: text(),
    sendAt: timestamp({ withTimezone: true }),
    attempts: integer().notNull().default(0),
    error: text(),
    sentAt: timestamp({ withTimezone: true }),
    sentMessageId: text(),
    // 发出后几天没收到回复就提醒，发送成功时据此创建跟进提醒
    followUpDays: integer(),
    // 内容版本号：每次修改收件人、正文或附件都加一，网页审批时必须和用户看到的版本一致
    revision: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('drafts_status').on(t.status, t.sendAt), index('drafts_account').on(t.accountId, t.updatedAt.desc())],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    // user:1 / key:3 / oauth:2 / rule:5 / system / anonymous
    actor: text().notNull(),
    // 业务动作（rule.create、messages.archive）或通用请求（POST /api/admin/accounts/:id）、mcp.call
    action: text().notNull(),
    accountId: integer(),
    target: text(),
    detail: jsonb().$type<Record<string, unknown>>(),
    // 来源：web（网页后台）/ api（REST 开放接口）/ mcp / oauth（授权页）/ system（后台任务）
    source: text(),
    ip: text(),
    userAgent: text(),
    // HTTP 状态码；MCP 工具返回错误记为 400，权限不足 403
    status: integer(),
    durationMs: integer(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_created').on(t.createdAt.desc()),
    index('audit_logs_actor_created').on(t.actor, t.createdAt.desc()),
    index('audit_logs_action_created').on(t.action, t.createdAt.desc()),
  ],
);

export type Draft = typeof drafts.$inferSelect;

/** 全局设置（AI 配置等），敏感字段在 value 里以加密形式保存 */
export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type Extracted = {
  codes: string[];
  amounts: Array<{ value: number; currency: string; label?: string }>;
  dueDate: string | null;
  trackingNumbers: string[];
  actionItems: string[];
};

/** AI 对邮件的分类与信息抽取结果 */
export const messageInsights = pgTable(
  'message_insights',
  {
    messageId: bigint({ mode: 'number' })
      .primaryKey()
      .references(() => messages.id, { onDelete: 'cascade' }),
    // important | work | personal | notification | marketing | finance | verification | shipping | social | spam
    category: text().notNull(),
    // high | normal | low
    priority: text().notNull(),
    summary: text().notNull(),
    needsReply: boolean().notNull().default(false),
    extracted: jsonb().$type<Extracted>().notNull(),
    model: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('message_insights_category').on(t.category), index('message_insights_priority').on(t.priority)],
);

/**
 * 系统内置的邮件分类（只读）：内容定义在 src/catalog/categories.ts，服务启动时同步过来。
 * 邮件分析结果（message_insights.category）存的是 key。i18n：按语言的名称和给 AI 的判断说明
 */
export const categories = pgTable('categories', {
  key: text().primaryKey(),
  i18n: jsonb().$type<I18n<{ name: string; description: string }>>().notNull(),
  color: text().notNull(),
  position: integer().notNull(),
  builtin: boolean().notNull().default(true),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * AI 提示词（目前只有系统内置的，只读）：内容定义在 src/catalog/prompts.ts，服务启动时同步过来，
 * 调用 AI 时按语言取 text，再替换 {{变量}}
 */
export const prompts = pgTable('prompts', {
  key: text().primaryKey(),
  purpose: text().notNull(),
  title: jsonb().$type<I18n<string>>().notNull(),
  description: jsonb().$type<I18n<string>>().notNull(),
  vars: text().array().notNull(),
  text: jsonb().$type<I18n<string>>().notNull(),
  position: integer().notNull(),
  builtin: boolean().notNull().default(true),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * 标签：分类之外的细分，一封邮件可以有多个。来自 AI 推荐（用户采用后生成）或用户手动新建，都可以修改。
 * i18n：按语言的名称和说明；说明是给 AI 的判断规则，分析新邮件时按它决定要不要打。见 docs/labels.md
 */
export const labels = pgTable('labels', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  i18n: jsonb().$type<I18n<{ name: string; description: string }>>().notNull(),
  color: text().notNull(),
  // 显示在侧栏
  pinned: boolean().notNull().default(true),
  // suggested | manual
  source: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * 邮件上的标签。source：ai（分析时自动打）| manual（用户手动加）| suggestion（采用推荐时给历史邮件打的）。
 * removed 是用户手动去掉的记录：列表、搜索里不算，重新分析也不会再打回来
 */
export const messageLabels = pgTable(
  'message_labels',
  {
    messageId: bigint({ mode: 'number' })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    labelId: integer()
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
    source: text().notNull(),
    removed: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.labelId] }),
    index('message_labels_label')
      .on(t.labelId, t.messageId)
      .where(sql`NOT ${t.removed}`),
  ],
);

/**
 * AI 推荐的标签：同一次推荐共用 runId；i18n 是按语言的名称、说明和推荐理由（一次推荐同时生成所有语言）；
 * message_ids 是推荐时覆盖到的历史邮件，采用后直接打上
 */
export const labelSuggestions = pgTable(
  'label_suggestions',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    runId: text().notNull(),
    i18n: jsonb().$type<I18n<{ name: string; description: string; reason: string }>>().notNull(),
    color: text().notNull(),
    messageIds: bigint({ mode: 'number' }).array().notNull(),
    // pending | accepted | dismissed | expired
    status: text().notNull().default('pending'),
    labelId: integer().references(() => labels.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('label_suggestions_status').on(t.status, t.createdAt)],
);

export type Label = typeof labels.$inferSelect;
export type LabelSuggestion = typeof labelSuggestions.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Prompt = typeof prompts.$inferSelect;

/** 忽略的发件人：完整地址（a@b.com）或整个域名（@b.com，含子域名），统一小写；来信不做 AI 分析，也不算进日报和概览 */
/** 通讯录里给邮箱地址起的备注名，只在 DaMail 里显示，不会写进发出去的邮件 */
export const contactAliases = pgTable('contact_aliases', {
  address: text().primaryKey(),
  alias: text().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const ignoredSenders = pgTable('ignored_senders', {
  pattern: text().primaryKey(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** 一键翻译的结果，按目标语言分别保存，重新翻译时覆盖 */
export const messageTranslations = pgTable(
  'message_translations',
  {
    messageId: bigint({ mode: 'number' })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    language: text().notNull(),
    subject: text().notNull(),
    // 纯文本译文；HTML 邮件另存一份只替换了文字的 HTML，排版和原邮件一致
    body: text().notNull(),
    html: text(),
    model: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.language] })],
);

export type MessageTranslation = typeof messageTranslations.$inferSelect;

export type RuleCondition = { field: string; op: string; value?: string | boolean };
export type RuleAction = { type: string; folderId?: number; channelId?: number; instruction?: string };

export const rules = pgTable('rules', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text().notNull(),
  enabled: boolean().notNull().default(true),
  position: integer().notNull().default(0),
  // null 表示所有账户
  accountIds: integer().array(),
  // all：全部条件满足；any：任一满足
  match: text().notNull().default('all'),
  conditions: jsonb().$type<RuleCondition[]>().notNull().default([]),
  actions: jsonb().$type<RuleAction[]>().notNull().default([]),
  // 命中后不再执行后续规则
  stopProcessing: boolean().notNull().default(false),
  matchCount: integer().notNull().default(0),
  lastMatchedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** 通知渠道：Bark / 企业微信 / 飞书 / Telegram / Webhook；config 整体加密 */
export const channels = pgTable('channels', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text().notNull(),
  type: text().notNull(),
  configEnc: text().notNull(),
  // 订阅的全局事件，例如 message.important、draft.pending；规则里的通知动作不需要订阅
  events: text()
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  enabled: boolean().notNull().default(true),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** 后台任务队列（新邮件处理、通知投递），持久化以便重启后继续，也作为投递记录 */
export const jobs = pgTable(
  'jobs',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    type: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    // queued | running | done | failed
    status: text().notNull().default('queued'),
    attempts: integer().notNull().default(0),
    runAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    error: text(),
    result: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index('jobs_queue').on(t.status, t.runAt), index('jobs_type_created').on(t.type, t.createdAt.desc())],
);

export type ReportItem = { id: number; threadId: string; subject: string; from: string; summary: string | null; date: string; accountId: number };
export type ReportData = {
  /** 统计截止时间（未结束的周期手动生成时早于 periodEnd） */
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

/** 日报 / 周报：每个周期一条，重新生成时覆盖 */
export const reports = pgTable(
  'reports',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    // daily | weekly
    kind: text().notNull(),
    periodStart: timestamp({ withTimezone: true }).notNull(),
    periodEnd: timestamp({ withTimezone: true }).notNull(),
    title: text().notNull(),
    data: jsonb().$type<ReportData>().notNull(),
    // AI 写的摘要；未启用 AI 或生成失败时为空
    summary: text(),
    summaryError: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('reports_period').on(t.kind, t.periodStart)],
);

export type Report = typeof reports.$inferSelect;

/**
 * 跟进提醒：发出的邮件到期仍没有回复就推送提醒。也用来记录「不用再等」，把邮件从等回复列表里拿掉。
 * open（等待中）→ due（已到期并提醒）；收到回复变 replied；手动完成或不用再等变 done
 */
export const followUps = pgTable(
  'follow_ups',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // 发出邮件的 Message-ID，回信的 In-Reply-To / References 里带着它
    messageId: text().notNull(),
    subject: text().notNull().default(''),
    to: jsonb().$type<Address[]>().notNull().default([]),
    dueAt: timestamp({ withTimezone: true }),
    status: text().notNull().default('open'),
    notifiedAt: timestamp({ withTimezone: true }),
    repliedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('follow_ups_message').on(t.accountId, t.messageId), index('follow_ups_due').on(t.status, t.dueAt)],
);

export type FollowUp = typeof followUps.$inferSelect;

/** 退订记录：按收件账户 + 列表（List-Id，没有时用发件地址）记一条，最新一次为准 */
export const unsubscriptions = pgTable(
  'unsubscriptions',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    listKey: text().notNull(),
    sender: text(),
    // one-click（RFC 8058 POST）| mailto（发退订邮件）| link（打开退订网页，由用户自己完成）
    method: text().notNull(),
    // done | unconfirmed（请求已发出但对方没及时响应）| opened（打开了退订网页）| failed
    status: text().notNull(),
    error: text(),
    messageId: bigint({ mode: 'number' }).references(() => messages.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('unsubscriptions_list').on(t.accountId, t.listKey)],
);

export type Unsubscription = typeof unsubscriptions.$inferSelect;

export type Rule = typeof rules.$inferSelect;
export type Channel = typeof channels.$inferSelect;
export type MessageInsight = typeof messageInsights.$inferSelect;

/** 站内 AI 助手的对话步骤（工具调用），只用于界面回显 */
export type AssistantStep = { id: string; label: string; status: 'ok' | 'error'; summary?: string; draftId?: number };
/** 一次回答（可能含多轮工具调用）的总用量 */
// genMs 是各轮从第一个 token 到结束的时间之和（不含等待首字和执行工具），用来算输出速度；ttftMs 是第一轮的首字延迟
export type AssistantUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number | null;
  durationMs: number;
  rounds: number;
  genMs?: number;
  ttftMs?: number;
};
// model / thinking / usage 是后来加的，旧记录没有
export type AssistantMessage = {
  role: 'user' | 'assistant';
  content: string;
  // 提问时附带的「当前邮件」（只有用户消息有）
  context?: { threadId: string; subject: string };
  steps?: AssistantStep[];
  error?: string;
  model?: string;
  channelName?: string | null;
  // 模型的思考过程（Claude 为摘要），thinkingMs 是思考用时
  thinking?: string;
  thinkingMs?: number;
  usage?: AssistantUsage;
};

/** 站内 AI 助手的会话记录；消息不多，整段存成 jsonb */
export const assistantConversations = pgTable(
  'assistant_conversations',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    userId: integer()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 先用第一句话占位，AI 生成后替换
    title: text().notNull(),
    messages: jsonb().$type<AssistantMessage[]>().notNull().default([]),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('assistant_conversations_user').on(t.userId, t.updatedAt)],
);

export type AssistantConversation = typeof assistantConversations.$inferSelect;

/** 每一次调用模型的记录，用于模型配置里的请求列表和用量统计 */
export const aiRequests = pgTable(
  'ai_requests',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    // classify 邮件分析 / reply 起草回复 / report 日报 / search 语义搜索 / title 对话标题 / assistant 助手 / test 测试
    purpose: text().notNull(),
    // 渠道可能被删除，名称一起存下来
    channelId: text(),
    channelName: text(),
    provider: text().notNull(),
    model: text().notNull(),
    ok: boolean().notNull(),
    error: text(),
    durationMs: integer().notNull(),
    // 输入 token 含缓存命中和缓存写入的部分；接口没返回用量时为空
    inputTokens: integer(),
    outputTokens: integer(),
    cacheReadTokens: integer(),
    cacheWriteTokens: integer(),
    // 按调用时渠道里的单价和倍率算出的费用（美元）；没有价格或用量时为空
    cost: doublePrecision(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_requests_created').on(t.createdAt)],
);

export type AiRequest = typeof aiRequests.$inferSelect;
