import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { eq } from 'drizzle-orm';
import type { ImapFlow } from 'imapflow';
import { Browser, PASSWORD, setup, type Env } from './helpers.js';

let env: Env;
let browser: Browser;
before(async () => {
  env = await setup();
  browser = new Browser(env.base);
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
});
after(async () => {
  await env?.close();
});

const patchHistory = (days: number) =>
  browser.request(`/api/admin/accounts/${env.accounts.work.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-damail': '1' },
    body: JSON.stringify({ syncSinceDays: days }),
  });

test('history: allow all mail and mail older than ten years; reject negative days', async () => {
  for (const days of [0, 6000]) {
    const res = await patchHistory(days);
    assert.equal(res.status, 200, await res.text());
  }
  assert.equal((await patchHistory(-1)).status, 400);
});

test('history: widening a window replays IMAP and Graph checkpoints without deleting local mail', async () => {
  const { accounts, folders, messages } = env.schema;
  await env.db.update(accounts).set({ syncSinceDays: 90 }).where(eq(accounts.id, env.accounts.work.id));
  const folder = (await env.db.select().from(folders).where(eq(folders.accountId, env.accounts.work.id)))[0]!;
  await env.db.update(folders).set({ lastUid: 250, highestModseq: 9n, deltaLink: 'old-delta' }).where(eq(folders.id, folder.id));
  assert.equal((await patchHistory(365)).status, 200);
  const updated = await env.db.query.folders.findFirst({ where: eq(folders.id, folder.id) });
  assert.equal(updated!.lastUid, 0);
  assert.equal(updated!.highestModseq, null);
  assert.equal(updated!.deltaLink, null);
  assert.ok(await env.db.query.messages.findFirst({ where: eq(messages.id, env.messages.work.id) }));
});

test('history: narrowing a window keeps existing checkpoints', async () => {
  const { accounts, folders } = env.schema;
  await env.db.update(accounts).set({ syncSinceDays: 365 }).where(eq(accounts.id, env.accounts.work.id));
  const folder = (await env.db.select().from(folders).where(eq(folders.accountId, env.accounts.work.id)))[0]!;
  await env.db.update(folders).set({ lastUid: 250, highestModseq: 9n, deltaLink: 'keep-delta' }).where(eq(folders.id, folder.id));
  assert.equal((await patchHistory(30)).status, 200);
  const updated = await env.db.query.folders.findFirst({ where: eq(folders.id, folder.id) });
  assert.equal(updated!.lastUid, 250);
  assert.equal(updated!.deltaLink, 'keep-delta');
});

test('history: IMAP all-mail sync actually imports a 2010 message', async () => {
  const { AccountWorker } = await import('../src/sync/account-worker.js');
  const { folders, messages } = env.schema;
  const [folder] = await env.db.insert(folders).values({ accountId: env.accounts.home.id, path: 'Old', name: 'Old' }).returning();
  const date = new Date('2010-01-17T00:00:00Z');
  const raw = Buffer.from(
    'From: old@example.com\r\nTo: home@local.test\r\nDate: Sun, 17 Jan 2010 00:00:00 +0000\r\nMessage-ID: <old-2010@local.test>\r\nSubject: Old invoice\r\n\r\nold invoice',
  );
  const client = {
    mailbox: { exists: 1, uidValidity: 1n },
    capabilities: new Map(),
    getMailboxLock: async () => ({ release() {} }),
    search: async (query: { since?: Date }) => (query.since && query.since > date ? [] : [7]),
    fetchAll: async (_range: unknown, query: { source?: unknown; size?: boolean }) =>
      query.source ? [{ uid: 7, source: raw, size: raw.length, internalDate: date, flags: new Set() }] : query.size ? [{ uid: 7, size: raw.length }] : [],
  } as unknown as ImapFlow;
  const worker = new AccountWorker(env.accounts.home.id);
  Reflect.set(worker, 'syncDays', 0);
  await Reflect.get(worker, 'syncFolder').call(worker, client, folder, false);
  const old = await env.db.query.messages.findFirst({ where: eq(messages.folderId, folder!.id) });
  assert.equal(old?.subject, 'Old invoice');
});

test('history: Graph all-mail delta has no date cutoff', async () => {
  const { GraphWorker } = await import('../src/sync/graph-worker.js');
  const worker = new GraphWorker(env.accounts.work.id);
  Reflect.set(worker, 'syncDays', 0);
  const url = Reflect.get(worker, 'initialDeltaUrl').call(worker, { remoteId: 'inbox' });
  assert.equal(new URL(url, 'https://graph.microsoft.com').searchParams.has('$filter'), false);
});

for (const protocol of ['imap', 'graph'])
  test(`history: stopping ${protocol} waits for an in-flight sync before resetting checkpoints`, async () => {
    const { AccountWorker } = await import('../src/sync/account-worker.js');
    const { GraphWorker } = await import('../src/sync/graph-worker.js');
    const worker = protocol === 'imap' ? new AccountWorker(env.accounts.work.id) : new GraphWorker(env.accounts.work.id);
    let finish!: () => void;
    Reflect.set(
      worker,
      'draining',
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    finish();
    await stopping;
    assert.equal(stopped, true);
  });

const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function apiHeaders(scopes: string[], accountIds: number[] | null = null) {
  const { generateApiKey, sha256 } = await import('../src/lib/crypto.js');
  const value = generateApiKey();
  await env.db
    .insert(env.schema.apiKeys)
    .values({ userId: env.users.alice.id, name: 'mail-test', prefix: value.slice(0, 8), keyHash: sha256(value), scopes, accountIds });
  return { authorization: `Bearer ${value}`, 'content-type': 'application/json' };
}
let uid = 2000;
async function truncatedGraphMail() {
  const { encryptSecret } = await import('../src/lib/crypto.js');
  const { ingestMessage } = await import('../src/services/ingest.js');
  const { accounts, folders } = env.schema;
  await env.db
    .update(accounts)
    .set({
      protocol: 'graph',
      authType: 'oauth2',
      provider: 'outlook',
      secretEnc: encryptSecret(JSON.stringify({ refreshToken: 'test-refresh', accessToken: 'test-access', expiresAt: Date.now() + 3600_000 })),
    })
    .where(eq(accounts.id, env.accounts.work.id));
  const folder = (await env.db.select().from(folders).where(eq(folders.accountId, env.accounts.work.id)))[0]!;
  const pdf = Buffer.from('%PDF-1.4\ninvoice original\n%%EOF\n');
  const raw = Buffer.from(
    [
      'From: invoice@example.com',
      'To: work@local.test',
      `Message-ID: <large-${++uid}@local.test>`,
      'Subject: Large invoice',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="invoice-test"',
      '',
      '--invoice-test',
      'Content-Type: text/plain',
      '',
      'Invoice attached',
      '--invoice-test',
      'Content-Type: application/octet-stream',
      'Content-Disposition: attachment; filename="padding.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.alloc(3 * 1024 * 1024, 65).toString('base64'),
      '--invoice-test',
      'Content-Type: application/pdf',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      pdf.toString('base64'),
      '--invoice-test--',
      '',
    ].join('\r\n'),
  );
  const row = await ingestMessage({
    accountId: env.accounts.work.id,
    folderId: folder.id,
    uid,
    remoteId: `large-${uid}`,
    source: raw.subarray(0, 2 * 1024 * 1024),
    size: raw.length,
    truncated: true,
    flags: [],
  });
  return { id: row.id, raw, pdf, remoteId: `large-${uid}` };
}

test('download: raw MIME is complete, cached, and does not change read state', async (t) => {
  const fixture = await truncatedGraphMail();
  let requests = 0;
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).startsWith('https://graph.microsoft.com/')) {
      requests++;
      return new Response(fixture.raw);
    }
    return original(input, init);
  });
  const headers = { authorization: `Bearer ${env.apiKey.value}` };
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${env.base}/api/v1/messages/${fixture.id}/raw`, { headers });
    assert.equal(res.status, 200);
    assert.equal(digest(Buffer.from(await res.arrayBuffer())), digest(fixture.raw));
  }
  assert.equal(requests, 1, 'the second request uses the complete local cache');
  const row = await env.db.query.messages.findFirst({ where: eq(env.schema.messages.id, fixture.id) });
  assert.equal(row!.truncated, false);
  assert.equal(row!.seen, false);
  assert.equal(row!.attachments.length, 2);
});

