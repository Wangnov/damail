/** 回归检查：附件快速定位与 mailparser 完整解析的结果逐字节对比。用法：pnpm tsx scripts/verify-attachments.ts */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser } from 'mailparser';
import { findAttachmentPart } from '../src/lib/mime-part.js';

const opts = { skipTextToHtml: true, skipImageLinks: true, keepCidLinks: true } as const;
let checked = 0, fast = 0, fallback = 0, wrong = 0;

async function check(raw: Buffer, label: string) {
  const parsed = await simpleParser(raw, opts);
  parsed.attachments.forEach((a, i) => {
    checked++;
    let part = null;
    try { part = findAttachmentPart(raw, i); } catch {}
    if (!part || part.content.length !== a.size) { fallback++; return; }
    if (!part.content.equals(a.content)) { wrong++; console.log('MISMATCH', label, i, a.filename); return; }
    fast++;
  });
}

// 1. 本地全部原始邮件
const root = 'data/raw';
const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith('.eml') && files.push(p); } };
walk(root);
for (const f of files) await check(readFileSync(f), f);
console.log(`本地 ${files.length} 封：附件 ${checked}，快速 ${fast}，回退 ${fallback}，错误 ${wrong}`);

// 2. 构造的边界情况
const before = { checked, fast, fallback, wrong };
const cases: Array<[string, ConstructorParameters<typeof MailComposer>[0]]> = [
  ['qp+中文文件名', { from: 'a@b.c', to: 'c@d.e', text: 'x', attachments: [{ filename: '很长的中文文件名'.repeat(6) + '.txt', content: 'héllo wörld = 测试\n'.repeat(200), encoding: undefined, contentTransferEncoding: 'quoted-printable' } as never] }],
  ['related+alternative', { from: 'a@b.c', to: 'c@d.e', text: 'plain', html: '<img src="cid:a1"><img src="cid:a2">', attachments: [{ filename: 'a.png', content: randomBytes(3000), cid: 'a1' }, { content: randomBytes(5000), cid: 'a2', contentType: 'image/gif' }, { filename: 'doc.pdf', content: randomBytes(70000) }] }],
  ['text 附件', { from: 'a@b.c', to: 'c@d.e', text: 'x', attachments: [{ filename: 'note.txt', content: 'line\r\nline2' }, { filename: 'page.html', content: '<b>x</b>', contentType: 'text/html' }] }],
  ['octet-stream', { from: 'a@b.c', to: 'c@d.e', text: 'x', attachments: [{ filename: 'report.pdf', content: randomBytes(1234), contentType: 'application/octet-stream' }] }],
  ['转发 rfc822', { from: 'a@b.c', to: 'c@d.e', text: 'x', attachments: [{ filename: 'fwd.eml', content: 'From: x@y.z\r\nSubject: hi\r\nContent-Type: text/plain\r\n\r\nbody', contentType: 'message/rfc822' }, { filename: 'b.bin', content: randomBytes(99) }] }],
];
for (const [label, mail] of cases) await check(await new MailComposer(mail).compile().build(), label);
console.log(`构造用例：附件 ${checked - before.checked}，快速 ${fast - before.fast}，回退 ${fallback - before.fallback}，错误 ${wrong - before.wrong}`);
