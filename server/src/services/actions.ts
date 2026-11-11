import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, folders, messages, type Folder } from '../db/schema.js';
import { bus } from '../lib/events.js';
import { graphBatch, type BatchItem } from '../sync/graph.js';
import { withImapWriter } from '../sync/imap-writer.js';
import { nextUid, refreshUnread } from '../sync/status.js';
import type { Scope } from './mail.js';
import { L } from '../i18n/index.js';

export type FlagPatch = { seen?: boolean; flagged?: boolean; answered?: boolean };
export type MoveTarget = 'inbox' | 'archive' | 'trash' | 'junk' | { folderId: number };

export class ActionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 429 = 400,
  ) {
    super(message);
  }
}

const FLAG_NAMES: Array<[keyof FlagPatch, string]> = [
  ['seen', '\\Seen'],
  ['flagged', '\\Flagged'],
  ['answered', '\\Answered'],
];
const CHUNK = 500;

type Target = { id: number; accountId: number; folderId: number; uid: number; remoteId: string | null; path: string; protocol: string };
type Group = { accountId: number; folderId: number; path: string; graph: boolean; rows: Target[] };

async function loadGroups(scope: Scope, ids: number[]): Promise<Group[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({
      id: messages.id,
      accountId: messages.accountId,
      folderId: messages.folderId,
      uid: messages.uid,
      remoteId: messages.remoteId,
      path: folders.path,
      protocol: accounts.protocol,
    })
    .from(messages)
    .innerJoin(folders, eq(folders.id, messages.folderId))
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .where(inArray(messages.id, ids));
  if (rows.length !== new Set(ids).size) throw new ActionError(L('部分邮件不存在', 'Some messages do not exist'), 404);
  if (scope.accountIds && rows.some((r) => !scope.accountIds!.includes(r.accountId)))
    throw new ActionError(L('无权操作该邮件', 'Not allowed to access this message'), 403);
  const groups = new Map<number, Group>();
  for (const r of rows) {
    let g = groups.get(r.folderId);
    if (!g) groups.set(r.folderId, (g = { accountId: r.accountId, folderId: r.folderId, path: r.path, graph: r.protocol === 'graph', rows: [] }));
    g.rows.push(r);
  }
  return [...groups.values()];
}

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

/**
 * Graph 账户：每封邮件一个请求，批量发出。返回服务器上成功的那些，本地只改这些；
 * 有失败的话在改完本地之后由调用方抛出，避免本地和服务器不一致
 */
async function graphEach(g: Group, request: (remoteId: string) => BatchItem) {
  const rows = g.rows.filter((r) => r.remoteId);
  const results = await graphBatch(
    g.accountId,
    rows.map((r) => request(r.remoteId!)),
  );
  const ok = rows.filter((_, i) => results[i]!.ok);
  const failed = results.find((r) => !r.ok);
  return {
    ok,
    error: failed
      ? L(
          `微软服务器拒绝了 ${results.filter((r) => !r.ok).length} 封邮件的操作：${failed.error}`,
          `The Microsoft server rejected the operation on ${results.filter((r) => !r.ok).length} messages: ${failed.error}`,
        )
      : null,
  };
}

/** 未读数写好之后再通知前端，否则前端可能读到旧的数字 */
function publishUpdated(groups: Group[]) {
  for (const g of groups) bus.publish({ type: 'messages.updated', accountId: g.accountId, folderId: g.folderId });
}

/** 修改已读 / 星标 / 已回复标记，先写 IMAP，成功后更新本地 */
export async function setFlags(scope: Scope, ids: number[], patch: FlagPatch) {
  const add = FLAG_NAMES.filter(([k]) => patch[k] === true).map(([, f]) => f);
  const remove = FLAG_NAMES.filter(([k]) => patch[k] === false).map(([, f]) => f);
  if (!add.length && !remove.length) return { updated: 0 };
  const groups = await loadGroups(scope, ids);
  let error: string | null = null;

  for (const g of groups) {
    let rows = g.rows;
    if (g.graph) {
      // Graph 没有「已回复」标记可写，只在本地记录
      const body = {
        ...(patch.seen !== undefined ? { isRead: patch.seen } : {}),
        ...(patch.flagged !== undefined ? { flag: { flagStatus: patch.flagged ? 'flagged' : 'notFlagged' } } : {}),
      };
      if (Object.keys(body).length) {
        const res = await graphEach(g, (id) => ({ method: 'PATCH', url: `/me/messages/${id}`, body }));
        rows = res.ok;
        error ??= res.error;
      }
    } else
      await withImapWriter(g.accountId, async (client) => {
        const lock = await client.getMailboxLock(g.path);
        try {
          for (const part of chunks(g.rows.map((r) => r.uid))) {
            if (add.length) await client.messageFlagsAdd(part, add, { uid: true });
            if (remove.length) await client.messageFlagsRemove(part, remove, { uid: true });
          }
        } finally {
          lock.release();
        }
      });
    if (!rows.length) continue;
    const rowIds = rows.map((r) => r.id);
    await db
      .update(messages)
      .set({
        ...patch,
        flags: sql`ARRAY(SELECT DISTINCT f FROM unnest(array_cat(${messages.flags}, ${sql.param(add)}::text[])) f WHERE f <> ALL(${sql.param(remove)}::text[]))`,
      })
      .where(inArray(messages.id, rowIds));
  }
  if (patch.seen !== undefined) await refreshUnread(groups.map((g) => g.folderId));
  publishUpdated(groups);
  if (error) throw new ActionError(error, 409);
  return { updated: groups.reduce((n, g) => n + g.rows.length, 0) };
}

