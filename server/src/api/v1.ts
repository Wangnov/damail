import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { actorOf, requireAuth, requireScope, type AppEnv } from '../auth/index.js';
import { config } from '../config.js';
import { audit, skipRequestAudit } from '../lib/audit.js';
import { ActionError, deleteMessages, moveMessages, setFlags, threadMessageIds } from '../services/actions.js';
import { clearFollowUp, setFollowUp } from '../services/followups.js';
import { labelNames, listLabels, setMessageLabels, setThreadLabels } from '../services/labels.js';
import { listCategories } from '../services/catalog.js';
import { listSubscriptions, querySubscriptions, unsubscribe } from '../services/subscriptions.js';
import { semanticSearch } from '../services/semantic.js';
import { translateMessage } from '../services/translate.js';
import {
  addAttachment,
  cancelDraft,
  composeText,
  createDraft,
  deleteDraft,
  draftFields,
  getDraft,
  listDrafts,
  queueDraft,
  rejectDraft,
  removeAttachment,
  submitDraft,
  updateDraft,
} from '../services/drafts.js';
import { bus, type HubEvent } from '../lib/events.js';
import {
  getAttachment,
  getMessage,
  getRaw,
  getStats,
  getThread,
  listAccountsWithStats,
  listFolders,
  listThreads,
  unreadMessageIds,
  searchContacts,
  searchMessages,
  type View,
} from '../services/mail.js';
import { L, pickLocale } from '../i18n/index.js';
import { addIgnored, listIgnored, removeIgnored } from '../services/contacts.js';

const batchAction = z.object({
  ids: z.array(z.number().int()).min(1).max(1000),
  action: z.enum(['read', 'unread', 'star', 'unstar', 'archive', 'trash', 'inbox', 'junk', 'move', 'delete']),
  folderId: z.number().int().optional(),
});

const threadBatch = z.object({
  threadIds: z.array(z.string().min(1)).min(1).max(500),
  action: z.enum(['read', 'unread', 'star', 'unstar', 'archive', 'trash', 'delete']),
});

const FLAG_ACTIONS = {
  read: { seen: true },
  unread: { seen: false },
  star: { flagged: true },
  unstar: { flagged: false },
} as const;

const sendOptions = z.object({
  delaySec: z.number().int().min(0).max(3600).optional(),
  sendAt: z.coerce.date().optional(),
  // 网页批准待审批草稿时带上用户审阅的版本号
  revision: z.number().int().min(0).optional(),
});

async function body(c: { req: { json: () => Promise<unknown> } }) {
  return c.req.json().catch(() => ({}));
}

const VIEWS = new Set<View>(['inbox', 'important', 'sent', 'starred', 'unread', 'all']);
// 等回复是按会话算的，只给会话列表用
const THREAD_VIEWS = new Set<View>([...VIEWS, 'waiting']);

const followUpInput = z.union([z.object({ dueAt: z.coerce.date() }), z.object({ done: z.literal(true) })]);

const ignoreListRoutes = new Hono<AppEnv>()
  .use(requireScope('automation'))
  .use(async (c, next) => {
    // 忽略名单对所有邮箱生效，与 MCP 自动化工具保持相同限制。
    if (c.var.auth.scope.accountIds)
      throw new ActionError(
        L('忽略名单对所有邮箱生效，需要全部邮箱的访问权限', 'The ignore list affects all mailboxes and requires access to all accounts'),
        403,
      );
    await next();
  })
  .get('/', async (c) => c.json(await listIgnored()))
  .post('/', async (c) => {
    const { pattern } = z.object({ pattern: z.string().max(320) }).parse(await body(c));
    const res = await addIgnored(pattern);
    audit(actorOf(c.var.auth), 'ignored_sender.add', { target: res.pattern, detail: { removedInsights: res.removedInsights } });
    return c.json(res);
  })
  .delete('/:pattern', async (c) => {
    const res = await removeIgnored(c.req.param('pattern'));
    audit(actorOf(c.var.auth), 'ignored_sender.remove', { target: res.pattern });
    return c.json(res);
  });

function num(v: string | undefined) {
  const n = Number(v);
  return v && Number.isFinite(n) ? n : undefined;
}

function contentDisposition(kind: 'inline' | 'attachment', filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// 允许浏览器内联预览的类型；其他一律强制下载，避免附件里的 HTML/SVG 在本站同源执行
const INLINE_SAFE = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf|text\/plain)$/i;

