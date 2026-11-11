/**
 * MCP OAuth 权限（scope）定义，以及和 DaMail 内部权限、MCP 工具的对应关系。
 *
 * - 每个 scope 独立授予，send 不会由 read / draft 推导出来，反之亦然。
 * - 服务端在每次工具调用时按这里的映射校验，工具元数据和客户端界面上的确认都不能替代。
 * - 自动化规则、忽略名单、退订这类工具不开放给 OAuth 客户端。
 */

import { L } from '../i18n/index.js';

export const OAUTH_SCOPES = {
  'mail:read': {
    internal: 'read',
    get label() {
      return L('读取邮件', 'Read mail');
    },
    get description() {
      return L('查看邮箱列表、搜索和阅读邮件、会话、附件、草稿，以及统计和日报。', 'View mailboxes; search and read mail, conversations, attachments and drafts; view stats and reports.');
    },
  },
  'mail:organize': {
    internal: 'organize',
    get label() {
      return L('整理邮件', 'Organize mail');
    },
    get description() {
      return L('标记已读 / 星标，归档、移到已删除或其他文件夹，设置跟进提醒。不会永久删除。', 'Mark read / starred, archive, move to Trash or other folders, and set follow-up reminders. Never deletes permanently.');
    },
  },
  'mail:draft': {
    internal: 'draft',
    get label() {
      return L('写草稿', 'Write drafts');
    },
    get description() {
      return L('创建、修改、删除草稿，提交给你在 DaMail 网页上审批。不能直接发出。', 'Create, edit and delete drafts, and submit them for your approval in DaMail. Cannot send directly.');
    },
  },
  'mail:send': {
    internal: 'send',
    get label() {
      return L('直接发送', 'Send directly');
    },
    get description() {
      return L('不经网页审批，直接发送本次授权创建的草稿（仍有撤销窗口，并受每小时发送上限限制）。', 'Send drafts created by this authorization without web approval (still with an undo window and an hourly send limit).');
    },
  },
} as const;

export type OAuthScope = keyof typeof OAUTH_SCOPES;
export const RESOURCE_SCOPES = Object.keys(OAUTH_SCOPES) as OAuthScope[];
/** Protected Resource Metadata 和初始 401 只要求基础只读权限，写权限按需逐步申请 */
export const BASE_SCOPES: OAuthScope[] = ['mail:read'];

export const isOAuthScope = (s: string): s is OAuthScope => s in OAUTH_SCOPES;

export function internalScopes(scopes: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const s of scopes) if (isOAuthScope(s)) out.add(OAUTH_SCOPES[s].internal);
  return [...out];
}

/** OAuth 客户端能看到的工具及所需权限；不在表里的工具对 OAuth 不注册 */
export const OAUTH_TOOL_SCOPES: Record<string, OAuthScope> = {
  list_accounts: 'mail:read',
  list_folders: 'mail:read',
  semantic_search: 'mail:read',
  search_emails: 'mail:read',
  get_email: 'mail:read',
  get_thread: 'mail:read',
  get_attachment: 'mail:read',
  get_stats: 'mail:read',
  list_waiting: 'mail:read',
  list_subscriptions: 'mail:read',
  list_contacts: 'mail:read',
  translate_email: 'mail:read',
  get_report: 'mail:read',
  list_reports: 'mail:read',
  list_drafts: 'mail:read',
  get_draft: 'mail:read',
  mark_emails: 'mail:organize',
  move_emails: 'mail:organize',
  set_follow_up: 'mail:organize',
  clear_follow_up: 'mail:organize',
  create_draft: 'mail:draft',
  update_draft: 'mail:draft',
  delete_draft: 'mail:draft',
  request_send: 'mail:draft',
  cancel_send: 'mail:draft',
  send_draft: 'mail:send',
};

/** API Key / 网页登录态下工具所需的内部权限，用于调用时的二次校验 */
export const INTERNAL_TOOL_SCOPES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(OAUTH_TOOL_SCOPES).map(([k, v]) => [k, OAUTH_SCOPES[v].internal])),
  unsubscribe: 'send',
  list_rules: 'automation',
  list_channels: 'automation',
  list_ignored_senders: 'automation',
  ignore_sender: 'automation',
  unignore_sender: 'automation',
  test_rule: 'automation',
  create_rule: 'automation',
  update_rule: 'automation',
  delete_rule: 'automation',
};

/** 解析 scope 参数：去重，未知的 scope 原样返回给调用方决定是否拒绝 */
export function parseScopeParam(raw: string | undefined | null) {
  return [...new Set((raw ?? '').split(' ').filter(Boolean))];
}