const isInboxFolder = (f: Folder) => f.specialUse === '\\Inbox' || f.path.toUpperCase() === 'INBOX';

async function resolveDestination(accountId: number, target: MoveTarget): Promise<Folder> {
  const list = await db.query.folders.findMany({ where: eq(folders.accountId, accountId) });
  let dest: Folder | undefined;
  if (typeof target === 'object') dest = list.find((f) => f.id === target.folderId);
  else if (target === 'inbox') dest = list.find(isInboxFolder);
  // 没有 \Archive 时退回 \All（Gmail 的「所有邮件」，移过去等于去掉收件箱标签）
  else if (target === 'archive') dest = list.find((f) => f.specialUse === '\\Archive') ?? list.find((f) => f.specialUse === '\\All');
  else if (target === 'trash') dest = list.find((f) => f.specialUse === '\\Trash');
  else if (target === 'junk') dest = list.find((f) => f.specialUse === '\\Junk');
  if (!dest) {
    const label =
      { inbox: L('收件箱', 'Inbox'), archive: L('归档', 'Archive'), trash: L('已删除', 'Trash'), junk: L('垃圾邮件', 'Junk') }[target as string] ??
      L('目标', 'target');
    throw new ActionError(L(`该邮箱没有「${label}」文件夹`, `This mailbox has no "${label}" folder`), 400);
  }
  return dest;
}

/** 移动邮件（归档、删除到废纸篓、移回收件箱或任意文件夹），不做永久删除 */
export async function moveMessages(scope: Scope, ids: number[], target: MoveTarget) {
  const groups = await loadGroups(scope, ids);
  const destinations = new Map<number, Folder>();
  for (const g of groups) {
    if (!destinations.has(g.accountId)) destinations.set(g.accountId, await resolveDestination(g.accountId, target));
  }

  let moved = 0;
  let error: string | null = null;
  const touched = new Set<number>();
  for (const g of groups) {
    const dest = destinations.get(g.accountId)!;
    if (dest.id === g.folderId) continue;
    if (g.graph) {
      if (!dest.remoteId) throw new ActionError(L('目标文件夹还没同步完成，请稍后再试', 'The target folder has not finished syncing; try again later'), 409);
      const res = await graphEach(g, (id) => ({ method: 'POST', url: `/me/messages/${id}/move`, body: { destinationId: dest.remoteId } }));
      error ??= res.error;
      // ImmutableId 移动后不变：目标文件夹已同步就原地改写，否则删掉本地记录
      for (const r of res.ok) {
        if (!dest.syncEnabled) await db.delete(messages).where(eq(messages.id, r.id));
        else {
          const uid = await nextUid(dest.id);
          await db.update(messages).set({ folderId: dest.id, uid }).where(eq(messages.id, r.id));
        }
      }
      moved += res.ok.length;
      touched.add(g.folderId).add(dest.id);
      continue;
    }
    const uidMap = new Map<number, number>();
    await withImapWriter(g.accountId, async (client) => {
      const lock = await client.getMailboxLock(g.path);
      try {
        for (const part of chunks(g.rows.map((r) => r.uid))) {
          const res = await client.messageMove(part, dest.path, { uid: true });
          if (res && res.uidMap) for (const [from, to] of res.uidMap) uidMap.set(from, to);
        }
      } finally {
        lock.release();
      }
    });

    for (const r of g.rows) {
      const newUid = uidMap.get(r.uid);
      // 目标文件夹已同步且服务器返回了新 UID（UIDPLUS）时原地改写，否则删掉本地记录，等下次同步
      if (dest.syncEnabled && newUid) {
        try {
          await db.update(messages).set({ folderId: dest.id, uid: newUid }).where(eq(messages.id, r.id));
          continue;
        } catch {
          // 目标文件夹里已有同一封（例如 Gmail 的所有邮件），保留那一条
        }
      }
      await db.delete(messages).where(and(eq(messages.id, r.id), eq(messages.folderId, g.folderId)));
    }
    moved += g.rows.length;
    touched.add(g.folderId).add(dest.id);
  }
  if (touched.size) await refreshUnread([...touched]);
  publishUpdated(groups);
  if (error) throw new ActionError(error, 409);
  return { moved, destination: [...new Set([...destinations.values()].map((d) => d.name))].join('、') };
}

