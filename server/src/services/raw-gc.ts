/**
 * 原始邮件（.eml）清理。
 *
 * 原始邮件按内容哈希存放在 rawDir/<邮箱 id>/<前两位>/<sha256>.eml，同一邮箱里内容相同的邮件共用一个文件，
 * 所以删邮件时不能直接删文件。这里定期扫描，删掉数据库里已经没有引用的文件：
 * - 邮箱已经删除：整个目录删掉
 * - 文件超过宽限期、没有任何邮件引用、本进程最近也没有写入或复用它：删掉
 * 只处理符合上面命名格式的普通文件和目录，不跟随符号链接。
 */
import type { Dirent } from 'node:fs';
import { lstatSync, unlinkSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { eq, isNotNull, and } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { accounts, messages } from '../db/schema.js';

/** 写入后到入库之间的保护时间：期间即使还没被引用也不删 */
export const RAW_GRACE_MS = 6 * 3600_000;

const ACCOUNT_DIR = /^\d+$/;
const PREFIX_DIR = /^[0-9a-f]{2}$/;
const RAW_FILE = /^[0-9a-f]{64}\.eml$/;

// 本进程最近写入或复用的文件（相对路径 → 时间）：入库事务还没提交时，数据库里查不到引用
const inUse = new Map<string, number>();

/** storeRaw 写入或复用文件前调用 */
export function markRawInUse(rel: string) {
  const now = Date.now();
  inUse.set(rel, now);
  if (inUse.size > 10_000) for (const [k, t] of inUse) if (t < now - RAW_GRACE_MS) inUse.delete(k);
}

function recentlyUsed(rel: string, now: number) {
  const t = inUse.get(rel);
  return t !== undefined && t > now - RAW_GRACE_MS;
}

async function list(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

/** 删除一个邮箱的全部原始邮件（删除邮箱后调用） */
export async function removeAccountRaw(accountId: number) {
  await rm(path.join(config.rawDir, String(accountId)), { recursive: true, force: true });
}

export type RawGcResult = { files: number; bytes: number; accounts: number };

export async function collectRawGarbage(opts: { graceMs?: number } = {}): Promise<RawGcResult> {
  const grace = opts.graceMs ?? RAW_GRACE_MS;
  const result: RawGcResult = { files: 0, bytes: 0, accounts: 0 };
  const existing = new Set((await db.select({ id: accounts.id }).from(accounts)).map((a) => String(a.id)));

  for (const acc of await list(config.rawDir)) {
    if (!acc.isDirectory() || !ACCOUNT_DIR.test(acc.name)) continue;
    if (!existing.has(acc.name)) {
      // 快照之后才新建的邮箱也不在 existing 里，删除前再确认一次（邮箱 id 自增，不会复用）
      if (await db.$count(accounts, eq(accounts.id, Number(acc.name)))) continue;
      await removeAccountRaw(Number(acc.name));
      result.accounts++;
      continue;
    }
    // 先取引用快照再扫描：快照之后才写入或复用的文件，要么在 inUse 里，要么修改时间还在宽限期内
    const rows = await db
      .selectDistinct({ rawPath: messages.rawPath })
      .from(messages)
      .where(and(eq(messages.accountId, Number(acc.name)), isNotNull(messages.rawPath)));
    const referenced = new Set(rows.map((r) => r.rawPath!));

    let seen = 0;
    for (const prefix of await list(path.join(config.rawDir, acc.name))) {
      if (!prefix.isDirectory() || !PREFIX_DIR.test(prefix.name)) continue;
      for (const file of await list(path.join(config.rawDir, acc.name, prefix.name))) {
        if (++seen % 500 === 0) await tick();
        if (!file.isFile() || !RAW_FILE.test(file.name)) continue;
        const rel = path.join(acc.name, prefix.name, file.name);
        if (referenced.has(rel)) continue;
        const abs = path.join(config.rawDir, rel);
        // 下面的检查和删除都是同步的，中间不会插进 storeRaw，避免删掉刚被复用的文件
        const now = Date.now();
        if (recentlyUsed(rel, now)) continue;
        try {
          const st = lstatSync(abs);
          if (!st.isFile() || st.mtimeMs > now - grace) continue;
          unlinkSync(abs);
          result.files++;
          result.bytes += st.size;
        } catch {
          // 文件已被删除或无权限，跳过
        }
      }
    }
  }
  return result;
}
