/**
 * 调试：在某个账户的服务器端各文件夹中按主题搜索邮件（只读）。
 * 用法：tsx --env-file=../.env scripts/find-on-server.ts <accountId> <主题关键词 | uid:INBOX:123>
 * 注意：部分服务商（如阿里邮箱）的 SEARCH 不解码 MIME 编码的主题，中文/编码主题可能搜不到，可改用 uid: 形式
 */
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/index.js';
import { accounts } from '../src/db/schema.js';
import { decryptSecret } from '../src/lib/crypto.js';
import { createImapClient } from '../src/sync/imap.js';

const [id, keyword] = process.argv.slice(2);
const account = await db.query.accounts.findFirst({ where: eq(accounts.id, Number(id)) });
if (!account || !keyword) throw new Error('用法: find-on-server.ts <accountId> <关键词>');
const client = createImapClient({
  host: account.imapHost,
  port: account.imapPort,
  secure: account.imapSecure,
  username: account.username,
  password: decryptSecret(account.secretEnc),
});
await client.connect();
if (keyword.startsWith('uid:')) {
  const [, path, uid] = keyword.split(':');
  const lock = await client.getMailboxLock(path!, { readOnly: true });
  for (const m of await client.fetchAll(uid!, { uid: true, envelope: true, internalDate: true }, { uid: true })) {
    console.log(`${path} uid=${m.uid} internalDate=${new Date(m.internalDate!).toLocaleTimeString('zh-CN')} headerDate=${m.envelope?.date ? new Date(m.envelope.date).toLocaleTimeString('zh-CN') : '-'} subject=${m.envelope?.subject}`);
  }
  lock.release();
  await client.logout();
  await pool.end();
  process.exit(0);
}
for (const f of await client.list()) {
  if (f.flags.has('\\Noselect')) continue;
  const lock = await client.getMailboxLock(f.path, { readOnly: true });
  try {
    const uids = (await client.search({ subject: keyword }, { uid: true })) || [];
    if (uids.length) {
      for (const m of await client.fetchAll(uids, { uid: true, envelope: true, internalDate: true }, { uid: true })) {
        console.log(`${f.path} uid=${m.uid} internalDate=${new Date(m.internalDate!).toLocaleTimeString('zh-CN')} subject=${m.envelope?.subject}`);
      }
    }
  } finally {
    lock.release();
  }
}
await client.logout();
await pool.end();
