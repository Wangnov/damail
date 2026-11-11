import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { SocksClient } from 'socks';
import type Mail from 'nodemailer/lib/mailer/index.js';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { accounts, drafts, folders, type Account, type Address, type Draft } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { accountCredentials } from './oauth.js';
import { proxyUrlById } from './proxy.js';
import { bus } from '../lib/events.js';
import { syncEngine } from '../sync/engine.js';
import { describeGraphError, graphFetch } from '../sync/graph.js';
import { withImapWriter } from '../sync/imap-writer.js';
import { getProvider } from '../sync/providers.js';
import { setFlags } from './actions.js';
import { composeHtml, composeText, extractInlineImages } from './drafts.js';
import { emitDraftEvent } from './notify.js';
import { createFollowUpForSent } from './followups.js';
import { L } from '../i18n/index.js';

const TICK_MS = 2000;
const MAX_ATTEMPTS = 3;

type SmtpParams = { host: string; port: number; secure: boolean; username: string; password?: string; accessToken?: string; proxy?: string };

function createTransport(p: SmtpParams) {
  const transport = nodemailer.createTransport({
    host: p.host,
    port: p.port,
    // 465 走隐式 TLS；587/25 由 nodemailer 自动 STARTTLS
    secure: p.secure,
    auth: p.accessToken ? { type: 'OAuth2', user: p.username, accessToken: p.accessToken } : { user: p.username, pass: p.password },
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
    socketTimeout: 120_000,
    ...(p.proxy ? { proxy: p.proxy } : {}),
  });
  // nodemailer 自带 HTTP 代理，SOCKS 要把模块交给它
  if (p.proxy) transport.set('proxy_socks_module', { SocksClient });
  return transport;
}

type SmtpError = Error & { code?: string; responseCode?: number; response?: string; command?: string };

export function describeSmtpError(err: unknown): string {
  const e = err as SmtpError;
  const text = `${e?.response ?? ''} ${e?.message ?? ''}`;
  if (e?.code === 'EAUTH' || /authentication|535|LOGIN/i.test(text))
    return L(
      'SMTP 认证失败：请确认已开启 SMTP 服务，并使用授权码 / 应用专用密码',
      'SMTP authentication failed: make sure SMTP is enabled and use an app password or authorization code',
    );
  if (e?.code === 'EDNS' || /ENOTFOUND/.test(text)) return L('无法解析 SMTP 服务器地址', 'Could not resolve the SMTP server address');
  if (e?.code === 'ETIMEDOUT' || /timeout/i.test(text))
    return L(
      'SMTP 连接超时：服务器无法访问（网络、防火墙或地区限制）',
      'SMTP connection timed out: the server is unreachable (network, firewall or regional restrictions)',
    );
  if (e?.code === 'ECONNECTION' || /ECONNREFUSED/.test(text))
    return L('SMTP 服务器拒绝连接，请检查端口与 SSL 设置', 'The SMTP server refused the connection; check the port and SSL settings');
  if (e?.code === 'EENVELOPE') return L(`收件人被服务器拒绝：${e.response ?? e.message}`, `Recipient rejected by the server: ${e.response ?? e.message}`);
  if (e?.responseCode && e.responseCode >= 500)
    return L(`服务器拒绝发送（${e.responseCode}）：${e.response ?? e.message}`, `The server refused to send (${e.responseCode}): ${e.response ?? e.message}`);
  return e?.response || e?.message || String(err);
}

/** 只有在建立连接阶段失败时才自动重试，避免服务器已收下邮件却因超时被重复发送 */
function isRetryable(err: unknown) {
  const e = err as SmtpError;
  return e?.command === 'CONN' || e?.code === 'EDNS' || (e?.code === 'ECONNECTION' && !e.responseCode);
}

export async function testSmtpConnection(p: SmtpParams) {
  const transport = createTransport(p);
  try {
    await transport.verify();
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: describeSmtpError(err) };
  } finally {
    transport.close();
  }
}

const toMailAddress = (a: Address) => (a.name ? { name: a.name, address: a.address! } : a.address!);

