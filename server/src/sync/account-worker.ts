import { and, eq, gte, inArray, notInArray, sql } from 'drizzle-orm';
import type { FetchMessageObject, ImapFlow, MailboxObject } from 'imapflow';
import { config, pollIntervalMsOf } from '../config.js';
import { db } from '../db/index.js';
import { accounts, folders, messages, type Folder } from '../db/schema.js';
import { accountCredentials } from '../services/oauth.js';
import { proxyUrlById } from '../services/proxy.js';
import { bus } from '../lib/events.js';
import { ingestMessage } from '../services/ingest.js';
import { onNewMessage } from '../services/pipeline.js';
import { createImapClient, describeImapError } from './imap.js';
import { isDefaultSynced, refreshUnread, StatusReporter } from './status.js';
import { L } from '../i18n/index.js';

const BATCH = 25;
const TRUNCATED_BYTES = 2 * 1024 * 1024;
const FLAG_WINDOW = 500;

type SyncKind = 'none' | 'inbox' | 'all';
const rank: Record<SyncKind, number> = { none: 0, inbox: 1, all: 2 };

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}

/**
 * 每个邮箱账户一个常驻 worker：
 * - 维持一条 IMAP 连接，选中 INBOX 后由 imapflow 自动 IDLE，收到 EXISTS 立即增量同步
 * - 其他文件夹按 pollInterval 轮询；断线指数退避重连
 * - 同步连接全程以 EXAMINE（只读）打开文件夹；标记、移动、APPEND 等写操作走 imap-writer 的独立连接
 */
export class AccountWorker {
  private client: ImapFlow | null = null;
  private abort = new AbortController();
  private pending: SyncKind = 'none';
  private draining: Promise<void> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private inboxPath = 'INBOX';

  constructor(readonly accountId: number) {
    this.status = new StatusReporter(accountId);
  }

  start() {
    void this.loop();
  }

  async stop() {
    this.abort.abort();
    if (this.pollTimer) clearInterval(this.pollTimer);
    const client = this.client;
    this.client = null;
    if (client) await client.logout().catch(() => client.close());
    await this.draining;
  }

  private status: StatusReporter;

  requestSync(kind: Exclude<SyncKind, 'none'>) {
    if (rank[kind] > rank[this.pending]) this.pending = kind;
    if (!this.draining && this.client?.usable) this.draining = this.drain().finally(() => (this.draining = null));
  }

  private setStatus(status: string, error: string | null = null) {
    return this.status.set(status, error);
  }

  private async loop() {
    let backoff = 0;
    while (!this.abort.signal.aborted) {
      const account = await db.query.accounts.findFirst({ where: eq(accounts.id, this.accountId) });
      if (!account || !account.enabled) {
        if (account) await this.setStatus('disabled');
        return;
      }
      this.syncDays = account.syncSinceDays;
      try {
        await this.setStatus('connecting');
        const client = createImapClient({
          host: account.imapHost,
          port: account.imapPort,
          secure: account.imapSecure,
          username: account.username,
          ...(await accountCredentials(account)),
          proxy: await proxyUrlById(account.proxyId),
        });
        this.client = client;
        const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
        client.on('error', (err) => console.warn(`[sync:${this.accountId}] ${describeImapError(err)}`));
        client.on('exists', (ev) => {
          if (ev.path !== this.inboxPath) return;
          console.log(`[sync:${this.accountId}] 收到推送：${ev.path} ${ev.prevCount} -> ${ev.count}`);
          this.requestSync('inbox');
        });
        client.on('expunge', (ev) => {
          if (ev.path === this.inboxPath) this.requestSync('inbox');
        });
        client.on('flags', (ev) => void this.onFlags(ev.path, ev.uid, ev.flags));

        await client.connect();
        backoff = 0;
        this.requestSync('all');
        this.pollTimer = setInterval(() => this.requestSync('all'), pollIntervalMsOf(account));
        await closed;
        if (this.pollTimer) clearInterval(this.pollTimer);
        if (!this.abort.signal.aborted) await this.setStatus('connecting', L('连接已断开，正在重连', 'Connection lost; reconnecting'));
      } catch (err) {
        const message = describeImapError(err);
        console.warn(`[sync:${this.accountId}] ${message}`);
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.client?.close();
        if (!this.abort.signal.aborted) await this.setStatus('error', message);
      }
      this.client = null;
      if (this.abort.signal.aborted) return;
      backoff = Math.min(backoff ? backoff * 2 : 5_000, 5 * 60_000);
      await sleep(backoff, this.abort.signal);
    }
  }

  private async drain() {
    while (this.pending !== 'none' && this.client?.usable) {
      const kind = this.pending;
      this.pending = 'none';
      try {
        await this.setStatus('syncing');
        if (kind === 'all') await this.syncAll();
        else await this.syncInbox();
        await this.setStatus('idle');
      } catch (err) {
        const message = describeImapError(err);
        console.warn(`[sync:${this.accountId}] 同步失败: ${message}`);
        await this.setStatus('error', message);
        // 关闭连接交给 loop 重连，避免连接处于未知状态
        this.client?.close();
        return;
      }
    }
  }

