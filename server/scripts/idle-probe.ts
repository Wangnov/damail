/**
 * 调试：单独连接某账户的 INBOX 并进入 IDLE，打印服务器推送的 EXISTS 事件及时间。
 * 用法：tsx --env-file=../.env scripts/idle-probe.ts <accountId> [秒数，默认 90]
 */
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/index.js';
import { accounts } from '../src/db/schema.js';
import { decryptSecret } from '../src/lib/crypto.js';
import { createImapClient } from '../src/sync/imap.js';

const [id, secs = '90'] = process.argv.slice(2);
const account = await db.query.accounts.findFirst({ where: eq(accounts.id, Number(id)) });
if (!account) throw new Error('账户不存在');
const t = () => new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0');
const client = createImapClient({
  host: account.imapHost,
  port: account.imapPort,
  secure: account.imapSecure,
  username: account.username,
  password: decryptSecret(account.secretEnc),
});
await client.connect();
await client.mailboxOpen('INBOX', { readOnly: true });
console.log(`${t()} 已打开 INBOX，exists=${client.mailbox && client.mailbox.exists}，开始 IDLE`);
client.on('exists', (ev) => console.log(`${t()} EXISTS ${ev.prevCount} -> ${ev.count}`));
const timer = setTimeout(() => void client.logout(), Number(secs) * 1000);
await client.idle();
clearTimeout(timer);
console.log(`${t()} 结束`);
await pool.end();
