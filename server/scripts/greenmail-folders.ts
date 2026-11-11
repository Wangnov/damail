// 在 GreenMail 测试账号里创建「已发送 / 已删除 / 归档」等文件夹（GreenMail 默认只有 INBOX）
import { ImapFlow } from 'imapflow';

for (const user of process.argv.slice(2)) {
  const client = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user, pass: `${user}-pass` }, logger: false });
  await client.connect();
  for (const path of ['Sent', 'Trash', 'Archive', 'Junk', 'Drafts']) await client.mailboxCreate(path).catch(() => {});
  console.log(user, (await client.list()).map((f) => `${f.path}${f.specialUse ? `(${f.specialUse})` : ''}`).join(' '));
  await client.logout();
}
