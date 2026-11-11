import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { convert as htmlToText } from 'html-to-text';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { messages, type Address, type AttachmentMeta } from '../db/schema.js';
import { sha256 } from '../lib/crypto.js';
import { withBodyUnsubscribe } from '../lib/body-unsubscribe.js';
import { parseListHeaders } from '../lib/list-headers.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type IncomingMessage = {
  accountId: number;
  folderId: number;
  uid: number;
  /** Graph 账户的邮件 ID */
  remoteId?: string;
  source: Buffer;
  flags: Set<string> | string[];
  internalDate?: Date | string;
  size?: number;
  truncated?: boolean;
  gmThreadId?: string;
};

const parseOptions = { skipTextToHtml: true, skipImageLinks: true, keepCidLinks: true } as const;

export async function parseRaw(source: Buffer): Promise<ParsedMail> {
  return simpleParser(source, parseOptions);
}

export async function readRaw(rawPath: string): Promise<Buffer> {
  return readFile(path.join(config.rawDir, rawPath));
}

async function storeRaw(accountId: number, source: Buffer): Promise<string> {
  const hash = sha256(source);
  const rel = path.join(String(accountId), hash.slice(0, 2), `${hash}.eml`);
  const abs = path.join(config.rawDir, rel);
  if (!existsSync(abs)) {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, source);
  }
  return rel;
}

function flattenAddresses(input: AddressObject | AddressObject[] | undefined): Address[] {
  if (!input) return [];
  const out: Address[] = [];
  for (const obj of Array.isArray(input) ? input : [input]) {
    for (const v of obj.value) {
      if (v.group) for (const g of v.group) out.push({ name: g.name || undefined, address: g.address });
      else out.push({ name: v.name || undefined, address: v.address });
    }
  }
  return out;
}

function normalizeRefs(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : value.split(/\s+/);
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 归并会话：Gmail 直接用服务器给的 X-GM-THRID；
 * 其他服务商按 Message-ID / In-Reply-To / References 关联，必要时合并已有会话。
 */
async function resolveThreadId(tx: Tx, accountId: number, messageId: string | null, refs: string[], gmThreadId?: string): Promise<string> {
  if (gmThreadId) return `gm:${accountId}:${gmThreadId}`;
  const conds = [];
  if (refs.length) conds.push(sql`${messages.messageId} = ANY(${sql.param(refs)}::text[])`);
  if (messageId) {
    conds.push(sql`${messages.references} @> ARRAY[${messageId}]::text[]`);
    conds.push(sql`${messages.messageId} = ${messageId}`);
  }
  if (!conds.length) return randomUUID();

  const rows = await tx
    .selectDistinct({ threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), sql`(${sql.join(conds, sql` OR `)})`));
  if (!rows.length) return randomUUID();

  const [chosen, ...others] = rows.map((r) => r.threadId).sort();
  if (others.length) {
    await tx
      .update(messages)
      .set({ threadId: chosen })
      .where(and(eq(messages.accountId, accountId), inArray(messages.threadId, others)));
  }
  return chosen!;
}

/** 返回本地邮件 ID；inserted 为 false 表示已存在（只更新了标记） */
export async function ingestMessage(input: IncomingMessage): Promise<{ id: number; inserted: boolean; date: Date }> {
  const flags = [...input.flags];
  const rawPath = await storeRaw(input.accountId, input.source);

  let parsed: ParsedMail | null = null;
  try {
    parsed = await parseRaw(input.source);
  } catch (err) {
    console.warn(`[ingest] 解析失败 account=${input.accountId} uid=${input.uid}:`, (err as Error).message);
  }

  const html = parsed?.html || null;
  let text = parsed?.text ?? null;
  if (!text && html) text = htmlToText(html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] });

  const attachments: AttachmentMeta[] = (parsed?.attachments ?? []).map((a, index) => {
    const cid = a.contentId ? a.contentId.replace(/^<|>$/g, '') : null;
    return {
      index,
      filename: a.filename ?? null,
      contentType: a.contentType,
      size: a.size,
      cid,
      inline: Boolean(cid && (a.contentDisposition === 'inline' || a.related)),
    };
  });

  const from = flattenAddresses(parsed?.from)[0];
  const to = flattenAddresses(parsed?.to);
  const cc = flattenAddresses(parsed?.cc);
  const replyTo = flattenAddresses(parsed?.replyTo);
  const subject = parsed?.subject ?? (parsed ? '' : '(无法解析的邮件)');
  const messageId = parsed?.messageId ?? null;
  const inReplyTo = parsed?.inReplyTo ?? null;
  const refs = normalizeRefs(parsed?.references);
  if (inReplyTo && !refs.includes(inReplyTo)) refs.push(inReplyTo);

  const date = parsed?.date ?? (input.internalDate ? new Date(input.internalDate) : new Date());
  const snippet = collapse(text ?? '').slice(0, 200);
  const searchText = [
    subject,
    from?.name,
    from?.address,
    ...[...to, ...cc].flatMap((a) => [a.name, a.address]),
    attachments.map((a) => a.filename).join(' '),
    text,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 30000);

  return db.transaction(async (tx) => {
    const threadId = await resolveThreadId(tx, input.accountId, messageId, refs, input.gmThreadId);
    const values = {
      accountId: input.accountId,
      folderId: input.folderId,
      uid: input.uid,
      remoteId: input.remoteId ?? null,
      messageId,
      threadId,
      inReplyTo,
      references: refs,
      subject,
      fromName: from?.name ?? null,
      fromAddress: from?.address?.toLowerCase() ?? null,
      to,
      cc,
      replyTo,
      date,
      snippet,
      textBody: text,
      htmlBody: html,
      attachments,
      hasAttachments: attachments.some((a) => !a.inline),
      flags,
      seen: flags.includes('\\Seen'),
      flagged: flags.includes('\\Flagged'),
      answered: flags.includes('\\Answered'),
      size: input.size ?? input.source.length,
      truncated: input.truncated ?? false,
      rawPath,
      listInfo: withBodyUnsubscribe(parseListHeaders(input.source), { subject, inReplyTo, htmlBody: html, textBody: text }),
      searchText,
    };
    const [row] = await tx
      .insert(messages)
      .values(values)
      .onConflictDoUpdate({
        target: [messages.folderId, messages.uid],
        set: { flags: values.flags, seen: values.seen, flagged: values.flagged, answered: values.answered },
      })
      // xmax = 0 说明这一行是新插入的，而不是冲突后更新的
      .returning({ id: messages.id, inserted: sql<boolean>`(xmax = 0)` });
    return { id: row!.id, inserted: row!.inserted, date };
  });
}
