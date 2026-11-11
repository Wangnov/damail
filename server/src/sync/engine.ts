import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { AccountWorker } from './account-worker.js';
import { GraphWorker } from './graph-worker.js';

type Worker = { start(): void; stop(): Promise<void>; requestSync(kind: 'inbox' | 'all'): void };

/** 先查账户用 IMAP 还是 Graph，再交给对应的 worker；调用方不用关心是哪一种 */
class LazyWorker implements Worker {
  private inner: Worker | null = null;
  private stopped = false;
  private queued: Array<'inbox' | 'all'> = [];

  constructor(private readonly accountId: number) {}

  start() {
    void db.query.accounts.findFirst({ where: eq(accounts.id, this.accountId), columns: { protocol: true } }).then((a) => {
      if (this.stopped || !a) return;
      this.inner = a.protocol === 'graph' ? new GraphWorker(this.accountId) : new AccountWorker(this.accountId);
      this.inner.start();
      for (const kind of this.queued) this.inner.requestSync(kind);
      this.queued = [];
    });
  }

  async stop() {
    this.stopped = true;
    await this.inner?.stop();
  }

  requestSync(kind: 'inbox' | 'all') {
    if (this.inner) this.inner.requestSync(kind);
    else this.queued.push(kind);
  }
}

class SyncEngine {
  private workers = new Map<number, Worker>();

  async start() {
    if (!config.syncEnabled) {
      console.log('[sync] SYNC_ENABLED=false，同步引擎未启动');
      return;
    }
    const list = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.enabled, true));
    for (const { id } of list) this.startAccount(id);
    console.log(`[sync] 已启动 ${list.length} 个账户的同步`);
  }

  startAccount(accountId: number) {
    if (!config.syncEnabled || this.workers.has(accountId)) return;
    const worker = new LazyWorker(accountId);
    this.workers.set(accountId, worker);
    worker.start();
  }

  async stopAccount(accountId: number) {
    const worker = this.workers.get(accountId);
    this.workers.delete(accountId);
    await worker?.stop();
  }

  /** 账户配置变化后重建连接 */
  async restartAccount(accountId: number) {
    await this.stopAccount(accountId);
    this.startAccount(accountId);
  }

  syncNow(accountId: number) {
    const worker = this.workers.get(accountId);
    if (worker) worker.requestSync('all');
    else this.startAccount(accountId);
  }

  async stopAll() {
    await Promise.all([...this.workers.keys()].map((id) => this.stopAccount(id)));
  }
}

export const syncEngine = new SyncEngine();
