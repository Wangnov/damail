/**
 * 本机端到端验收，需要 docker-compose.dev.yml 的 PostgreSQL 和 GreenMail。
 * TEST_DATABASE_URL 必须是独立测试库；只操作 GreenMail，不访问真实邮箱或发送 SMTP 邮件。
 * pnpm --filter server exec tsx scripts/verify-mail-completeness.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { ImapFlow } from 'imapflow';

process.env.TEST_DATABASE_URL ??= 'postgres://damail:damail@127.0.0.1:55434/damail_imap_test';
const { Browser, PASSWORD, setup } = await import('../test/helpers.js');
const env = await setup({ SYNC_ENABLED: 'true' });
const { syncEngine } = await import('../src/sync/engine.js');
const imap = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: 'alice', pass: 'alice-pass' }, logger: false });
imap.on('error', () => {});
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function waitFor<T>(fn: () => Promise<T | undefined | false>, label: string): Promise<T> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`超时：${label}`);
}

try {
  await imap.connect();
  const suffix = Date.now();
  const oldSubject = `history-${suffix}`;
  const largeSubject = `large-${suffix}`;
  const old = Buffer.from(
    `From: old@example.com\r\nTo: alice@local.test\r\nDate: Sun, 17 Jan 2010 00:00:00 +0000\r\nMessage-ID: <old-${suffix}@local.test>\r\nSubject: ${oldSubject}\r\n\r\n2010 invoice`,
  );
  const pdf = Buffer.from('%PDF-1.4\nlocal test invoice\n%%EOF\n');
  const large = Buffer.from(
    [
      'From: invoice@example.com',
      'To: alice@local.test',
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <large-${suffix}@local.test>`,
      `Subject: ${largeSubject}`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="local-invoice"',
      '',
      '--local-invoice',
      'Content-Type: text/plain',
      '',
      'Local integration fixture',
      '--local-invoice',
      'Content-Type: application/octet-stream',
      'Content-Disposition: attachment; filename="padding.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.alloc(24 * 1024 * 1024, 65).toString('base64'),
      '--local-invoice',
      'Content-Type: application/pdf',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      pdf.toString('base64'),
      '--local-invoice--',
      '',
    ].join('\r\n'),
  );
  assert.ok(large.length > 30 * 1024 * 1024);
  await imap.append('INBOX', old, [], new Date('2010-01-17T00:00:00Z'));
  await imap.append('INBOX', large, [], new Date());

  const browser = new Browser(env.base);
  assert.equal(
    (
      await browser.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: PASSWORD }),
      })
    ).status,
    200,
  );
  const created = await browser.request('/api/admin/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-damail': '1' },
    body: JSON.stringify({
      name: 'Local IMAP verification',
      email: 'alice@local.test',
      provider: 'custom',
      username: 'alice',
      secret: 'alice-pass',
      imapHost: '127.0.0.1',
      imapPort: 3143,
      imapSecure: false,
      syncSinceDays: 90,
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const account = (await created.json()) as { id: number };
  const { accounts, messages, folders } = env.schema;
  const find = (subject: string) => env.db.query.messages.findFirst({ where: and(eq(messages.accountId, account.id), eq(messages.subject, subject)) });
  await waitFor(async () => (await env.db.query.accounts.findFirst({ where: eq(accounts.id, account.id) }))?.status === 'idle', '首次同步');
  assert.equal(await find(oldSubject), undefined);
  const preview = await find(largeSubject);
  assert.ok(preview?.truncated, '后台先保存超大邮件预览');
  assert.equal(preview.attachments.length, 1, 'PDF 在预览末尾之后');

  const headers = { authorization: `Bearer ${env.apiKey.value}` };
  const downloaded = await fetch(`${env.base}/api/v1/messages/${preview.id}/attachments/1`, { headers });
  assert.equal(downloaded.status, 200, await downloaded.clone().text());
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), pdf);
  const raw = await fetch(`${env.base}/api/v1/messages/${preview.id}/raw`, { headers });
  assert.equal(raw.status, 200);
  const actual = Buffer.from(await raw.arrayBuffer());
  assert.equal(hash(actual), hash(large), '完整 MIME 的 SHA-256 必须一致');
  assert.equal((await find(largeSubject))!.truncated, false);

  const expanded = await browser.request(`/api/admin/accounts/${account.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-damail': '1' },
    body: JSON.stringify({ syncSinceDays: 0 }),
  });
  assert.equal(expanded.status, 200, await expanded.clone().text());
  const historical = await waitFor(() => find(oldSubject), '回补 2010 年邮件');
  assert.equal(historical.date.getUTCFullYear(), 2010);
  assert.equal((await find(largeSubject))!.id, preview.id, '回补保留已有邮件 ID');
  assert.equal((await find(largeSubject))!.truncated, false, '回补保留已补齐的原件');

  const lock = await imap.getMailboxLock('INBOX', { readOnly: true });
  try {
    const remote = await imap.fetchOne(preview.uid, { uid: true, flags: true }, { uid: true });
    assert.ok(remote && !remote.flags?.has('\\Seen'), '下载不能把远端标为已读');
  } finally {
    lock.release();
  }

  await syncEngine.stopAll();
  const folder = await env.db.query.folders.findFirst({ where: eq(folders.id, preview.folderId) });
  await env.db
    .update(folders)
    .set({ uidValidity: folder!.uidValidity! + 1n })
    .where(eq(folders.id, preview.folderId));
  await env.db.update(messages).set({ truncated: true }).where(eq(messages.id, preview.id));
  assert.equal((await fetch(`${env.base}/api/v1/messages/${preview.id}/raw`, { headers })).status, 409, 'UIDVALIDITY 变化时拒绝取错邮件');
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        originalBytes: large.length,
        downloadedBytes: actual.length,
        sha256: hash(actual),
        historicalYear: historical.date.getUTCFullYear(),
        localIdPreserved: true,
        remoteSeen: false,
        staleUidValidityStatus: 409,
      },
      null,
      2,
    ),
  );
} finally {
  await syncEngine.stopAll();
  await imap.logout().catch(() => imap.close());
  await env.close();
}
