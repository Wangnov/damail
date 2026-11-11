import { eq } from 'drizzle-orm';
import type { ImapFlow } from 'imapflow';
import { db } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { accountCredentials } from '../services/oauth.js';
import { proxyUrlById } from '../services/proxy.js';
import { createImapClient } from './imap.js';
import { L } from '../i18n/index.js';

const IDLE_CLOSE_MS = 60_000;

/**
 * 写操作（标记、移动、APPEND）走独立的 IMAP 连接，不打断同步连接上的 IDLE 和增量同步。
 * 每个账户一条，按顺序执行，空闲 60 秒后断开。
 */
class AccountWriter {
  private client: ImapFlow | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly accountId: number) {}

  run<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      if (this.timer) clearTimeout(this.timer);
      try {
        return await fn(await this.connect());
      } catch (err) {
        // 连接状态未知时直接丢弃，下次重新连接
        this.client?.close();
        this.client = null;
        throw err;
      } finally {
        this.timer = setTimeout(() => void this.close(), IDLE_CLOSE_MS);
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  private async connect(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    const account = await db.query.accounts.findFirst({ where: eq(accounts.id, this.accountId) });
    if (!account) throw new Error(L('账户不存在', 'Account not found'));
    const client = createImapClient({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSecure,
      username: account.username,
      ...(await accountCredentials(account)),
      proxy: await proxyUrlById(account.proxyId),
    });
    client.on('error', () => {});
    await client.connect();
    this.client = client;
    return client;
  }

  async close() {
    const client = this.client;
    this.client = null;
    if (client) await client.logout().catch(() => client.close());
  }
}

const writers = new Map<number, AccountWriter>();

export function withImapWriter<T>(accountId: number, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  let w = writers.get(accountId);
  if (!w) writers.set(accountId, (w = new AccountWriter(accountId)));
  return w.run(fn);
}

export async function closeImapWriters() {
  await Promise.all([...writers.values()].map((w) => w.close()));
  writers.clear();
}
