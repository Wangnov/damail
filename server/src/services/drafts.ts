import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { convert as htmlToText } from 'html-to-text';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { z } from 'zod';
import { actorOf, type AuthContext } from '../auth/index.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { accounts, drafts, messages, type Account, type Address, type Draft, type DraftAttachment, type Message } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { bus } from '../lib/events.js';
import { ActionError } from './actions.js';
import { parseRaw, readRaw } from './ingest.js';
import { inScope } from './mail.js';
import { emitDraftEvent } from './notify.js';
import { dateTimeFormat, L } from '../i18n/index.js';

export type DraftMode = 'new' | 'reply' | 'replyAll' | 'forward';

/** 收件人可以写成 "张三 <a@b.com>"、"a@b.com, c@d.com" 或 { name, address } */
const addressInput = z.union([z.string(), z.object({ name: z.string().optional(), address: z.string() })]);
const addressList = z.union([z.string(), z.array(addressInput)]);

export const draftFields = z.object({
  accountId: z.number().int().optional(),
  to: addressList.optional(),
  cc: addressList.optional(),
  bcc: addressList.optional(),
  subject: z.string().max(998).optional(),
  body: z.string().max(500_000).optional(),
  // 富文本正文，同时应提供纯文本 body 作为 text/plain 部分；正文里的图片是 data: 地址，发送时转成内嵌附件
  bodyHtml: z.string().max(12_000_000).nullish(),
  // rich：编辑器生成的 HTML，发送时补内联样式；html：用户自己写的 HTML 源码，原样发出
  bodyFormat: z.enum(['rich', 'html']).optional(),
  // 发送时附上发件邮箱的签名
  includeSignature: z.boolean().optional(),
  includeQuote: z.boolean().optional(),
  note: z.string().max(2000).nullish(),
  // 发出后几天没收到回复就提醒
  followUpDays: z.number().int().min(1).max(60).nullish(),
});

export const draftCreate = draftFields.extend({
  mode: z.enum(['new', 'reply', 'replyAll', 'forward']).default('new'),
  sourceMessageId: z.number().int().optional(),
});

export type DraftCreateInput = z.input<typeof draftCreate>;
export type DraftPatch = z.infer<typeof draftFields>;

const EDITABLE = new Set(['draft', 'pending', 'failed', 'rejected']);
const EDITABLE_STATUSES = [...EDITABLE];
/** 内容修改后版本号加一：网页批准时按版本号确认审的就是要发的那份 */
const bumpRevision = () => sql`${drafts.revision} + 1`;
const draftChanged = () => new ActionError(L('草稿内容已被修改，请检查最新内容后再操作', 'The draft was changed; review the latest version and try again'), 409);
const email = z.email();

function normalizeAddresses(input: z.infer<typeof addressList> | undefined): Address[] | undefined {
  if (input === undefined) return undefined;
  const items = typeof input === 'string' ? [input] : input;
  const out: Address[] = [];
  for (const item of items) {
    const parsed = typeof item === 'string' ? addressparser(item, { flatten: true }) : [item];
    for (const a of parsed) {
      const address = a.address?.trim();
      if (!address) continue;
      if (!email.safeParse(address).success) throw new ActionError(L(`收件人地址不正确：${address}`, `Invalid recipient address: ${address}`));
      out.push(a.name ? { name: a.name, address } : { address });
    }
  }
  return dedupe(out);
}