/** 彻底删除：只允许删「已删除」文件夹里的邮件，打上 \Deleted 并 EXPUNGE，再删本地记录 */
export async function deleteMessages(scope: Scope, ids: number[]) {
  const groups = await loadGroups(scope, ids);
  if (groups.length) {
    const folderIds = groups.map((g) => g.folderId);
    const list = await db.query.folders.findMany({ where: inArray(folders.id, folderIds) });
    if (list.some((f) => f.specialUse !== '\\Trash'))
      throw new ActionError(L('只能彻底删除「已删除」文件夹里的邮件', 'Only messages in Trash can be permanently deleted'), 400);
  }

  let deleted = 0;
  let error: string | null = null;
  for (const g of groups) {
    if (g.graph) {
      const res = await graphEach(g, (id) => ({ method: 'POST', url: `/me/messages/${id}/permanentDelete` }));
      error ??= res.error;
      if (res.ok.length) {
        const okIds = res.ok.map((r) => r.id);
        await db.delete(messages).where(inArray(messages.id, okIds));
      }
      deleted += res.ok.length;
      continue;
    }
    await withImapWriter(g.accountId, async (client) => {
      const lock = await client.getMailboxLock(g.path);
      try {
        for (const part of chunks(g.rows.map((r) => r.uid))) await client.messageDelete(part, { uid: true });
      } finally {
        lock.release();
      }
    });
    const rowIds = g.rows.map((r) => r.id);
    await db.delete(messages).where(inArray(messages.id, rowIds));
    deleted += g.rows.length;
  }
  if (groups.length) await refreshUnread(groups.map((g) => g.folderId));
  publishUpdated(groups);
  if (error) throw new ActionError(error, 409);
  return { deleted };
}

export type ThreadAction = 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'trash' | 'delete';

/**
 * 按会话批量操作时，每个会话里实际要处理的邮件，和会话详情页按钮的语义一致：
 * 已读处理所有未读；标未读、加星标只处理最新一封；归档只移收件箱里的；删除跳过已在废纸篓的；彻底删除只删废纸篓里的。
 */
export async function threadMessageIds(scope: Scope, threadIds: string[], action: ThreadAction): Promise<number[]> {
  if (!threadIds.length) return [];
  const rows = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      date: messages.date,
      seen: messages.seen,
      flagged: messages.flagged,
      specialUse: folders.specialUse,
      path: folders.path,
    })
    .from(messages)
    .innerJoin(folders, eq(folders.id, messages.folderId))
    .where(
      and(inArray(messages.threadId, threadIds), scope.accountIds ? inArray(messages.accountId, scope.accountIds.length ? scope.accountIds : [-1]) : undefined),
    );

  const byThread = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byThread.get(r.threadId) ?? [];
    list.push(r);
    byThread.set(r.threadId, list);
  }
  const latest = (list: typeof rows) =>
    list.reduce((a, b) => (b.date.getTime() > a.date.getTime() || (b.date.getTime() === a.date.getTime() && b.id > a.id) ? b : a));

  const ids: number[] = [];
  for (const list of byThread.values()) {
    switch (action) {
      case 'read':
        ids.push(...list.filter((r) => !r.seen).map((r) => r.id));
        break;
      case 'unread':
        ids.push(latest(list).id);
        break;
      case 'star':
        if (!list.some((r) => r.flagged)) ids.push(latest(list).id);
        break;
      case 'unstar':
        ids.push(...list.filter((r) => r.flagged).map((r) => r.id));
        break;
      case 'archive':
        ids.push(...list.filter((r) => r.specialUse === '\\Inbox' || r.path.toUpperCase() === 'INBOX').map((r) => r.id));
        break;
      case 'trash':
        ids.push(...list.filter((r) => r.specialUse !== '\\Trash').map((r) => r.id));
        break;
      case 'delete':
        ids.push(...list.filter((r) => r.specialUse === '\\Trash').map((r) => r.id));
        break;
    }
  }
  return ids;
}