test('download: a PDF after the truncated preview can be downloaded intact', async (t) => {
  const fixture = await truncatedGraphMail();
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    String(input).startsWith('https://graph.microsoft.com/') ? new Response(fixture.raw) : original(input, init),
  );
  const res = await fetch(`${env.base}/api/v1/messages/${fixture.id}/attachments/1`, { headers: { authorization: `Bearer ${env.apiKey.value}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), fixture.pdf);
});

test('download: simultaneous detail and raw requests share one remote fetch', async (t) => {
  const fixture = await truncatedGraphMail();
  let requests = 0;
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).startsWith('https://graph.microsoft.com/')) {
      requests++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(fixture.raw);
    }
    return original(input, init);
  });
  const headers = { authorization: `Bearer ${env.apiKey.value}` };
  const [detail, raw] = await Promise.all([
    fetch(`${env.base}/api/v1/messages/${fixture.id}`, { headers }),
    fetch(`${env.base}/api/v1/messages/${fixture.id}/raw`, { headers }),
  ]);
  assert.equal(detail.status, 200);
  const mail = (await detail.json()) as { attachments: unknown[]; truncated: boolean };
  assert.equal(mail.attachments.length, 2);
  assert.equal(mail.truncated, false);
  assert.equal(digest(Buffer.from(await raw.arrayBuffer())), digest(fixture.raw));
  assert.equal(requests, 1);
});

test('download: short upstream responses fail and a later request can retry', async (t) => {
  const fixture = await truncatedGraphMail();
  let complete = false;
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    String(input).startsWith('https://graph.microsoft.com/') ? new Response(complete ? fixture.raw : fixture.raw.subarray(0, 100)) : original(input, init),
  );
  const headers = { authorization: `Bearer ${env.apiKey.value}` };
  const path = `${env.base}/api/v1/messages/${fixture.id}/raw`;
  assert.equal((await fetch(path, { headers })).status, 502);
  assert.equal((await env.db.query.messages.findFirst({ where: eq(env.schema.messages.id, fixture.id) }))!.truncated, true);
  complete = true;
  const res = await fetch(path, { headers });
  assert.equal(res.status, 200);
  assert.equal(digest(Buffer.from(await res.arrayBuffer())), digest(fixture.raw));
});

test('download: out-of-scope keys cannot cause a remote fetch', async (t) => {
  const fixture = await truncatedGraphMail();
  let requests = 0;
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).startsWith('https://graph.microsoft.com/')) {
      requests++;
      return new Response(fixture.raw);
    }
    return original(input, init);
  });
  const headers = await apiHeaders(['read'], [env.accounts.home.id]);
  for (const suffix of ['', '/raw', '/attachments/1'])
    assert.equal((await fetch(`${env.base}/api/v1/messages/${fixture.id}${suffix}`, { headers })).status, 404);
  assert.equal(requests, 0);
});

test('download: a different Message-ID is rejected and cannot replace the cache', async (t) => {
  const fixture = await truncatedGraphMail();
  const original = globalThis.fetch;
  const wrong = Buffer.from(fixture.raw.toString().replace(`large-${uid}@local.test`, 'wrong-message@local.test'));
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    String(input).startsWith('https://graph.microsoft.com/') ? new Response(wrong) : original(input, init),
  );
  const res = await fetch(`${env.base}/api/v1/messages/${fixture.id}/raw`, { headers: { authorization: `Bearer ${env.apiKey.value}` } });
  assert.equal(res.status, 409);
  const row = await env.db.query.messages.findFirst({ where: eq(env.schema.messages.id, fixture.id) });
  assert.equal(row!.truncated, true);
  assert.notEqual(row!.messageId, '<wrong-message@local.test>');
});

test('REST: ignore-list CRUD accepts automation keys and enforces mailbox scope', async () => {
  const headers = await apiHeaders(['read', 'automation']);
  const path = `${env.base}/api/v1/ignored-senders`;
  assert.equal((await fetch(path)).status, 401);
  assert.equal((await fetch(path, { headers: await apiHeaders(['read']) })).status, 403);
  assert.equal((await fetch(path, { headers: await apiHeaders(['read', 'automation'], [env.accounts.work.id]) })).status, 403);
  const added = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ pattern: 'NEWS.EXAMPLE.COM' }) });
  assert.equal(added.status, 200);
  assert.equal(((await added.json()) as { pattern: string }).pattern, '@news.example.com');
  const listed = await fetch(path, { headers });
  assert.equal(listed.status, 200);
  assert.ok(((await listed.json()) as { pattern: string }[]).some((r) => r.pattern === '@news.example.com'));
  assert.equal((await fetch(`${path}/${encodeURIComponent('@news.example.com')}`, { method: 'DELETE', headers })).status, 200);
  assert.equal((await fetch(path, { method: 'POST', headers, body: JSON.stringify({ pattern: 'bad pattern' }) })).status, 400);
});
