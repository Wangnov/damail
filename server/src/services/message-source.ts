import { eq } from 'drizzle-orm';
import type { MailboxObject } from 'imapflow';
import { db } from '../db/index.js';
import { accounts, folders, messages, type Message } from '../db/schema.js';
import { graphFetch } from '../sync/graph.js';
import { createImapClient } from '../sync/imap.js';
import { L } from '../i18n/index.js';
import { ActionError } from './actions.js';
import { restoreMessageContent } from './ingest.js';
import { accountCredentials } from './oauth.js';
import { proxyUrlById } from './proxy.js';

const pending = new Map<number, Promise<Message>>();

/** 后台保留大邮件预览；用户或 Agent 实际读取时才补取完整 MIME。 */
export async function completeMessage(message: Message): Promise<Message> {
  if (!message.truncated) return message;
  let request = pending.get(message.id);
  if (!request) {
    request = restore(message).finally(() => pending.delete(message.id));
    pending.set(message.id, request);
  }
  return request;
}

async function restore(message: Message): Promise<Message> {
  // 另一个请求可能已在数据库里补齐。
  const current = await db.query.messages.findFirst({ where: eq(messages.id, message.id) });
  if (!current) throw new ActionError(L('邮件不存在', 'Message not found'), 404);
  if (!current.truncated) return current;
  const source = await fetchSource(current);
  if (source.length < current.size) throw new ActionError(L('原始邮件下载不完整，请稍后重试', 'The original message download is incomplete; retry later'), 502);
  return restoreMessageContent(current, source);
}

async function fetchSource(message: Message): Promise<Buffer> {
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, message.accountId) });
  const folder = await db.query.folders.findFirst({ where: eq(folders.id, message.folderId) });
  if (!account || !folder) throw new ActionError(L('邮箱或文件夹不存在', 'Account or folder not found'), 404);
  if (account.protocol === 'graph') {
    if (!message.remoteId) throw new ActionError(L('邮件缺少远端标识，请重新同步', 'The message has no remote ID; sync the mailbox again'), 409);
    const res = await graphFetch(account, `/me/messages/${encodeURIComponent(message.remoteId)}/$value`, { timeoutMs: 300_000 });
    return Buffer.from(await res.arrayBuffer());
  }
  const client = createImapClient({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    username: account.username,
    ...(await accountCredentials(account)),
    proxy: await proxyUrlById(account.proxyId),
  });
  // 命令的 Promise 负责传播错误，避免 EventEmitter 的 error 事件中断进程。
  client.on('error', () => {});
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder.path, { readOnly: true });
    try {
      if (folder.uidValidity !== null && folder.uidValidity !== (client.mailbox as MailboxObject).uidValidity)
        throw new ActionError(L('文件夹标识已变化，请重新同步邮箱', 'The mailbox UIDVALIDITY changed; sync the mailbox again'), 409);
      const fetched = await client.fetchOne(message.uid, { uid: true, source: true }, { uid: true });
      if (!fetched || fetched.uid !== message.uid || !fetched.source)
        throw new ActionError(L('原始邮件已移动或删除，请重新同步', 'The original message was moved or deleted; sync the mailbox again'), 404);
      return fetched.source;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}