  private async syncAll() {
    const client = this.client!;
    const list = await this.refreshFolders(client);
    for (const folder of list.filter((f) => f.syncEnabled)) {
      await this.syncFolder(client, folder, true);
    }
    await this.selectInbox(client);
  }

  private async syncInbox() {
    const client = this.client!;
    const inbox = await db.query.folders.findFirst({
      where: and(eq(folders.accountId, this.accountId), eq(folders.path, this.inboxPath)),
    });
    if (inbox?.syncEnabled) await this.syncFolder(client, inbox, true);
    await this.selectInbox(client);
  }

  /** 让连接停在 INBOX 上，imapflow 空闲时会自动发 IDLE */
  private async selectInbox(client: ImapFlow) {
    const lock = await client.getMailboxLock(this.inboxPath, { readOnly: true });
    lock.release();
  }

  private async refreshFolders(client: ImapFlow): Promise<Folder[]> {
    const listed = (await client.list()).filter((f) => !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent'));
    const inbox = listed.find((f) => f.specialUse === '\\Inbox' || f.path.toUpperCase() === 'INBOX');
    if (inbox) this.inboxPath = inbox.path;

    for (const f of listed) {
      await db
        .insert(folders)
        .values({
          accountId: this.accountId,
          path: f.path,
          name: f.name,
          delimiter: f.delimiter,
          specialUse: f.specialUse ?? null,
          syncEnabled: isDefaultSynced(f.path, f.specialUse),
        })
        .onConflictDoUpdate({
          target: [folders.accountId, folders.path],
          set: { name: f.name, delimiter: f.delimiter, specialUse: f.specialUse ?? null },
        });
    }
    const paths = listed.map((f) => f.path);
    if (paths.length) {
      await db.delete(folders).where(and(eq(folders.accountId, this.accountId), notInArray(folders.path, paths)));
    }
    return db.query.folders.findMany({ where: eq(folders.accountId, this.accountId) });
  }

  private async syncFolder(client: ImapFlow, folder: Folder, reconcile: boolean) {
    const lock = await client.getMailboxLock(folder.path, { readOnly: true });
    try {
      const mb = client.mailbox as MailboxObject;
      let lastUid = folder.lastUid;
      let modseq = folder.highestModseq;

      if (folder.uidValidity !== null && folder.uidValidity !== mb.uidValidity) {
        // UIDVALIDITY 变化：服务器重建了文件夹，本地缓存全部作废
        await db.delete(messages).where(eq(messages.folderId, folder.id));
        lastUid = 0;
        modseq = null;
      }

      let maxUid = lastUid;
      if (mb.exists > 0) {
        let uids: number[] = [];
        if (lastUid === 0) {
          const query = this.syncDays === 0 ? { all: true } : { since: new Date(Date.now() - this.syncDays * 86400_000) };
          uids = ((await client.search(query, { uid: true })) as number[] | false) || [];
        } else {
          // 不能用 mb.uidNext 判断：邮箱保持选中时它不会随 EXISTS 更新
          uids = ((await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })) as number[] | false) || [];
          uids = uids.filter((u) => u > lastUid);
        }
        const started = Date.now();
        // 只有收件箱的增量新邮件进入自动化流程；首次回溯、UIDVALIDITY 重建不触发
        const isInbox = folder.specialUse === '\\Inbox' || folder.path.toUpperCase() === 'INBOX';
        const done = await this.downloadNew(client, folder, uids, isInbox && lastUid !== 0);
        // 中途被停止时不推进 lastUid，下次从头补齐（已入库的会跳过）
        if (done) for (const u of uids) if (u > maxUid) maxUid = u;
        if (uids.length) {
          const secs = ((Date.now() - started) / 1000).toFixed(1);
          console.log(`[sync:${this.accountId}] ${folder.path}: ${uids.length} 封待同步，${done ? '完成' : '已中断'}，用时 ${secs}s`);
        }
      }

      const hasLocal = await db.$count(messages, eq(messages.folderId, folder.id));
      if (hasLocal) {
        await this.syncFlags(client, folder, mb, modseq);
        if (reconcile) await this.reconcileDeletions(client, folder);
      }

      const unread = await db.$count(messages, and(eq(messages.folderId, folder.id), eq(messages.seen, false)));
      await db
        .update(folders)
        .set({
          uidValidity: mb.uidValidity,
          lastUid: maxUid,
          highestModseq: mb.highestModseq ?? null,
          totalCount: mb.exists,
          unreadCount: unread,
          lastSyncAt: new Date(),
        })
        .where(eq(folders.id, folder.id));
    } finally {
      lock.release();
    }
  }

  private syncDays = 90;

  /** 新邮件从新到旧分批下载，首次回溯时最新邮件最先可见；已入库的 UID 会跳过，中断后可续传 */
  private async downloadNew(client: ImapFlow, folder: Folder, uids: number[], automate = false): Promise<boolean> {
    if (!uids.length) return true;
    const sorted = [...uids].sort((a, b) => b - a);
    for (let i = 0; i < sorted.length; i += BATCH) {
      if (this.abort.signal.aborted) return false;
      let batch = sorted.slice(i, i + BATCH);
      const existing = await db
        .select({ uid: messages.uid })
        .from(messages)
        .where(and(eq(messages.folderId, folder.id), inArray(messages.uid, batch)));
      const have = new Set(existing.map((r) => r.uid));
      batch = batch.filter((u) => !have.has(u));
      if (!batch.length) continue;

      const meta = await client.fetchAll(batch, { uid: true, size: true }, { uid: true });
      const small = meta.filter((m) => (m.size ?? 0) <= config.maxMessageBytes).map((m) => m.uid);
      const large = meta.filter((m) => (m.size ?? 0) > config.maxMessageBytes).map((m) => m.uid);

      // 注意：不能在 fetch 迭代过程中发其他 IMAP 命令，所以先收集再入库
      const fetched: Array<{ msg: FetchMessageObject; truncated: boolean }> = [];
      const query = { uid: true, flags: true, internalDate: true, size: true, threadId: true };
      if (small.length) {
        for (const msg of await client.fetchAll(small, { ...query, source: true }, { uid: true }))
          fetched.push({ msg, truncated: false });
      }
      if (large.length) {
        for (const msg of await client.fetchAll(large, { ...query, source: { maxLength: TRUNCATED_BYTES } }, { uid: true }))
          fetched.push({ msg, truncated: true });
      }

      for (const { msg, truncated } of fetched) {
        if (!msg.source) continue;
        const row = await ingestMessage({
          accountId: this.accountId,
          folderId: folder.id,
          uid: msg.uid,
          source: msg.source,
          flags: msg.flags ?? new Set(),
          internalDate: msg.internalDate,
          size: msg.size,
          truncated,
          gmThreadId: client.capabilities.has('X-GM-EXT-1') ? msg.threadId : undefined,
        });
        if (automate && row.inserted) await onNewMessage(row.id, row.date);
      }
      bus.publish({ type: 'messages.new', accountId: this.accountId, folderId: folder.id, count: fetched.length });
    }
    return true;
  }

  private async syncFlags(client: ImapFlow, folder: Folder, mb: MailboxObject, modseq: bigint | null) {
    let changed: FetchMessageObject[] = [];
    if (mb.highestModseq && modseq) {
      if (mb.highestModseq === modseq) return;
      changed = await client.fetchAll('1:*', { uid: true, flags: true }, { uid: true, changedSince: modseq });
    } else if (mb.exists > 0) {
      // 不支持 CONDSTORE：只刷新最近 N 封的标记
      changed = await client.fetchAll(`${Math.max(1, mb.exists - FLAG_WINDOW + 1)}:*`, { uid: true, flags: true });
    }
    let updated = 0;
    for (const m of changed) {
      if (m.flags) updated += await this.applyFlags(folder.id, m.uid, m.flags);
    }
    if (updated) {
      await refreshUnread([folder.id]);
      bus.publish({ type: 'messages.updated', accountId: this.accountId, folderId: folder.id });
    }
  }

  private async applyFlags(folderId: number, uid: number, flagSet: Set<string>): Promise<number> {
    const flags = [...flagSet];
    const seen = flags.includes('\\Seen');
    const flagged = flags.includes('\\Flagged');
    const answered = flags.includes('\\Answered');
    const res = await db
      .update(messages)
      .set({ flags, seen, flagged, answered })
      .where(
        and(
          eq(messages.folderId, folderId),
          eq(messages.uid, uid),
          sql`(${messages.seen} <> ${seen} OR ${messages.flagged} <> ${flagged} OR ${messages.answered} <> ${answered})`,
        ),
      );
    return res.rowCount ?? 0;
  }

  private async onFlags(path: string, uid: number | undefined, flags: Set<string>) {
    if (!uid) return;
    const folder = await db.query.folders.findFirst({
      where: and(eq(folders.accountId, this.accountId), eq(folders.path, path)),
    });
    // 在别的客户端读了邮件，服务器实时推送过来：未读数要跟着变
    if (folder && (await this.applyFlags(folder.id, uid, flags))) {
      await refreshUnread([folder.id]);
      bus.publish({ type: 'messages.updated', accountId: this.accountId, folderId: folder.id });
    }
  }

  /** 删除检测：本地 UID 中服务器已不存在的，视为已删除/移走 */
  private async reconcileDeletions(client: ImapFlow, folder: Folder) {
    const [{ min } = { min: null }] = await db
      .select({ min: sql<number | null>`min(${messages.uid})` })
      .from(messages)
      .where(eq(messages.folderId, folder.id));
    if (min === null) return;
    const serverUids = ((await client.search({ uid: `${min}:*` }, { uid: true })) as number[] | false) || [];
    const res = await db
      .delete(messages)
      .where(
        and(
          eq(messages.folderId, folder.id),
          gte(messages.uid, Number(min)),
          // 以单个数组参数传入，避免 UID 很多时超出 PG 参数上限
          sql`${messages.uid} <> ALL(${sql.param(serverUids)}::bigint[])`,
        ),
      );
    if (res.rowCount) bus.publish({ type: 'messages.updated', accountId: this.accountId, folderId: folder.id });
  }

}