export const v1Routes = new Hono<AppEnv>()
  .use(requireAuth('read'))
  .route('/ignored-senders', ignoreListRoutes)
  .get('/accounts', async (c) => c.json(await listAccountsWithStats(c.var.auth.scope)))
  .get('/folders', async (c) => c.json(await listFolders(c.var.auth.scope, num(c.req.query('account')))))
  .get('/stats', async (c) => c.json(await getStats(c.var.auth.scope)))
  .get('/threads', async (c) => {
    const view = c.req.query('view') as View | undefined;
    return c.json(
      await listThreads({
        scope: c.var.auth.scope,
        view: view && THREAD_VIEWS.has(view) ? view : undefined,
        accountId: num(c.req.query('account')),
        folderId: num(c.req.query('folder')),
        q: c.req.query('q'),
        cursor: c.req.query('cursor'),
        limit: num(c.req.query('limit')),
      }),
    );
  })
  .get('/threads/:id', async (c) => {
    const thread = await getThread(c.var.auth.scope, c.req.param('id'));
    return thread ? c.json(thread) : c.json({ error: 'not found' }, 404);
  })
  .get('/messages', async (c) => {
    const view = c.req.query('view') as View | undefined;
    return c.json(
      await searchMessages({
        scope: c.var.auth.scope,
        view: view && VIEWS.has(view) ? view : undefined,
        accountId: num(c.req.query('account')),
        folderId: num(c.req.query('folder')),
        q: c.req.query('q'),
        cursor: c.req.query('cursor'),
        limit: num(c.req.query('limit')),
      }),
    );
  })
  // 自然语言搜索，每次会调用两次模型，前端只在用户明确点「AI 搜索」时调用
  .post('/search/semantic', async (c) => {
    const { q, limit } = z.object({ q: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(50).optional() }).parse(await c.req.json());
    // 搜索是只读操作，网页上的搜索和普通 GET 一样不记录
    if (c.var.auth.kind === 'session') skipRequestAudit();
    try {
      return c.json(await semanticSearch(c.var.auth.scope, q, { limit }));
    } catch (err) {
      if (err instanceof ActionError) throw err;
      throw new ActionError(L(`AI 搜索失败：${(err as Error).message}`, `AI search failed: ${(err as Error).message}`));
    }
  })
  .get('/messages/:id', async (c) => {
    const msg = await getMessage(c.var.auth.scope, Number(c.req.param('id')));
    if (!msg) return c.json({ error: 'not found' }, 404);
    if (c.req.query('format') === 'text') return c.json({ ...msg, html: undefined });
    return c.json(msg);
  })
  // 一键翻译：译文按目标语言保存，再次请求直接返回；force 重新翻译
  .post('/messages/:id/translate', async (c) => {
    const { force } = z.object({ force: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    const res = await translateMessage(c.var.auth.scope, Number(c.req.param('id')), { force });
    return res ? c.json(res) : c.json({ error: 'not found' }, 404);
  })
  .get('/messages/:id/raw', async (c) => {
    const raw = await getRaw(c.var.auth.scope, Number(c.req.param('id')));
    if (!raw) return c.json({ error: 'not found' }, 404);
    return c.body(new Uint8Array(raw), 200, {
      'content-type': 'message/rfc822',
      'content-disposition': contentDisposition('attachment', `message-${c.req.param('id')}.eml`),
    });
  })
  .get('/messages/:id/attachments/:index', async (c) => {
    const att = await getAttachment(c.var.auth.scope, Number(c.req.param('id')), Number(c.req.param('index')));
    if (!att) return c.json({ error: 'not found' }, 404);
    const inline = c.req.query('inline') === '1' && INLINE_SAFE.test(att.contentType);
    return c.body(new Uint8Array(att.content), 200, {
      'content-type': inline ? att.contentType : 'application/octet-stream',
      'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', att.filename),
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=86400',
    });
  })
  // 近 N 天带退订信息的订阅邮件，按数量排序
  // 带 page 参数时分页：返回 { items, total, counts }，filter 可选 all | ignored | unsubscribed，sort 可选 count | openRate | lastDate、order asc | desc；
  // 不带 page 时照旧返回数组（最多 300 个）
  .get('/subscriptions', async (c) => {
    const days = Math.min(Math.max(num(c.req.query('days')) ?? 90, 7), 365);
    const page = num(c.req.query('page'));
    if (!page) return c.json(await listSubscriptions(c.var.auth.scope, days));
    const pageSize = Math.min(Math.max(num(c.req.query('pageSize')) ?? 50, 1), 200);
    const f = c.req.query('filter');
    const filter = f === 'ignored' || f === 'unsubscribed' ? f : 'all';
    const so = c.req.query('sort');
    const sort = so === 'openRate' || so === 'lastDate' ? so : 'count';
    const order = c.req.query('order') === 'asc' ? 'asc' : 'desc';
    return c.json(await querySubscriptions(c.var.auth.scope, { days, filter, sort, order, offset: (Math.max(1, page) - 1) * pageSize, limit: pageSize }));
  })
  .get('/contacts', async (c) => {
    const q = c.req.query('q')?.trim();
    return c.json(q ? await searchContacts(c.var.auth.scope, q) : []);
  })

  // ---- 整理邮件（organize）----
  .post('/messages/batch', requireScope('organize'), async (c) => {
    const { ids, action, folderId } = batchAction.parse(await body(c));
    const scope = c.var.auth.scope;
    // 网页上打开邮件就会标记已读，这类高频小操作不进审计；开放接口调用仍然记录
    if (action in FLAG_ACTIONS && c.var.auth.kind === 'session') skipRequestAudit();
    let result: object;
    if (action in FLAG_ACTIONS) result = await setFlags(scope, ids, FLAG_ACTIONS[action as keyof typeof FLAG_ACTIONS]);
    else if (action === 'delete') result = await deleteMessages(scope, ids);
    else if (action === 'move') {
      if (!folderId) throw new ActionError(L('move 需要提供 folderId', 'move requires folderId'));
      result = await moveMessages(scope, ids, { folderId });
    } else result = await moveMessages(scope, ids, action as 'archive' | 'trash' | 'inbox' | 'junk');
    if (!(action in FLAG_ACTIONS)) audit(actorOf(c.var.auth), `messages.${action}`, { detail: { ids, folderId } });
    return c.json(result);
  })

  // 跟进提醒：dueAt 到期没回复就提醒；done 表示不用再等
  .put('/messages/:id/follow-up', requireScope('organize'), async (c) => {
    const input = followUpInput.parse(await body(c));
    return c.json(await setFollowUp(c.var.auth.scope, Number(c.req.param('id')), 'done' in input ? { done: true } : { dueAt: input.dueAt }));
  })
  .delete('/messages/:id/follow-up', requireScope('organize'), async (c) => {
    await clearFollowUp(c.var.auth.scope, Number(c.req.param('id')));
    return c.json({ ok: true });
  })
  // 标签：列表（含数量）；给邮件手动加、去掉标签（手动去掉的，重新分析也不会再打回来）
  .get('/labels', async (c) => {
    const list = await listLabels(c.var.auth.scope);
    return c.json(
      list.map((l) => ({
        id: l.id,
        name: l.name,
        names: labelNames(l.i18n),
        description: l.description,
        i18n: l.i18n,
        color: l.color,
        pinned: l.pinned,
        source: l.source,
        total: l.total,
        unread: l.unread,
      })),
    );
  })
  // 系统内置的分类（只读）：key 是搜索 category: 和邮件 insight 里用的值；name / description 是当前语言的，i18n 是所有语言的
  .get('/categories', (c) =>
    c.json(listCategories().map((cat) => ({ key: cat.key, ...pickLocale(cat.i18n), i18n: cat.i18n, color: cat.color, builtin: cat.builtin }))),
  )
  .put('/messages/:id/labels', requireScope('organize'), async (c) => {
    const input = z.object({ add: z.array(z.number().int()).max(50).optional(), remove: z.array(z.number().int()).max(50).optional() }).parse(await body(c));
    const id = Number(c.req.param('id'));
    const labels = await setMessageLabels(c.var.auth.scope, id, input);
    audit(actorOf(c.var.auth), 'message.labels', { target: `message:${id}`, detail: input });
    return c.json(labels);
  })

  // 退订：一键退订直接请求对方；只有 mailto 时会发一封退订邮件，所以需要发信权限
  .post('/messages/:id/unsubscribe', requireScope('send'), async (c) => c.json(await unsubscribe(c.var.auth, Number(c.req.param('id')))))

  // 按会话批量操作（列表多选）
  .post('/threads/batch', requireScope('organize'), async (c) => {
    const { threadIds, action } = threadBatch.parse(await body(c));
    const scope = c.var.auth.scope;
    const ids = await threadMessageIds(scope, threadIds, action);
    if (action in FLAG_ACTIONS && c.var.auth.kind === 'session') skipRequestAudit();
    if (!ids.length) return c.json({ updated: 0, moved: 0 });
    let result: object;
    if (action in FLAG_ACTIONS) result = await setFlags(scope, ids, FLAG_ACTIONS[action as keyof typeof FLAG_ACTIONS]);
    else {
      result = action === 'delete' ? await deleteMessages(scope, ids) : await moveMessages(scope, ids, action as 'archive' | 'trash');
      audit(actorOf(c.var.auth), `messages.${action}`, { detail: { ids, threadIds } });
    }
    return c.json(result);
  })

  // 全部标为已读：按会话列表的筛选条件（视图 / 邮箱 / 文件夹 / 搜索）
  .post('/threads/mark-read', requireScope('organize'), async (c) => {
    const input = z
      .object({
        view: z.string().optional(),
        account: z.number().int().optional(),
        folder: z.number().int().optional(),
        q: z.string().max(2000).optional(),
      })
      .parse(await body(c));
    const scope = c.var.auth.scope;
    const ids = await unreadMessageIds({
      scope,
      view: input.view && THREAD_VIEWS.has(input.view as View) ? (input.view as View) : undefined,
      accountId: input.account,
      folderId: input.folder,
      q: input.q,
    });
    if (c.var.auth.kind === 'session') skipRequestAudit();
    if (!ids.length) return c.json({ updated: 0 });
    return c.json(await setFlags(scope, ids, { seen: true }));
  })

  // 按会话加、去掉标签
  .post('/threads/labels', requireScope('organize'), async (c) => {
    const input = z
      .object({
        threadIds: z.array(z.string().min(1)).min(1).max(500),
        add: z.array(z.number().int()).max(50).optional(),
        remove: z.array(z.number().int()).max(50).optional(),
      })
      .parse(await body(c));
    const res = await setThreadLabels(c.var.auth.scope, input.threadIds, input);
    audit(actorOf(c.var.auth), 'message.labels', { detail: input });
    return c.json(res);
  })

  // ---- 草稿与发件箱 ----
  .get('/drafts', async (c) => {
    const status = c.req.query('status')?.split(',').filter(Boolean);
    return c.json(await listDrafts(c.var.auth, { status, threadId: c.req.query('thread'), limit: num(c.req.query('limit')) }));
  })
  .get('/drafts/:id', async (c) => {
    const d = await getDraft(c.var.auth, Number(c.req.param('id')));
    if (!d) return c.json({ error: 'not found' }, 404);
    return c.json({ ...d, preview: composeText(d), sendDelaySec: config.sendDelaySec });
  })
  .post('/drafts', requireScope('draft'), async (c) => {
    const source = c.var.auth.kind === 'session' ? 'web' : 'api';
    return c.json(await createDraft(c.var.auth, (await body(c)) as never, source), 201);
  })
  .patch('/drafts/:id', requireScope('draft'), async (c) => c.json(await updateDraft(c.var.auth, Number(c.req.param('id')), draftFields.parse(await body(c)))))
  .delete('/drafts/:id', requireScope('draft'), async (c) => {
    await deleteDraft(c.var.auth, Number(c.req.param('id')));
    return c.json({ ok: true });
  })
  .post('/drafts/:id/attachments', requireScope('draft'), async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) throw new ActionError(L('请上传文件（字段名 file）', 'Upload a file (field name: file)'));
    if (file.size > config.maxAttachmentBytes) throw new ActionError(L('附件过大', 'Attachment too large'));
    const content = Buffer.from(await file.arrayBuffer());
    return c.json(await addAttachment(c.var.auth, Number(c.req.param('id')), { name: file.name, type: file.type, content }));
  })
  .delete('/drafts/:id/attachments/:index', requireScope('draft'), async (c) =>
    c.json(await removeAttachment(c.var.auth, Number(c.req.param('id')), Number(c.req.param('index')))),
  )
  .post('/drafts/:id/submit', requireScope('draft'), async (c) => {
    const { note } = z.object({ note: z.string().max(2000).optional() }).parse(await body(c));
    return c.json(await submitDraft(c.var.auth, Number(c.req.param('id')), note));
  })
  .post('/drafts/:id/send', requireScope('send'), async (c) =>
    c.json(await queueDraft(c.var.auth, Number(c.req.param('id')), sendOptions.parse(await body(c)))),
  )
  .post('/drafts/:id/cancel', requireScope('draft'), async (c) => c.json(await cancelDraft(c.var.auth, Number(c.req.param('id')))))
  .post('/drafts/:id/reject', async (c) => {
    if (c.var.auth.kind !== 'session') throw new ActionError(L('只能在网页上审批', 'Can only be approved on the web'), 403);
    const { reason } = z.object({ reason: z.string().max(500).optional() }).parse(await body(c));
    return c.json(await rejectDraft(c.var.auth, Number(c.req.param('id')), reason));
  })

  .get('/events', (c) => {
    const scope = c.var.auth.scope;
    return streamSSE(c, async (stream) => {
      const queue: HubEvent[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = bus.subscribe((ev) => {
        if (scope.accountIds && !scope.accountIds.includes(ev.accountId)) return;
        queue.push(ev);
        wake?.();
      });
      stream.onAbort(unsubscribe);
      await stream.writeSSE({ event: 'ready', data: '{}' });
      while (!stream.aborted) {
        if (!queue.length) {
          await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(25_000)]);
          wake = null;
        }
        if (!queue.length) {
          await stream.writeSSE({ event: 'ping', data: '{}' });
          continue;
        }
        for (const ev of queue.splice(0)) await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
      }
      unsubscribe();
    });
  });
