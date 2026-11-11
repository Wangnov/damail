import {
  CheckOutlined,
  CloseOutlined,
  ContainerOutlined,
  DeleteOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  PaperClipOutlined,
  StarFilled,
  StarOutlined,
} from '@ant-design/icons';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Checkbox, Empty, Flex, Listy, Segmented, Spin, Tooltip, Typography, theme, type ListyRef } from 'antd';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, threadBatchAction, type ThreadBatchAction, type ThreadSummary } from '../api';
import { t } from '../i18n';
import { useAccounts } from '../hooks/data';
import { colorFor, shortDate } from '../lib/format';
import { WaitingLine } from './FollowUp';
import { InsightTags } from './Insight';
import { LabelTags } from './Labels';
import { SenderAvatar } from './SenderAvatar';
import { ThreadContextMenu, type ThreadMenuTarget } from './ThreadContextMenu';

type Props = {
  view: string;
  accountId: string | null;
  folderId: string | null;
  /** 当前是「已删除」文件夹，删除按钮改为彻底删除 */
  inTrash?: boolean;
  q: string;
  selected: string | null;
  onSelect: (threadId: string) => void;
  /** 批量归档 / 删除后，当前打开的会话可能已经不在列表里 */
  onRemoved?: (threadIds: string[]) => void;
  /** 只看未读（顶栏的「全部 / 未读」切换） */
  unreadOnly?: boolean;
  onUnreadOnly?: (on: boolean) => void;
};

/** 这些列表本来就只有未读或只有自己发的邮件，不需要「只看未读」 */
function canFilterUnread(view: string, accountId: string | null, folderId: string | null, q: string) {
  if (/(^|\s)is:unread\b/.test(q)) return false;
  if (accountId || folderId) return true;
  return !['unread', 'sent', 'waiting'].includes(view);
}

type Page = { items: ThreadSummary[]; nextCursor: string | null };

function useElementHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setHeight(Math.floor(entry!.contentRect.height)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, height] as const;
}

