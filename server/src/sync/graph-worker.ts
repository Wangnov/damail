import { and, eq, isNull, notInArray, or } from 'drizzle-orm';
import { config, pollIntervalMsOf } from '../config.js';
import { db } from '../db/index.js';
import { accounts, folders, messages, type Account, type Folder } from '../db/schema.js';
import { bus } from '../lib/events.js';
import { readCapped } from '../lib/read-capped.js';
import { ingestMessage } from '../services/ingest.js';
import { onNewMessage } from '../services/pipeline.js';
import { describeGraphError, graphBatch, graphFetch, graphJson, GraphError } from './graph.js';
import { isDefaultSynced, nextUid, StatusReporter } from './status.js';
import { isMessageDataError } from '../lib/db-errors.js';

const TRUNCATED_BYTES = 2 * 1024 * 1024;
// Graph 没有 IDLE，收件箱靠轮询；其他文件夹按 pollInterval
const INBOX_POLL_MS = 60_000;

const WELL_KNOWN: Record<string, string> = {
  inbox: '\\Inbox',
  sentitems: '\\Sent',
  drafts: '\\Drafts',
  junkemail: '\\Junk',
  deleteditems: '\\Trash',
  archive: '\\Archive',
};

type SyncKind = 'none' | 'inbox' | 'all';
const rank: Record<SyncKind, number> = { none: 0, inbox: 1, all: 2 };

