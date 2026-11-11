// 调试用（只读）：在服务器上按 Message-ID 查找各文件夹里的副本
// 用法：tsx --env-file=../.env scripts/check-message-id.ts <账户ID> "<message-id>" [文件夹...]
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/index.js';
import { accounts } from '../src/db/schema.js';
import { decryptSecret } from '../src/lib/crypto.js';
import { createImapClient } from '../src/sync/imap.js';

const [accountId, messageId, ...paths] = process.argv.slice(2);
const account = await db.query.accounts.findFirst({ where: eq(accounts.id, Number(accountId)) });
if (!account) throw new Error('账户不存在');
const client = createImapClient({
  host: account.imapHost,
  port: account.imapPort,
  secure: account.imapSecure,
  username: account.username,
  password: decryptSecret(account.secretEnc),
});
await client.connect();
for (const path of paths.length ? paths : ['INBOX']) {
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const uids = (await client.search({ header: { 'message-id': messageId! } }, { uid: true })) || [];
    console.log(`${path}: ${uids.length} 封`, uids);
  } finally {
    lock.release();
  }
}
await client.logout();
await pool.end();
