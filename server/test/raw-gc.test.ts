/**
 * 原始邮件文件清理（services/raw-gc.ts）：没有引用的旧文件删掉，被引用、刚写入、
 * 正在使用的保留；已删除邮箱的目录整个删掉；不跟随符号链接。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { PASSWORD, setup, Browser, type Env } from './helpers.js';

let env: Env;
let config: typeof import('../src/config.js').config;
let gc: typeof import('../src/services/raw-gc.js');

before(async () => {
  env = await setup();
  config = (await import('../src/config.js')).config;
  gc = await import('../src/services/raw-gc.js');
});
after(async () => {
  await env?.close();
});

const hash = (n: number) => n.toString(16).padStart(64, '0');
const old = new Date(Date.now() - 24 * 3600_000);

/** 在 rawDir 下建一个原始邮件文件，返回相对路径；默认把修改时间设成一天前 */
function rawFile(accountId: number, n: number, { fresh = false } = {}) {
  const h = hash(n);
  const rel = path.join(String(accountId), h.slice(0, 2), `${h}.eml`);
  const abs = path.join(config.rawDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, `raw ${n}`);
  if (!fresh) utimesSync(abs, old, old);
  return rel;
}
const exists = (rel: string) => existsSync(path.join(config.rawDir, rel));

describe('collectRawGarbage', () => {
  test('只删没有引用、超过宽限期、最近没被使用的文件', async () => {
    const acc = env.accounts.work.id;
    const referenced = rawFile(acc, 1);
    const orphan = rawFile(acc, 2);
    const fresh = rawFile(acc, 3, { fresh: true });
    const marked = rawFile(acc, 4);
    gc.markRawInUse(marked);
    await env.db.update(env.schema.messages).set({ rawPath: referenced }).where(eq(env.schema.messages.id, env.messages.work.id));

    // 命名不符合格式的文件和指向外部的符号链接都不碰
    const stray = path.join(String(acc), '00', 'notes.txt');
    writeFileSync(path.join(config.rawDir, stray), 'keep');
    const outside = path.join(mkdtempSync(path.join(os.tmpdir(), 'damail-outside-')), 'victim.eml');
    writeFileSync(outside, 'outside');
    const link = path.join(String(acc), '00', `${hash(5)}.eml`);
    symlinkSync(outside, path.join(config.rawDir, link));

    // 已删除邮箱的目录
    const gone = rawFile(99_999, 6, { fresh: true });

    const r = await gc.collectRawGarbage({ graceMs: 3600_000 });
    assert.equal(exists(referenced), true, '被引用的保留');
    assert.equal(exists(orphan), false, '没引用的旧文件删掉');
    assert.equal(exists(fresh), true, '宽限期内的保留');
    assert.equal(exists(marked), true, '正在使用的保留');
    assert.equal(exists(stray), true);
    assert.equal(existsSync(path.join(config.rawDir, link)), true, '符号链接不处理');
    assert.equal(existsSync(outside), true);
    assert.equal(exists(gone), false, '已删除邮箱的目录整个删掉');
    assert.deepEqual([r.files, r.accounts], [1, 1]);
  });

  test('复用已有的旧文件后不会被清理（内存标记和刷新修改时间）', async () => {
    const { ingestMessage } = await import('../src/services/ingest.js');
    const folder = await env.db.query.folders.findFirst({ where: (f, { eq }) => eq(f.accountId, env.accounts.work.id) });
    const source = Buffer.from('From: a@example.com\r\nSubject: reuse\r\nMessage-ID: <reuse@example.com>\r\n\r\nbody\r\n');
    const first = await ingestMessage({ accountId: env.accounts.work.id, folderId: folder!.id, uid: 700, source, flags: new Set() });
    const row = await env.db.query.messages.findFirst({ where: (m, { eq }) => eq(m.id, first.id) });
    const abs = path.join(config.rawDir, row!.rawPath!);
    utimesSync(abs, old, old);
    // 删掉引用，模拟「同内容的邮件被删了又收到一封」
    await env.db.delete(env.schema.messages).where(eq(env.schema.messages.id, first.id));
    await ingestMessage({ accountId: env.accounts.work.id, folderId: folder!.id, uid: 701, source, flags: new Set() });
    await gc.collectRawGarbage({ graceMs: 3600_000 });
    assert.equal(existsSync(abs), true);
  });
});

describe('删除邮箱', () => {
  test('同时删掉这个邮箱的原始邮件目录', async () => {
    const acc = env.accounts.home.id;
    const rel = rawFile(acc, 10, { fresh: true });
    const web = new Browser(env.base);
    const login = await web.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const res = await web.request(`/api/admin/accounts/${acc}`, { method: 'DELETE', headers: { origin: env.base, 'x-damail': '1' } });
    assert.equal(res.status, 200);
    assert.equal(exists(rel), false);
    assert.equal(existsSync(path.join(config.rawDir, String(acc))), false);
  });
});