type GraphFolder = { id: string; displayName: string; childFolderCount: number; totalItemCount: number };
type Page<T> = { value: T[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };
type DeltaItem = { id: string; '@removed'?: { reason: string }; isRead?: boolean; flag?: { flagStatus?: string }; receivedDateTime?: string };

const FOLDER_FIELDS = '$select=id,displayName,childFolderCount,totalItemCount&$top=100';

/** Graph 的已读、旗标对应到 IMAP 标记，本地数据结构和 IMAP 账户一致 */
function graphFlags(item: DeltaItem, answered = false) {
  const flags: string[] = [];
  if (item.isRead) flags.push('\\Seen');
  if (item.flag?.flagStatus === 'flagged') flags.push('\\Flagged');
  if (answered) flags.push('\\Answered');
  return flags;
}

/**
 * 微软 Graph 账户的同步 worker，对外接口和 IMAP 的 AccountWorker 一致：
 * - 文件夹用 mailFolders 列出，按 wellKnownName 识别收件箱、已发送等
 * - 每个文件夹用 messages/delta 增量同步：新邮件取原始 MIME 走同一套入库流程，已读/旗标变化和删除直接改本地
 * - 收件箱每分钟轮询一次，其他文件夹按 pollInterval
 */
export class GraphWorker {
  private abort = new AbortController();
  private pending: SyncKind = 'none';
  private draining: Promise<void> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  private syncDays = 90;
  private lastError = '';
  private status: StatusReporter;

  constructor(readonly accountId: number) {
    this.status = new StatusReporter(accountId);
  }

  start() {
    void this.begin();
  }

  async stop() {
    this.abort.abort();
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.draining;
  }

  requestSync(kind: Exclude<SyncKind, 'none'>) {
    if (rank[kind] > rank[this.pending]) this.pending = kind;
    if (!this.draining && this.running) this.draining = this.drain().finally(() => (this.draining = null));
  }

  private async begin() {
    const account = await db.query.accounts.findFirst({ where: eq(accounts.id, this.accountId) });
    if (!account || !account.enabled) {
      if (account) await this.status.set('disabled');
      return;
    }
    if (this.abort.signal.aborted) return;
    this.running = true;
    await this.status.set('connecting');
    this.requestSync('all');
    this.timers.push(setInterval(() => this.requestSync('inbox'), INBOX_POLL_MS));
    this.timers.push(setInterval(() => this.requestSync('all'), pollIntervalMsOf(account)));
  }

  private async drain() {
    while (this.pending !== 'none' && this.running) {
      const kind = this.pending;
      this.pending = 'none';
      try {
        const account = await db.query.accounts.findFirst({ where: eq(accounts.id, this.accountId) });
        if (!account) return;
        this.syncDays = account.syncSinceDays;
        // 收件箱轮询很频繁，不来回切换「同步中」
        if (kind === 'all' || this.status.last !== 'idle') await this.status.set('syncing');
        if (kind === 'all') await this.syncAll(account);
        else await this.syncInbox(account);
        if (this.abort.signal.aborted) return;
        if (kind === 'all' || this.status.last !== 'idle') await this.status.set('idle');
        this.lastError = '';
      } catch (err) {
        const message = describeGraphError(err);
        if (message !== this.lastError) console.warn(`[sync:${this.accountId}] 同步失败: ${message}`);
        this.lastError = message;
        await this.status.set('error', message);
        return;
      }
    }
  }

  private async syncAll(account: Account) {
    const list = await this.refreshFolders(account);
    for (const folder of list.filter((f) => f.syncEnabled)) {
      if (this.abort.signal.aborted) return;
      await this.syncFolder(account, folder);
    }
  }

  private async syncInbox(account: Account) {
    const inbox = await db.query.folders.findFirst({
      where: and(eq(folders.accountId, this.accountId), eq(folders.specialUse, '\\Inbox')),
    });
    if (inbox?.syncEnabled && inbox.remoteId) await this.syncFolder(account, inbox);
  }

  private async refreshFolders(account: Account): Promise<Folder[]> {
    const names = Object.keys(WELL_KNOWN);
    const known = await graphBatch(
      account,
      names.map((n) => ({ method: 'GET', url: `/me/mailFolders/${n}?$select=id` })),
    );
    const specialById = new Map<string, string>();
    known.forEach((r, i) => {
      const id = (r.body as { id?: string } | undefined)?.id;
      if (r.ok && id) specialById.set(id, WELL_KNOWN[names[i]!]!);
    });

    const listed: Array<GraphFolder & { path: string }> = [];
    const walk = async (url: string, prefix: string) => {
      for (let next: string | undefined = url; next;) {
        const page: Page<GraphFolder> = await graphJson<Page<GraphFolder>>(account, next);
        for (const f of page.value) {
          const path = prefix ? `${prefix}/${f.displayName}` : f.displayName;
          listed.push({ ...f, path });
          if (f.childFolderCount) await walk(`/me/mailFolders/${f.id}/childFolders?${FOLDER_FIELDS}`, path);
        }
        next = page['@odata.nextLink'];
      }
    };
    await walk(`/me/mailFolders?${FOLDER_FIELDS}`, '');

    for (const f of listed) {
      const specialUse = specialById.get(f.id) ?? null;
      const fields = { path: f.path, name: f.displayName, delimiter: '/', specialUse, remoteId: f.id, totalCount: f.totalItemCount };
      // 按 Graph 的文件夹 ID 对应，改名后仍是同一个文件夹
      const byId = await db
        .update(folders)
        .set(fields)
        .where(and(eq(folders.accountId, this.accountId), eq(folders.remoteId, f.id)))
        .returning({ id: folders.id });
      if (byId.length) continue;
      await db
        .insert(folders)
        .values({ accountId: this.accountId, ...fields, syncEnabled: isDefaultSynced(f.path, specialUse) })
        .onConflictDoUpdate({ target: [folders.accountId, folders.path], set: { ...fields, deltaLink: null } });
    }
    // 服务器上已不存在的文件夹，以及改走 Graph 之前 IMAP 留下的文件夹
    const ids = listed.map((f) => f.id);
    await db
      .delete(folders)
      .where(and(eq(folders.accountId, this.accountId), or(isNull(folders.remoteId), ids.length ? notInArray(folders.remoteId, ids) : undefined)));
    return db.query.folders.findMany({ where: eq(folders.accountId, this.accountId) });
  }

  private initialDeltaUrl(folder: Folder) {
    const q = new URLSearchParams({
      $select: 'id,isRead,flag,receivedDateTime',
      // 首次回溯时最新邮件最先可见
      $orderby: 'receivedDateTime desc',
    });
    if (this.syncDays !== 0) q.set('$filter', `receivedDateTime ge ${new Date(Date.now() - this.syncDays * 86400_000).toISOString()}`);
    return `/me/mailFolders/${folder.remoteId}/messages/delta?${q}`;
  }

  private async syncFolder(account: Account, folder: Folder) {
    if (!folder.remoteId) return;
    const initial = !folder.deltaLink;
    // 只有收件箱的增量新邮件进入自动化流程；首次回溯不触发
    const automate = folder.specialUse === '\\Inbox' && !initial;
    let url: string | undefined = folder.deltaLink ?? this.initialDeltaUrl(folder);
    let deltaLink: string | undefined;
    let added = 0;
    let changed = 0;
    const started = Date.now();

    while (url) {
      if (this.abort.signal.aborted) return;
      let page: Page<DeltaItem>;
      try {
        page = await graphJson<Page<DeltaItem>>(account, url, { prefer: ['odata.maxpagesize=50'] });
      } catch (err) {
        // 增量游标过期：从头同步（已入库的邮件只会更新标记）
        if (err instanceof GraphError && (err.status === 410 || err.code === 'SyncStateNotFound' || err.code === 'SyncStateInvalid')) {
          url = this.initialDeltaUrl(folder);
          continue;
        }
        throw err;
      }

      let newInPage = 0;
      for (const item of page.value) {
        if (this.abort.signal.aborted) return;
        if (item['@removed']) {
          const res = await db
            .delete(messages)
            .where(and(eq(messages.accountId, this.accountId), eq(messages.folderId, folder.id), eq(messages.remoteId, item.id)));
          changed += res.rowCount ?? 0;
          continue;
        }
        const existing = await db.query.messages.findFirst({
          where: and(eq(messages.accountId, this.accountId), eq(messages.remoteId, item.id)),
          columns: { id: true, folderId: true, answered: true, seen: true, flagged: true },
        });
        if (existing) {
          const flags = graphFlags(item, existing.answered);
          const seen = flags.includes('\\Seen');
          const flagged = flags.includes('\\Flagged');
          const moved = existing.folderId !== folder.id;
          if (!moved && existing.seen === seen && existing.flagged === flagged) continue;
          // 在别处被移到这个文件夹（ImmutableId 不变），原地改写
          await db
            .update(messages)
            .set({ flags, seen, flagged, ...(moved ? { folderId: folder.id, uid: await nextUid(folder.id) } : {}) })
            .where(eq(messages.id, existing.id));
          changed++;
          continue;
        }

        const res = await graphFetch(account, `/me/messages/${item.id}/$value`, { timeoutMs: 300_000 });
        // 边下载边计数，超过上限立即中断：不能先把整封读进内存再判断大小
        const { data, overflow: truncated, total } = await readCapped(res, config.maxMessageBytes);
        // 邮件数据本身有问题时只跳过这一封；其他错误照常抛出，不推进同步进度，下次重试
        let row: Awaited<ReturnType<typeof ingestMessage>>;
        try {
          row = await ingestMessage({
            accountId: this.accountId,
            folderId: folder.id,
            uid: await nextUid(folder.id),
            remoteId: item.id,
            source: truncated ? data.subarray(0, TRUNCATED_BYTES) : data,
            flags: graphFlags(item),
            internalDate: item.receivedDateTime,
            size: total,
            truncated,
          });
        } catch (err) {
          if (!isMessageDataError(err)) throw err;
          console.warn(`[graph:${this.accountId}] ${folder.path} ${item.id} 邮件数据无法入库，已跳过：`, (err as Error).message);
          continue;
        }
        newInPage++;
        if (automate && row.inserted) await onNewMessage(row.id, row.date);
      }
      if (newInPage) {
        added += newInPage;
        bus.publish({ type: 'messages.new', accountId: this.accountId, folderId: folder.id, count: newInPage });
      }
      url = page['@odata.nextLink'];
      deltaLink = page['@odata.deltaLink'] ?? deltaLink;
    }

    if (added) console.log(`[sync:${this.accountId}] ${folder.path}: 新增 ${added} 封，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    const unread = await db.$count(messages, and(eq(messages.folderId, folder.id), eq(messages.seen, false)));
    await db
      .update(folders)
      .set({ deltaLink: deltaLink ?? folder.deltaLink, unreadCount: unread, lastSyncAt: new Date() })
      .where(eq(folders.id, folder.id));
    // 未读数写好之后再通知前端
    if (changed) bus.publish({ type: 'messages.updated', accountId: this.accountId, folderId: folder.id });
  }
}