async function buildMail(d: Draft, account: Account): Promise<Mail.Options> {
  const domain = account.email.split('@')[1] ?? 'damail.local';
  const attachments = await Promise.all(
    d.attachments.map(async (a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: await readFile(path.join(config.uploadDir, a.path)),
    })),
  );
  const html = composeHtml(d, account.signatureHtml);
  const inline = html ? extractInlineImages(html, domain) : { html: undefined, images: [] };
  return {
    from: account.displayName ? { name: account.displayName, address: account.email } : account.email,
    to: d.to.map(toMailAddress),
    cc: d.cc.map(toMailAddress),
    bcc: d.bcc.map(toMailAddress),
    subject: d.subject,
    text: composeText(d, account.signatureHtml),
    html: inline.html,
    attachments: [...attachments, ...inline.images],
    messageId: `<${randomUUID()}@${domain}>`,
    date: new Date(),
    inReplyTo: d.inReplyTo ?? undefined,
    references: d.references.length ? d.references : undefined,
    headers: { 'X-Mailer': 'DaMail' },
  };
}

// Graph 发信请求体上限 4MB（MIME 经 base64 后计算）
const GRAPH_SEND_LIMIT = 4 * 1024 * 1024;

/** Graph 账户直接提交原始 MIME，服务器会自动存一份到「已发送邮件」 */
async function sendViaGraph(account: Account, mail: Mail.Options) {
  const node = new MailComposer(mail).compile();
  // 密送人只能从 MIME 头里读到
  (node as unknown as { keepBcc: boolean }).keepBcc = true;
  const body = (await node.build()).toString('base64');
  if (body.length > GRAPH_SEND_LIMIT)
    throw new Error(
      L(
        '邮件超过 4MB（含附件），微软 Graph 发信暂不支持这么大的邮件',
        'The message exceeds 4 MB (including attachments); sending through Microsoft Graph does not support messages this large',
      ),
    );
  await graphFetch(account, '/me/sendMail', { method: 'POST', body, contentType: 'text/plain', timeoutMs: 120_000 });
}

/** 存一份到「已发送」。部分服务商会自动保存 SMTP 发出的邮件，先按 Message-ID 查一下避免重复 */
async function saveToSent(account: Account, mail: Mail.Options): Promise<string | null> {
  if (getProvider(account.provider).autoSavesSent) return null;
  const sent = await db.query.folders.findFirst({
    where: and(eq(folders.accountId, account.id), eq(folders.specialUse, '\\Sent')),
  });
  if (!sent) return L('没有找到「已发送」文件夹，未保存副本', 'No Sent folder found; no copy was saved');

  const node = new MailComposer(mail).compile();
  // 已发送副本保留密送人，方便自己查看
  (node as unknown as { keepBcc: boolean }).keepBcc = true;
  const raw = await node.build();

  await new Promise((r) => setTimeout(r, 3000));
  await withImapWriter(account.id, async (client) => {
    const lock = await client.getMailboxLock(sent.path);
    try {
      const found = await client.search({ header: { 'message-id': String(mail.messageId) } }, { uid: true });
      if (found && found.length) return;
    } finally {
      lock.release();
    }
    await client.append(sent.path, raw, ['\\Seen'], mail.date as Date);
  });
  return null;
}