function dedupe(list: Address[], exclude: string[] = []): Address[] {
  const seen = new Set(exclude.map((e) => e.toLowerCase()));
  return list.filter((a) => {
    const key = a.address?.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const fmtAddress = (a: Address) => (a.name ? `${a.name} <${a.address}>` : (a.address ?? ''));
const fmtDate = (d: Date) => dateTimeFormat(d, { dateStyle: 'medium', timeStyle: 'short' });

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function withPrefix(subject: string, mode: DraftMode) {
  if (mode === 'forward') return /^\s*(fwd?|转发)\s*[:：]/i.test(subject) ? subject : `Fwd: ${subject}`;
  return /^\s*(re|aw|回复|答复)\s*[:：]/i.test(subject) ? subject : `Re: ${subject}`;
}

/** 只取 <body> 里的内容，避免把整份 HTML 文档（含 <head><style>）嵌进引用块 */
function bodyOf(html: string) {
  const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return m ? m[1]! : html;
}

function buildQuote(msg: Message, mode: DraftMode) {
  const from = fmtAddress({ name: msg.fromName ?? undefined, address: msg.fromAddress ?? undefined });
  const text = msg.textBody ?? '';
  const html = msg.htmlBody ? bodyOf(msg.htmlBody) : `<div style="white-space:pre-wrap">${escapeHtml(text)}</div>`;
  if (mode === 'forward') {
    const lines = [
      L(`发件人：${from}`, `From: ${from}`),
      L(`日期：${fmtDate(msg.date)}`, `Date: ${fmtDate(msg.date)}`),
      L(`主题：${msg.subject}`, `Subject: ${msg.subject}`),
      L(`收件人：${msg.to.map(fmtAddress).join(', ')}`, `To: ${msg.to.map(fmtAddress).join(', ')}`),
      ...(msg.cc.length ? [L(`抄送：${msg.cc.map(fmtAddress).join(', ')}`, `Cc: ${msg.cc.map(fmtAddress).join(', ')}`)] : []),
    ];
    return {
      quoteText: L(
        `---------- 转发的邮件 ----------\n${lines.join('\n')}\n\n${text}`,
        `---------- Forwarded message ----------\n${lines.join('\n')}\n\n${text}`,
      ),
      quoteHtml: L(
        `<div>---------- 转发的邮件 ----------<br>${lines.map(escapeHtml).join('<br>')}</div><br>${html}`,
        `<div>---------- Forwarded message ----------<br>${lines.map(escapeHtml).join('<br>')}</div><br>${html}`,
      ),
    };
  }
  const header = L(`在 ${fmtDate(msg.date)}，${from} 写道：`, `On ${fmtDate(msg.date)}, ${from} wrote:`);
  return {
    quoteText: `${header}\n${text
      .replace(/\r?\n/g, '\n')
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')}`,
    quoteHtml: `<div>${escapeHtml(header)}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${html}</blockquote>`,
  };
}

/** 引用链太长时保留第一条和最近的 19 条 */
function buildReferences(msg: Message) {
  const refs = [...new Set([...msg.references, ...(msg.messageId ? [msg.messageId] : [])])];
  return refs.length > 20 ? [refs[0]!, ...refs.slice(-19)] : refs;
}

function replyDefaults(msg: Message, mode: DraftMode, account: Account) {
  const own = account.email.toLowerCase();
  // 回复自己发出的邮件（在「已发送」里点回复）时，发给原收件人
  const fromSelf = msg.fromAddress?.toLowerCase() === own;
  const sender: Address[] = msg.replyTo.length ? msg.replyTo : [{ name: msg.fromName ?? undefined, address: msg.fromAddress ?? undefined }];
  const to = dedupe(fromSelf ? msg.to : sender, [own]);
  const cc = mode === 'replyAll' ? dedupe([...(fromSelf ? [] : msg.to), ...msg.cc], [own, ...to.map((a) => a.address!)]) : [];
  return { to, cc, threadId: msg.threadId, inReplyTo: msg.messageId, references: buildReferences(msg) };
}

async function uploadDir(draftId: number) {
  const dir = path.join(config.uploadDir, String(draftId));
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function saveAttachment(draftId: number, filename: string, contentType: string, content: Buffer): Promise<DraftAttachment> {
  const safe =
    path
      .basename(filename)
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .slice(-120) || 'attachment';
  const file = path.join(await uploadDir(draftId), `${randomBytes(6).toString('hex')}-${safe}`);
  await writeFile(file, content);
  return { path: path.relative(config.uploadDir, file), filename, contentType: contentType || 'application/octet-stream', size: content.length };
}

/** 转发时把原邮件的非内嵌附件复制到草稿 */
async function copyForwardAttachments(draftId: number, msg: Message): Promise<DraftAttachment[]> {
  if (!msg.rawPath || !msg.hasAttachments) return [];
  const parsed = await parseRaw(await readRaw(msg.rawPath));
  const out: DraftAttachment[] = [];
  for (const att of parsed.attachments) {
    if (att.contentDisposition === 'inline' && att.cid) continue;
    out.push(await saveAttachment(draftId, att.filename ?? 'attachment', att.contentType, att.content));
  }
  return out;
}

function publish(d: Pick<Draft, 'id' | 'accountId' | 'status'>) {
  bus.publish({ type: 'drafts.updated', accountId: d.accountId, draftId: d.id, status: d.status });
}

async function loadAccount(auth: AuthContext, accountId: number | undefined): Promise<Account> {
  let id = accountId;
  if (!id) {
    const list = (await db.select({ id: accounts.id }).from(accounts)).filter((a) => inScope(auth.scope, a.id));
    if (list.length !== 1) throw new ActionError(L('请指定发件账户 accountId', 'Specify the sending account (accountId)'));
    id = list[0]!.id;
  }
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, id) });
  if (!account || !inScope(auth.scope, account.id)) throw new ActionError(L('发件账户不存在或无权使用', 'Sending account not found or not allowed'), 404);
  return account;
}

export async function createDraft(auth: AuthContext, input: DraftCreateInput, source: 'web' | 'api' | 'mcp' | 'rule' | 'assistant') {
  const data = draftCreate.parse(input);
  let msg: Message | undefined;
  if (data.mode !== 'new') {
    if (!data.sourceMessageId) throw new ActionError(L('回复或转发需要提供 sourceMessageId', 'Replying or forwarding requires sourceMessageId'));
    msg = await db.query.messages.findFirst({ where: eq(messages.id, data.sourceMessageId) });
    if (!msg || !inScope(auth.scope, msg.accountId)) throw new ActionError(L('原邮件不存在或无权访问', 'Original message not found or not accessible'), 404);
  }
  const account = await loadAccount(auth, data.accountId ?? msg?.accountId);

  const values: typeof drafts.$inferInsert = {
    accountId: account.id,
    mode: data.mode,
    sourceMessageId: msg?.id,
    subject: data.subject ?? (msg ? withPrefix(msg.subject, data.mode) : ''),
    body: data.body ?? '',
    bodyHtml: data.bodyHtml || null,
    bodyFormat: data.bodyHtml ? (data.bodyFormat ?? 'rich') : 'rich',
    includeSignature: data.includeSignature ?? true,
    includeQuote: data.includeQuote ?? true,
    note: data.note ?? null,
    followUpDays: data.followUpDays ?? null,
    source,
    createdByKeyId: auth.kind === 'apiKey' ? (auth.apiKeyId ?? null) : null,
    createdByOauthId: auth.kind === 'oauth' ? (auth.oauth?.authorizationId ?? null) : null,
  };
  if (msg) {
    Object.assign(values, buildQuote(msg, data.mode));
    if (data.mode !== 'forward') Object.assign(values, replyDefaults(msg, data.mode, account));
  }
  for (const key of ['to', 'cc', 'bcc'] as const) {
    const list = normalizeAddresses(data[key]);
    if (list) values[key] = list;
  }

  // 插入和复制转发附件放在同一个事务里：附件就位之前草稿对其他请求不可见，
  // 不会出现 Agent 先提交、用户看到空附件批准、附件随后才写进待发邮件的情况
  let createdId: number | undefined;
  let draft: Draft;
  try {
    draft = await db.transaction(async (tx) => {
      const [row] = await tx.insert(drafts).values(values).returning();
      createdId = row!.id;
      if (!msg || data.mode !== 'forward') return row!;
      const attachments = await copyForwardAttachments(row!.id, msg);
      if (!attachments.length) return row!;
      const [withAttachments] = await tx.update(drafts).set({ attachments }).where(eq(drafts.id, row!.id)).returning();
      return withAttachments!;
    });
  } catch (err) {
    // 事务回滚后草稿不存在，已经复制出去的附件文件一并删掉
    if (createdId !== undefined) await rm(path.join(config.uploadDir, String(createdId)), { recursive: true, force: true });
    throw err;
  }
  audit(actorOf(auth), 'draft.create', { accountId: account.id, target: `draft:${draft.id}`, detail: { mode: data.mode, source } });
  publish(draft);
  return draft;
}

/**
 * 谁能修改 / 提交 / 发送一份草稿（默认拒绝）：
 * - 网页登录态（以及规则等系统内部操作）：可以处理全部草稿，审批也走这里
 * - API Key：只能处理本 Key 创建的
 * - MCP OAuth：只能处理同一授权创建的
 */
export function ownsDraft(auth: AuthContext, d: Pick<Draft, 'createdByKeyId' | 'createdByOauthId'>) {
  switch (auth.kind) {
    case 'session':
      return true;
    case 'apiKey':
      return auth.apiKeyId !== undefined && d.createdByKeyId === auth.apiKeyId;
    case 'oauth':
      return auth.oauth !== undefined && d.createdByOauthId === auth.oauth.authorizationId;
    default:
      return false;
  }
}

async function loadOwned(auth: AuthContext, id: number): Promise<Draft> {
  const d = await db.query.drafts.findFirst({ where: eq(drafts.id, id) });
  if (!d || !inScope(auth.scope, d.accountId)) throw new ActionError(L('草稿不存在或无权访问', 'Draft not found or not accessible'), 404);
  if (!ownsDraft(auth, d))
    throw new ActionError(
      auth.kind === 'oauth'
        ? L('只能处理本次授权创建的草稿', 'Only drafts created by this authorization can be changed')
        : L('只能修改本 API Key 创建的草稿', 'Only drafts created by this API key can be changed'),
      403,
    );
  return d;
}

/** OAuth 客户端直接发信的频率上限（按授权统计最近一小时入队 / 已发出的数量） */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * OAuth 直接发信的每小时配额。要在入队的同一个事务里调用：
 * 先按授权加事务级咨询锁，并发请求排队检查，不会都看到「还有余量」而一起超额。
 */
async function assertOAuthSendQuota(auth: AuthContext, tx: Tx) {
  if (auth.kind !== 'oauth' || !auth.oauth) return;
  const limit = config.mcpOAuth.sendLimitPerHour;
  if (limit <= 0)
    throw new ActionError(
      L(
        'DaMail 未允许 OAuth 客户端直接发信，请用 request_send 提交审批',
        'DaMail does not allow OAuth clients to send directly; use request_send to submit for approval',
      ),
      403,
    );
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('damail:oauth-send'), ${auth.oauth.authorizationId}::int)`);
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(drafts)
    .where(
      and(
        eq(drafts.createdByOauthId, auth.oauth.authorizationId),
        inArray(drafts.status, ['queued', 'sending', 'sent']),
        gt(drafts.updatedAt, new Date(Date.now() - 3600_000)),
      ),
    );
  if (n >= limit)
    throw new ActionError(
      L(
        `本次授权每小时最多直接发送 ${limit} 封，请稍后再试或用 request_send 提交审批`,
        `This authorization can send at most ${limit} messages per hour directly; try again later or use request_send to submit for approval`,
      ),
      429,
    );
}

export async function getDraft(auth: AuthContext, id: number) {
  const d = await db.query.drafts.findFirst({ where: eq(drafts.id, id) });
  if (!d || !inScope(auth.scope, d.accountId)) return null;
  return d;
}

export async function listDrafts(auth: AuthContext, opts: { status?: string[]; threadId?: string; limit?: number } = {}) {
  const conds: SQL[] = [];
  if (auth.scope.accountIds) conds.push(auth.scope.accountIds.length ? inArray(drafts.accountId, auth.scope.accountIds) : sql`false`);
  if (opts.status?.length) conds.push(inArray(drafts.status, opts.status));
  if (opts.threadId) conds.push(eq(drafts.threadId, opts.threadId));
  return db
    .select({
      id: drafts.id,
      accountId: drafts.accountId,
      accountEmail: accounts.email,
      mode: drafts.mode,
      sourceMessageId: drafts.sourceMessageId,
      threadId: drafts.threadId,
      to: drafts.to,
      cc: drafts.cc,
      bcc: drafts.bcc,
      subject: drafts.subject,
      snippet: sql<string>`left(${drafts.body}, 200)`,
      attachmentCount: sql<number>`jsonb_array_length(${drafts.attachments})::int`,
      status: drafts.status,
      source: drafts.source,
      note: drafts.note,
      error: drafts.error,
      sendAt: drafts.sendAt,
      sentAt: drafts.sentAt,
      updatedAt: drafts.updatedAt,
    })
    .from(drafts)
    .innerJoin(accounts, eq(accounts.id, drafts.accountId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(drafts.updatedAt))
    .limit(Math.min(opts.limit ?? 100, 200));
}

export async function updateDraft(auth: AuthContext, id: number, patch: DraftPatch) {
  const d = await loadOwned(auth, id);
  if (!EDITABLE.has(d.status))
    throw new ActionError(
      d.status === 'queued'
        ? L('邮件即将发送，请先撤销', 'The message is about to be sent; undo it first')
        : L('该邮件已发送，不能再修改', 'This message has been sent and can no longer be changed'),
      409,
    );
  const data = draftFields.parse(patch);
  const set: Partial<typeof drafts.$inferInsert> = { updatedAt: new Date() };
  // 带了发件账户就总是写入（网页保存时提交的是用户看到的账户），不和读到的值比较后省略
  if (data.accountId) set.accountId = (await loadAccount(auth, data.accountId)).id;
  if (data.subject !== undefined) set.subject = data.subject;
  if (data.body !== undefined) set.body = data.body;
  // 只改了纯文本正文（例如 Agent 通过 API 修改）时，旧的富文本版本已经过期
  if (data.bodyHtml !== undefined) set.bodyHtml = data.bodyHtml || null;
  else if (data.body !== undefined) set.bodyHtml = null;
  if (data.bodyFormat !== undefined) set.bodyFormat = data.bodyFormat;
  else if (set.bodyHtml === null) set.bodyFormat = 'rich';
  if (data.includeSignature !== undefined) set.includeSignature = data.includeSignature;
  if (data.includeQuote !== undefined) set.includeQuote = data.includeQuote;
  if (data.followUpDays !== undefined) set.followUpDays = data.followUpDays;
  if (data.note !== undefined) set.note = data.note;
  for (const key of ['to', 'cc', 'bcc'] as const) {
    const list = normalizeAddresses(data[key]);
    if (list) set[key] = list;
  }
  // 失败或被拒绝的草稿修改后回到草稿状态，需要重新提交
  if (d.status === 'failed' || d.status === 'rejected') Object.assign(set, { status: 'draft', error: null });
  // 状态和版本号都要和读到的一致：避免检查之后草稿已被批准入队、修改却仍然写进待发送的邮件；
  // 也避免读到之后被别的请求改过（比如换了发件账户），这次保存却在不知情的情况下成功
  const [row] = await db
    .update(drafts)
    .set({ ...set, revision: bumpRevision() })
    .where(and(eq(drafts.id, id), eq(drafts.status, d.status), eq(drafts.revision, d.revision)))
    .returning();
  if (!row) throw draftChanged();
  publish(row);
  return row;
}

export async function addAttachment(auth: AuthContext, id: number, file: { name: string; type: string; content: Buffer }) {
  const d = await loadOwned(auth, id);
  if (!EDITABLE.has(d.status)) throw new ActionError(L('当前状态不能修改附件', 'Attachments cannot be changed in the current state'), 409);
  const total = d.attachments.reduce((n, a) => n + a.size, 0) + file.content.length;
  if (total > config.maxAttachmentBytes)
    throw new ActionError(
      L(
        `附件总大小不能超过 ${config.maxAttachmentBytes / 1024 / 1024} MB`,
        `Total attachment size cannot exceed ${config.maxAttachmentBytes / 1024 / 1024} MB`,
      ),
    );
  const att = await saveAttachment(id, file.name, file.type, file.content);
  // 用 SQL 原子追加，同时上传多个文件时不会互相覆盖
  const [row] = await db
    .update(drafts)
    .set({ attachments: sql`${drafts.attachments} || ${JSON.stringify([att])}::jsonb`, revision: bumpRevision(), updatedAt: new Date() })
    .where(and(eq(drafts.id, id), inArray(drafts.status, EDITABLE_STATUSES)))
    .returning();
  if (!row) {
    await rm(path.join(config.uploadDir, att.path), { force: true });
    throw new ActionError(L('当前状态不能修改附件', 'Attachments cannot be changed in the current state'), 409);
  }
  publish(row);
  return row;
}

export async function removeAttachment(auth: AuthContext, id: number, index: number) {
  const d = await loadOwned(auth, id);
  if (!EDITABLE.has(d.status)) throw new ActionError(L('当前状态不能修改附件', 'Attachments cannot be changed in the current state'), 409);
  const att = d.attachments[index];
  if (!att) throw new ActionError(L('附件不存在', 'Attachment not found'), 404);
  const [row] = await db
    .update(drafts)
    .set({ attachments: d.attachments.filter((_, i) => i !== index), revision: bumpRevision(), updatedAt: new Date() })
    .where(and(eq(drafts.id, id), eq(drafts.status, d.status), eq(drafts.revision, d.revision)))
    .returning();
  if (!row) throw draftChanged();
  await rm(path.join(config.uploadDir, att.path), { force: true });
  publish(row);
  return row;
}

export async function deleteDraft(auth: AuthContext, id: number) {
  const d = await loadOwned(auth, id);
  if (d.status === 'queued' || d.status === 'sending')
    throw new ActionError(L('邮件正在发送队列中，请先撤销', 'The message is in the send queue; undo it first'), 409);
  await db.delete(drafts).where(eq(drafts.id, id));
  await rm(path.join(config.uploadDir, String(id)), { recursive: true, force: true });
  audit(actorOf(auth), 'draft.delete', { accountId: d.accountId, target: `draft:${id}` });
  publish({ ...d, status: 'deleted' });
}

async function checkSendable(d: Draft) {
  if (!d.to.length && !d.cc.length && !d.bcc.length) throw new ActionError(L('请填写收件人', 'Enter at least one recipient'));
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, d.accountId) });
  if (!account?.smtpHost) throw new ActionError(L('该账户没有配置 SMTP 服务器，无法发信', 'This account has no SMTP server configured and cannot send mail'));
}

/** Agent 提交审批：进入待审批队列，由用户在网页上确认后发送 */
export async function submitDraft(auth: AuthContext, id: number, note?: string) {
  const d = await loadOwned(auth, id);
  if (!['draft', 'failed', 'rejected'].includes(d.status))
    throw new ActionError(L(`当前状态（${d.status}）不能提交审批`, `Cannot submit for approval in the current state (${d.status})`), 409);
  await checkSendable(d);
  const [row] = await db
    .update(drafts)
    .set({ status: 'pending', error: null, note: note ?? d.note, updatedAt: new Date() })
    .where(and(eq(drafts.id, id), eq(drafts.status, d.status)))
    .returning();
  if (!row) throw draftChanged();
  audit(actorOf(auth), 'draft.submit', { accountId: d.accountId, target: `draft:${id}` });
  publish(row!);
  emitDraftEvent('draft.pending', row!);
  return row!;
}

/** 放入发送队列，sendAt 之前可以撤销；网页审批 pending 草稿也走这里 */
export async function queueDraft(auth: AuthContext, id: number, opts: { delaySec?: number; sendAt?: Date; revision?: number } = {}) {
  const d = await loadOwned(auth, id);
  if (!EDITABLE.has(d.status)) throw new ActionError(L(`当前状态（${d.status}）不能发送`, `Cannot send in the current state (${d.status})`), 409);
  // OAuth 客户端不能直接发出待审批的邮件：审批只能由用户在网页上完成
  if (auth.kind === 'oauth' && d.status === 'pending')
    throw new ActionError(L('待审批的邮件只能由用户在网页上批准', 'Mail awaiting approval can only be approved by the user on the web'), 403);
  // 网页批准必须带上用户审阅的版本号，审阅期间 Agent 改过内容就拒绝，不能发出用户没看过的内容
  if (auth.kind === 'session' && d.status === 'pending' && opts.revision === undefined)
    throw new ActionError(L('批准时缺少草稿版本，请刷新后重试', 'Missing draft version for approval; refresh and try again'), 400);
  if (opts.revision !== undefined && opts.revision !== d.revision) throw draftChanged();
  await checkSendable(d);
  if (opts.sendAt && opts.sendAt.getTime() > Date.now() + 366 * 86_400_000)
    throw new ActionError(L('定时发送最多只能安排在一年以内', 'Scheduled sending must be within one year'));
  // 定时时间已过（例如在页面上停留太久）就按正常的撤销窗口发送
  const sendAt = opts.sendAt && opts.sendAt.getTime() > Date.now() ? opts.sendAt : new Date(Date.now() + (opts.delaySec ?? config.sendDelaySec) * 1000);
  // 配额检查和入队放在同一个事务里
  const row = await db.transaction(async (tx) => {
    await assertOAuthSendQuota(auth, tx);
    const [queued] = await tx
      .update(drafts)
      .set({ status: 'queued', sendAt, error: null, attempts: 0, updatedAt: new Date() })
      .where(and(eq(drafts.id, id), eq(drafts.status, d.status), eq(drafts.revision, d.revision)))
      .returning();
    return queued;
  });
  if (!row) throw new ActionError(L('草稿状态已变化，请刷新后重试', 'The draft has changed; refresh and try again'), 409);
  audit(actorOf(auth), d.status === 'pending' ? 'draft.approve' : 'draft.send', {
    accountId: d.accountId,
    target: `draft:${id}`,
    detail: { to: d.to.map((a) => a.address), subject: d.subject, revision: d.revision },
  });
  publish(row);
  return row;
}

export async function cancelDraft(auth: AuthContext, id: number) {
  await loadOwned(auth, id);
  const [row] = await db
    .update(drafts)
    .set({ status: 'draft', sendAt: null, updatedAt: new Date() })
    .where(and(eq(drafts.id, id), eq(drafts.status, 'queued')))
    .returning();
  if (!row) throw new ActionError(L('邮件已开始发送，无法撤销', 'Sending has already started and cannot be undone'), 409);
  audit(actorOf(auth), 'draft.cancel', { accountId: row.accountId, target: `draft:${id}` });
  publish(row);
  return row;
}

export async function rejectDraft(auth: AuthContext, id: number, reason?: string) {
  const d = await loadOwned(auth, id);
  if (d.status !== 'pending') throw new ActionError(L('只能拒绝待审批的邮件', 'Only mail awaiting approval can be rejected'), 409);
  const [row] = await db
    .update(drafts)
    .set({ status: 'rejected', error: reason || L('已被用户拒绝', 'Rejected by the user'), updatedAt: new Date() })
    .where(and(eq(drafts.id, id), eq(drafts.status, 'pending')))
    .returning();
  if (!row) throw draftChanged();
  audit(actorOf(auth), 'draft.reject', { accountId: d.accountId, target: `draft:${id}`, detail: { reason } });
  publish(row!);
  return row!;
}

type ComposeParts = Pick<Draft, 'body' | 'bodyHtml' | 'bodyFormat' | 'includeQuote' | 'includeSignature' | 'quoteText' | 'quoteHtml'>;

/** 签名的纯文本版本 */
function signatureText(html: string) {
  return htmlToText(html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] }).trim();
}

/** 最终发出的纯文本正文：撰写内容 + 签名（「-- 」分隔，RFC 3676）+ 引用原文 */
export function composeText(d: Pick<ComposeParts, 'body' | 'includeQuote' | 'quoteText'> & Partial<ComposeParts>, signatureHtml?: string | null) {
  const sig = d.includeSignature !== false && signatureHtml ? signatureText(signatureHtml) : '';
  const own = sig ? `${d.body}\n\n-- \n${sig}` : d.body;
  return d.includeQuote && d.quoteText ? `${own}\n\n${d.quoteText}` : own;
}

/** 编辑器输出的是不带样式的 HTML，邮件客户端大多不认 <style>，这里给常用标签补上内联样式（保留编辑器写的对齐等样式） */
export function inlineEmailStyles(html: string) {
  const merge = (base: string) => (_: string, own?: string) => ` style="${base}${own ? `;${own}` : ''}"`;
  return html
    .replace(/<p><\/p>/g, '<p><br></p>')
    .replace(/<li><p>/g, '<li><p style="margin:0">')
    .replace(/<p(?= style="|>)(?: style="([^"]*)")?/g, (m, own) => '<p' + merge('margin:0 0 0.6em')(m, own))
    .replace(/<h3(?= style="|>)(?: style="([^"]*)")?/g, (m, own) => '<h3' + merge('margin:0.8em 0 0.4em;font-size:1.15em')(m, own))
    .replace(/<(ul|ol)>/g, '<$1 style="margin:0 0 0.6em;padding-left:1.6em">')
    .replace(/<blockquote>/g, '<blockquote style="margin:0 0 0.6em;padding-left:0.9em;border-left:3px solid #d0d0d0;color:#555">')
    .replace(/<table(?= style="|[\s>])(?: style="([^"]*)")?/g, (m, own) => '<table' + merge('border-collapse:collapse;margin:0 0 0.6em')(m, own))
    .replace(/<(td|th)(?=[\s>])/g, '<$1 style="border:1px solid #d0d0d0;padding:6px 8px;vertical-align:top"')
    .replace(/<img(?=\s)/g, '<img style="max-width:100%;height:auto"');
}

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.6";

export function composeHtml(d: ComposeParts, signatureHtml?: string | null) {
  // HTML 源码模式：用户写什么发什么
  const own = d.bodyHtml ? (d.bodyFormat === 'html' ? d.bodyHtml : `<div style="${FONT}">${inlineEmailStyles(d.bodyHtml)}</div>`) : null;
  const sig =
    d.includeSignature !== false && signatureHtml
      ? `<div class="mh-signature" style="${FONT};margin-top:16px;color:#555">-- <br>${inlineEmailStyles(signatureHtml)}</div>`
      : '';
  const quote = d.includeQuote && d.quoteHtml ? `<br>${d.quoteHtml}` : '';
  if (!own && !sig && !quote) return undefined;
  return `${own ?? `<div style="white-space:pre-wrap;${FONT}">${escapeHtml(d.body)}</div>`}${sig}${quote}`;
}

const DATA_IMAGE = /(<img\b[^>]*?\bsrc=")data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)(")/gi;

/** 正文里的 data: 图片很多客户端不显示，发送前换成 cid: 内嵌附件 */
export function extractInlineImages(html: string, domain: string) {
  const images: Array<{ cid: string; filename: string; contentType: string; content: Buffer; contentDisposition: 'inline' }> = [];
  const out = html.replace(DATA_IMAGE, (_m, head: string, type: string, data: string, tail: string) => {
    const cid = `img${images.length + 1}.${randomBytes(6).toString('hex')}@${domain}`;
    const ext = type.split('/')[1]!.replace('jpeg', 'jpg');
    images.push({
      cid,
      filename: `image${images.length + 1}.${ext}`,
      contentType: type,
      content: Buffer.from(data.replace(/\s/g, ''), 'base64'),
      contentDisposition: 'inline',
    });
    return `${head}cid:${cid}${tail}`;
  });
  return { html: out, images };
}