export function ThreadList({ view, accountId, folderId, inTrash, q, selected, onSelect, onRemoved, unreadOnly, onUnreadOnly }: Props) {
  const { token } = theme.useToken();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const accounts = useAccounts();
  const [boxRef, height] = useElementHeight<HTMLDivElement>();
  const multiAccount = (accounts.data?.length ?? 0) > 1;
  const accountById = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data]);

  const filterable = canFilterUnread(view, accountId, folderId, q) && Boolean(onUnreadOnly);
  const unread = filterable && Boolean(unreadOnly);
  // 只看未读用搜索语法 is:unread 实现，和分类、文件夹等条件叠加
  const apiQ = unread ? `${q} is:unread`.trim() : q;

  const query = useInfiniteQuery({
    queryKey: ['threads', { view, accountId, folderId, q: apiQ }],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      if (!folderId && !accountId) p.set('view', view);
      if (accountId) p.set('account', accountId);
      if (folderId) p.set('folder', folderId);
      if (apiQ) p.set('q', apiQ);
      if (pageParam) p.set('cursor', pageParam);
      p.set('limit', '50');
      return api<Page>(`/api/v1/threads?${p}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });

  const loaded = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  // 只看未读时，打开的会话会被标为已读、从结果里消失；在原来的位置留着它，直到打开别的会话或切换列表
  const kept = useRef<{ item: ThreadSummary; index: number } | null>(null);
  const items = useMemo(() => {
    const k = kept.current;
    if (!unread || !selected || !k || k.item.threadId !== selected || loaded.some((x) => x.threadId === selected)) return loaded;
    const next = [...loaded];
    next.splice(Math.min(k.index, next.length), 0, { ...k.item, unread: false });
    return next;
  }, [loaded, unread, selected]);
  useEffect(() => {
    const index = selected ? loaded.findIndex((x) => x.threadId === selected) : -1;
    if (unread && index >= 0) kept.current = { item: loaded[index]!, index };
  }, [loaded, unread, selected]);

  // 切换视图时重建列表，滚动位置回到顶部，并清空多选
  const listKey = `${view}|${accountId}|${folderId}|${apiQ}`;
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [acting, setActing] = useState<ThreadBatchAction | null>(null);
  useEffect(() => {
    setChecked(new Set());
    anchor.current = null;
  }, [listKey]);

  // 列表刷新后去掉已经不在列表里的会话
  useEffect(() => {
    setChecked((prev) => {
      if (!prev.size) return prev;
      const present = new Set(items.map((x) => x.threadId));
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  useEffect(() => {
    if (!checked.size) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChecked(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [checked.size]);

  /** 勾选单个会话；按住 Shift 时选中上次勾选位置到这里之间的全部会话 */
  const toggle = (threadId: string, shift: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      const on = !prev.has(threadId);
      const from = anchor.current ? items.findIndex((t) => t.threadId === anchor.current) : -1;
      const to = items.findIndex((t) => t.threadId === threadId);
      if (shift && from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from];
        for (const t of items.slice(a, b + 1)) {
          if (on) next.add(t.threadId);
          else next.delete(t.threadId);
        }
      } else if (on) next.add(threadId);
      else next.delete(threadId);
      return next;
    });
    anchor.current = threadId;
  };

  const allChecked = items.length > 0 && items.every((t) => checked.has(t.threadId));
  const checkedItems = items.filter((t) => checked.has(t.threadId));
  const anyUnread = checkedItems.some((t) => t.unread);
  const anyUnstarred = checkedItems.some((t) => !t.flagged);

  /** 批量操作：默认对已勾选的会话，右键菜单传入要操作的会话 */
  const runBatch = async (action: ThreadBatchAction, threadIds?: string[]) => {
    const ids = threadIds ?? [...checked];
    if (!ids.length) return;
    if (action === 'delete') {
      const ok = await modal.confirm({
        title: t.threads.deleteForeverTitle(ids.length),
        content: t.threads.deleteForeverContent,
        okText: t.threads.deleteForever,
        okButtonProps: { danger: true },
      });
      if (!ok) return;
    }
    setActing(action);
    try {
      const res = await threadBatchAction(ids, action);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['threads'] }),
        qc.invalidateQueries({ queryKey: ['thread'] }),
        qc.invalidateQueries({ queryKey: ['stats'] }),
        qc.invalidateQueries({ queryKey: ['folders'] }),
      ]);
      const n = res.updated ?? res.moved ?? res.deleted ?? 0;
      message.success(t.threads.batchResult(t.threads.batchDone[action], res.destination, n));
      if (action === 'archive' || action === 'trash' || action === 'delete') {
        onRemoved?.(ids);
        setChecked((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
      }
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setActing(null);
    }
  };

  // ---- 右键菜单：右键已勾选的会话时对全部勾选的操作，否则只对这一个（不改变勾选） ----
  const [menu, setMenu] = useState<ThreadMenuTarget | null>(null);
  const openMenu = (e: React.MouseEvent, th: ThreadSummary) => {
    // 按住 Shift 右键仍然是浏览器自己的菜单（复制文字等）
    if (e.shiftKey) return;
    e.preventDefault();
    const multi = checked.has(th.threadId) && checked.size > 1;
    setMenu({ x: e.clientX, y: e.clientY, multi, threads: multi ? items.filter((x) => checked.has(x.threadId)) : [th] });
  };
  const menuTarget = menu && !menu.multi ? menu.threads[0]!.threadId : null;

  // ---- 鼠标拖选：按住一行上下拖动，经过的会话都勾上；从已勾选的行开始拖则取消勾选 ----
  const listRef = useRef<ListyRef>(null);
  const scrollTop = useRef(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const indexById = useMemo(() => new Map(items.map((t, i) => [t.threadId, i])), [items]);
  const drag = useRef<{ start: number; base: Set<string>; on: boolean; x: number; y: number; active: boolean } | null>(null);
  // 拖选结束时松开鼠标会触发一次 click，不能让它再去打开或勾选会话
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);

  /** 按当前指针位置更新拖选范围（指针拖出列表上下边缘时按边缘那一行算） */
  const applyDrag = () => {
    const d = drag.current;
    const box = boxRef.current?.getBoundingClientRect();
    if (!d?.active || !box) return;
    const y = Math.min(Math.max(d.y, box.top + 2), box.bottom - 2);
    const row = document.elementFromPoint(box.left + box.width / 2, y)?.closest<HTMLElement>('.thread-item[data-index]');
    if (!row) return;
    const end = Number(row.dataset.index);
    const list = itemsRef.current;
    const [a, b] = end < d.start ? [end, d.start] : [d.start, end];
    const next = new Set(d.base);
    for (const t of list.slice(a, b + 1)) {
      if (d.on) next.add(t.threadId);
      else next.delete(t.threadId);
    }
    setChecked(next);
    anchor.current = list[end]?.threadId ?? anchor.current;
  };

  const startDrag = (e: React.PointerEvent, threadId: string) => {
    if (e.button !== 0 || e.pointerType !== 'mouse' || e.shiftKey || e.metaKey || e.ctrlKey) return;
    const start = indexById.get(threadId);
    if (start === undefined) return;
    drag.current = { start, base: new Set(checked), on: !checked.has(threadId), x: e.clientX, y: e.clientY, active: false };
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      d.x = ev.clientX;
      d.y = ev.clientY;
      // 移动超过 6px 才算拖选，普通点击不受影响
      if (!d.active && Math.abs(ev.clientY - e.clientY) < 6) return;
      if (!d.active) {
        d.active = true;
        setDragging(true);
      }
      window.getSelection()?.removeAllRanges();
      applyDrag();
    };
    const up = () => {
      if (drag.current?.active) {
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 0);
      }
      drag.current = null;
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // 拖到列表上下边缘附近时自动滚动，越靠近边缘越快
  useEffect(() => {
    if (!dragging) return;
    let raf = 0;
    const tick = () => {
      const d = drag.current;
      const box = boxRef.current?.getBoundingClientRect();
      if (d?.active && box) {
        const edge = 48;
        const up = box.top + edge - d.y;
        const down = d.y - (box.bottom - edge);
        const step = up > 0 ? -Math.min(24, 2 + up / 3) : down > 0 ? Math.min(24, 2 + down / 3) : 0;
        if (step) {
          listRef.current?.scrollTo({ top: Math.max(0, scrollTop.current + step) });
          applyDrag();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // applyDrag 只读 ref，不需要随渲染重建
  }, [dragging]);

  const onScroll = (e: React.UIEvent<HTMLElement>) => {
    const el = e.currentTarget;
    if (menu) setMenu(null);
    scrollTop.current = el.scrollTop;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300 && query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  };

  const renderItem = (th: ThreadSummary) => {
    const sender = th.participants.length ? th.participants.join(t.threads.participantSep) : th.from.name || th.from.address || t.threads.unknownSender;
    const isChecked = checked.has(th.threadId);
    return (
      <div
        className={`thread-item${th.threadId === selected ? ' active' : ''}${isChecked ? ' checked' : ''}${th.threadId === menuTarget ? ' context' : ''}${th === items[0] ? ' first' : ''}${th === items.at(-1) ? ' last' : ''}`}
        data-index={indexById.get(th.threadId)}
        onPointerDown={(e) => startDrag(e, th.threadId)}
        onContextMenu={(e) => openMenu(e, th)}
        onClick={(e) => {
          if (suppressClick.current) return;
          // 已经在多选时，点击整行等于勾选，避免误打开
          if (checked.size && !e.metaKey && !e.ctrlKey) return toggle(th.threadId, e.shiftKey);
          if (e.metaKey || e.ctrlKey || e.shiftKey) return toggle(th.threadId, e.shiftKey);
          onSelect(th.threadId);
        }}
      >
        {/* 点头像选中，选中后头像换成对勾 */}
        <button
          type="button"
          className="thread-lead"
          aria-pressed={isChecked}
          aria-label={isChecked ? t.threads.deselect : t.threads.select}
          onClick={(e) => {
            e.stopPropagation();
            if (!suppressClick.current) toggle(th.threadId, e.shiftKey);
          }}
        >
          {isChecked ? (
            <span className="thread-lead-checked">
              <CheckOutlined />
            </span>
          ) : (
            <SenderAvatar address={th.from.address} name={th.from.name || th.from.address || '?'} />
          )}
        </button>
        <div className="thread-body">
          <div className="line">
            {th.unread ? <span className="unread-dot" /> : <span style={{ width: 8, flex: 'none' }} />}
            <Typography.Text strong={th.unread} className="ellipsis" style={{ flex: 1 }}>
              {sender}
            </Typography.Text>
            {th.messageCount > 1 && <Typography.Text type="secondary">{th.messageCount}</Typography.Text>}
            {th.hasAttachments && <PaperClipOutlined style={{ color: token.colorTextSecondary }} />}
            {th.flagged && <StarFilled style={{ color: token.colorWarning }} />}
            <Typography.Text type="secondary" style={{ fontSize: 12, flex: 'none' }}>
              {shortDate(th.lastDate)}
            </Typography.Text>
          </div>
          <div className="line" style={{ paddingLeft: 14, marginTop: 2 }}>
            <Typography.Text strong={th.unread} className="ellipsis thread-subject">
              {th.subject || t.threads.noSubject}
            </Typography.Text>
            <span className="thread-tags">
              <InsightTags insight={th.insight} />
              <LabelTags labels={th.labels} />
              {multiAccount &&
                th.accountIds.map((id) => {
                  const acc = accountById.get(id);
                  return acc ? (
                    <span key={id} className="thread-account" title={acc.email}>
                      <i style={{ background: acc.color ?? colorFor(acc.id) }} />
                      <span>{acc.name}</span>
                    </span>
                  ) : null;
                })}
            </span>
          </div>
          <div className="line" style={{ paddingLeft: 14, marginTop: 2 }}>
            {th.waiting ? (
              <WaitingLine waiting={th.waiting} />
            ) : (
              <Typography.Text type="secondary" className="ellipsis" style={{ fontSize: 13 }}>
                {th.snippet || ' '}
              </Typography.Text>
            )}
          </div>
        </div>
      </div>
    );
  };

  const batchButton = (action: ThreadBatchAction, title: string, icon: React.ReactNode, danger?: boolean) => (
    <Tooltip title={title}>
      <Button
        type="text"
        size="small"
        danger={danger}
        icon={icon}
        aria-label={title}
        loading={acting === action}
        disabled={!!acting && acting !== action}
        onClick={() => void runBatch(action)}
      />
    </Tooltip>
  );

  // 只看未读时即使没有结果也要显示顶栏，否则切不回「全部」
  const toolbar = (items.length > 0 || unread) && (
    <Flex
      align="center"
      gap={8}
      style={{
        height: 40,
        padding: '0 10px 0 13px',
        borderBottom: `1px solid ${token.colorSplit}`,
        background: checked.size ? token.colorPrimaryBg : undefined,
        flex: 'none',
      }}
    >
      <Checkbox
        checked={allChecked}
        disabled={!items.length}
        indeterminate={checked.size > 0 && !allChecked}
        aria-label={t.threads.selectAll}
        onChange={(e) => setChecked(e.target.checked ? new Set(items.map((x) => x.threadId)) : new Set())}
      />
      {checked.size ? (
        <>
          <Typography.Text strong style={{ whiteSpace: 'nowrap' }}>
            {t.threads.selected(checked.size)}
          </Typography.Text>
          <Flex gap={2} style={{ marginLeft: 'auto' }}>
            {batchButton('archive', t.threads.archive, <ContainerOutlined />)}
            {inTrash ? batchButton('delete', t.threads.deleteForever, <DeleteOutlined />, true) : batchButton('trash', t.threads.trash, <DeleteOutlined />)}
            {anyUnread ? batchButton('read', t.threads.markRead, <EyeOutlined />) : batchButton('unread', t.threads.markUnread, <EyeInvisibleOutlined />)}
            {anyUnstarred
              ? batchButton('star', t.threads.star, <StarOutlined />)
              : batchButton('unstar', t.threads.unstar, <StarFilled style={{ color: token.colorWarning }} />)}
            <Tooltip title={t.threads.deselectEsc}>
              <Button type="text" size="small" icon={<CloseOutlined />} aria-label={t.threads.deselect} onClick={() => setChecked(new Set())} />
            </Tooltip>
          </Flex>
        </>
      ) : (
        <>
          <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, flex: 1, minWidth: 0 }}>
            {query.hasNextPage ? t.threads.loaded(items.length) : t.threads.total(items.length)}
            {items.length > 0 && ` · ${t.threads.dragHint}`}
          </Typography.Text>
          {filterable && (
            <Segmented
              size="small"
              value={unread ? 'unread' : 'all'}
              options={[
                { value: 'all', label: t.threads.filterAll },
                { value: 'unread', label: t.threads.filterUnread },
              ]}
              onChange={(v) => onUnreadOnly?.(v === 'unread')}
              style={{ flex: 'none' }}
            />
          )}
        </>
      )}
    </Flex>
  );

  return (
    <Flex vertical style={{ height: '100%' }}>
      {toolbar}
      <ThreadContextMenu target={menu} inTrash={inTrash} onClose={() => setMenu(null)} onOpen={onSelect} runBatch={(a, ids) => void runBatch(a, ids)} />
      <div ref={boxRef} className={`thread-list${dragging ? ' dragging' : ''}`} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {query.isPending ? (
          <Flex align="center" justify="center" style={{ height: '100%' }}>
            <Spin />
          </Flex>
        ) : query.isError ? (
          <Flex align="center" justify="center" style={{ height: '100%' }}>
            <Empty description={(query.error as Error).message} />
          </Flex>
        ) : items.length === 0 ? (
          <Flex align="center" justify="center" style={{ height: '100%' }}>
            <Empty
              description={
                unread ? (
                  t.threads.noUnread
                ) : q ? (
                  t.threads.noMatches
                ) : view === 'waiting' && !accountId && !folderId ? (
                  <>
                    {t.threads.noWaiting}
                    <Typography.Paragraph type="secondary" style={{ fontSize: 12, maxWidth: 320, margin: '8px auto 0' }}>
                      {t.threads.waitingHelp}
                    </Typography.Paragraph>
                  </>
                ) : (
                  t.threads.empty
                )
              }
            />
          </Flex>
        ) : (
          height > 0 && (
            <Listy<ThreadSummary>
              ref={listRef}
              key={listKey}
              virtual
              height={height}
              items={items}
              rowKey="threadId"
              classNames={{ item: 'thread-row' }}
              itemRender={renderItem}
              onScroll={onScroll}
            />
          )
        )}
      </div>
    </Flex>
  );
}
