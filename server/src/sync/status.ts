import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, folders, type Account } from '../db/schema.js';
import { bus } from '../lib/events.js';
import { emitEvent } from '../services/notify.js';
import { L } from '../i18n/index.js';

// 新发现的文件夹默认同步这几类，其他文件夹由用户在「同步文件夹」里开启；已有文件夹保留用户的设置
const DEFAULT_SYNCED = ['\\Inbox', '\\Sent', '\\Drafts', '\\Junk', '\\Trash'];

export function isDefaultSynced(path: string, specialUse?: string | null) {
  return path.toUpperCase() === 'INBOX' || DEFAULT_SYNCED.includes(specialUse ?? '');
}

/** 同一账户两次异常通知的最短间隔：失败与恢复来回切换时不刷屏 */
export const ERROR_ALERT_COOLDOWN_MS = 60 * 60_000;

/** 账户连接状态：写库并推送给前端，刚进入异常时发通知 */
export class StatusReporter {
  last = '';
  /** 本轮异常已经通知过：重试时会经过 connecting / syncing，不能只看上一个状态，同步成功后才清除 */
  private alerted = false;
  lastAlertAt = 0;

  constructor(private readonly accountId: number) {}

  async set(status: string, error: string | null = null) {
    if (status === 'idle' || status === 'disabled') this.alerted = false;
    if (status === 'error' && !this.alerted && Date.now() - this.lastAlertAt >= ERROR_ALERT_COOLDOWN_MS) {
      // 先占位再查库，并发的两次 set('error') 也只发一条
      this.alerted = true;
      this.lastAlertAt = Date.now();
      const acc = await db.query.accounts.findFirst({ where: eq(accounts.id, this.accountId) });
      void emitEvent('account.error', {
        title: L(`邮箱连接异常：${acc?.email ?? this.accountId}`, `Mailbox connection problem: ${acc?.email ?? this.accountId}`),
        body: error ?? L('未知错误', 'Unknown error'),
        data: { accountId: this.accountId, error },
      }).catch((err) => console.error('[notify]', err));
    }
    this.last = status;
    const patch: Partial<Account> = { status, lastError: error };
    if (status === 'idle') patch.lastSyncAt = new Date();
    await db.update(accounts).set(patch).where(eq(accounts.id, this.accountId));
    bus.publish({ type: 'account.status', accountId: this.accountId, status, error });
  }
}

/** 给没有 UID 的 Graph 邮件分配本地 UID：按文件夹原子递增，同步和移动同时进行也不会撞号 */
export async function nextUid(folderId: number): Promise<number> {
  const [row] = await db
    .update(folders)
    .set({ lastUid: sql`${folders.lastUid} + 1` })
    .where(eq(folders.id, folderId))
    .returning({ uid: folders.lastUid });
  if (!row) throw new Error(L('文件夹不存在', 'Folder not found'));
  return row.uid;
}

/** 按本地邮件重算文件夹未读数（侧边栏显示的数字） */
export async function refreshUnread(folderIds: number[]) {
  if (!folderIds.length) return;
  await db
    .update(folders)
    .set({
      unreadCount: sql`(SELECT count(*) FROM messages m WHERE m.folder_id = "folders"."id" AND NOT m.seen)::int`,
    })
    .where(inArray(folders.id, folderIds));
}