async function deliver(d: Draft) {
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, d.accountId) });
  if (!account) return finish(d, 'failed', L('账户不存在', 'Account not found'));
  const graph = account.protocol === 'graph';
  if (!graph && !account.smtpHost) return finish(d, 'failed', L('该账户没有配置 SMTP 服务器', 'This account has no SMTP server configured'));

  let mail: Mail.Options;
  try {
    mail = await buildMail(d, account);
  } catch (err) {
    return finish(d, 'failed', L(`生成邮件失败：${(err as Error).message}`, `Failed to build the message: ${(err as Error).message}`));
  }

  if (graph) {
    try {
      await sendViaGraph(account, mail);
    } catch (err) {
      // 微软可能已收下邮件只是响应超时，不自动重试，避免重复发送（限流已在 graphFetch 里重试）
      const message = describeGraphError(err);
      console.warn(`[send] 草稿 ${d.id} 发送失败：${message}`);
      return finish(d, 'failed', message);
    }
  } else {
    const transport = createTransport({
      host: account.smtpHost!,
      port: account.smtpPort ?? 465,
      secure: account.smtpSecure ?? true,
      username: account.username,
      ...(await accountCredentials(account)),
      proxy: await proxyUrlById(account.proxyId),
    });
    try {
      await transport.sendMail(mail);
    } catch (err) {
      const message = describeSmtpError(err);
      console.warn(`[send] 草稿 ${d.id} 发送失败（第 ${d.attempts} 次）：${message}`);
      if (isRetryable(err) && d.attempts < MAX_ATTEMPTS) {
        const [row] = await db
          .update(drafts)
          .set({
            status: 'queued',
            sendAt: new Date(Date.now() + 60_000 * d.attempts),
            error: L(`${message}，稍后自动重试`, `${message}; will retry automatically`),
            updatedAt: new Date(),
          })
          .where(eq(drafts.id, d.id))
          .returning();
        return publish(row!);
      }
      return finish(d, 'failed', message);
    } finally {
      transport.close();
    }
  }

  await finish(d, 'sent', null, String(mail.messageId));
  console.log(`[send] 草稿 ${d.id} 已通过 ${account.email} 发出`);

  // 以下为发出后的收尾工作，失败只记录，不影响「已发送」状态
  const notes: string[] = [];
  if (!graph) {
    try {
      const note = await saveToSent(account, mail);
      if (note) notes.push(note);
    } catch (err) {
      notes.push(L(`保存到「已发送」失败：${(err as Error).message}`, `Failed to save to Sent: ${(err as Error).message}`));
    }
  }
  if (d.sourceMessageId && (d.mode === 'reply' || d.mode === 'replyAll')) {
    try {
      await setFlags({ accountIds: null }, [d.sourceMessageId], { answered: true });
    } catch {
      // 原邮件可能已被移动，忽略
    }
  }
  if (d.followUpDays && mail.messageId) {
    try {
      await createFollowUpForSent({ accountId: d.accountId, messageId: String(mail.messageId), subject: d.subject, to: d.to, days: d.followUpDays });
    } catch (err) {
      notes.push(L(`创建跟进提醒失败：${(err as Error).message}`, `Failed to create the follow-up reminder: ${(err as Error).message}`));
    }
  }
  if (notes.length)
    await db
      .update(drafts)
      .set({ error: notes.join('；') })
      .where(eq(drafts.id, d.id));
  syncEngine.syncNow(account.id);
}

function publish(d: Draft) {
  bus.publish({ type: 'drafts.updated', accountId: d.accountId, draftId: d.id, status: d.status });
}

async function finish(d: Draft, status: 'sent' | 'failed', error: string | null, sentMessageId?: string) {
  const [row] = await db
    .update(drafts)
    .set({ status, error, sentMessageId, sentAt: status === 'sent' ? new Date() : null, updatedAt: new Date() })
    .where(eq(drafts.id, d.id))
    .returning();
  audit('system', `draft.${status}`, { accountId: d.accountId, target: `draft:${d.id}`, detail: error ? { error } : undefined });
  publish(row!);
  emitDraftEvent(`draft.${status}`, row!);
}

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    // 原子地认领到期的邮件，多实例部署时也不会重复发送
    const due = await db
      .update(drafts)
      .set({ status: 'sending', attempts: sql`${drafts.attempts} + 1`, updatedAt: new Date() })
      .where(sql`${drafts.id} IN (SELECT id FROM drafts WHERE status = 'queued' AND send_at <= now() ORDER BY send_at LIMIT 5 FOR UPDATE SKIP LOCKED)`)
      .returning();
    for (const d of due) {
      publish(d);
      await deliver(d).catch((err) => finish(d, 'failed', describeSmtpError(err)));
    }
  } catch (err) {
    console.warn('[send] 发件队列出错', err);
  } finally {
    running = false;
  }
}

export async function startOutbox() {
  // 上次退出时正在发送的邮件无法确认是否已发出，标记为失败交给用户判断，不自动重发
  const stuck = await db
    .update(drafts)
    .set({
      status: 'failed',
      error: L(
        '服务重启时这封邮件正在发送，无法确认是否已发出，请先检查「已发送」再决定是否重发',
        'The service restarted while this message was sending, so it is unknown whether it went out. Check Sent before resending',
      ),
    })
    .where(eq(drafts.status, 'sending'))
    .returning({ id: drafts.id });
  if (stuck.length) console.warn(`[send] ${stuck.length} 封邮件发送状态未知，已标记为失败`);
  timer = setInterval(() => void tick(), TICK_MS);
}

export function stopOutbox() {
  if (timer) clearInterval(timer);
  timer = null;
}
