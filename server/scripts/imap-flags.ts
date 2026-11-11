// 调试用：直接从 IMAP 服务器读取某文件夹最近几封邮件的标记
import { ImapFlow } from 'imapflow';
const [user, path = 'INBOX', n = '5'] = process.argv.slice(2);
const client = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: user!, pass: `${user}-pass` }, logger: false });
await client.connect();
const lock = await client.getMailboxLock(path, { readOnly: true });
const mb = client.mailbox as { exists: number };
if (mb.exists) for await (const m of client.fetch(`${Math.max(1, mb.exists - Number(n) + 1)}:*`, { uid: true, flags: true, envelope: true }))
  console.log(path, m.uid, [...(m.flags ?? [])].join(' '), m.envelope?.subject);
else console.log(path, '(空)');
lock.release();
await client.logout();
