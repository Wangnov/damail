import {
  BellOutlined,
  CheckOutlined,
  ContainerOutlined,
  CopyOutlined,
  DeleteOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FolderOpenOutlined,
  RollbackOutlined,
  SearchOutlined,
  ShareAltOutlined,
  StarFilled,
  StarOutlined,
  TagOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { App, theme, type MenuProps } from 'antd';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router';
import { api, type ThreadBatchAction, type ThreadSummary } from '../api';
import { useLabels } from '../hooks/data';
import { t } from '../i18n';
import { formatSendAt } from '../lib/format';
import { useCompose } from './Compose';
import { ContextMenu } from './ContextMenu';
import { labelName } from './Labels';

export type ThreadMenuTarget = { x: number; y: number; threads: ThreadSummary[]; multi: boolean };

const FOLLOW_UP_PRESETS = ['1', '3', '7'] as const;

/**
 * 会话列表的右键菜单。multi 为 true 时是对已勾选的多个会话操作，只保留批量能做的项。
 * 已读 / 星标 / 归档 / 删除走列表现有的批量操作（runBatch），提示和刷新与顶栏按钮一致。
 */
export function ThreadContextMenu({
  target,
  inTrash,
  onClose,
  onOpen,
  runBatch,
}: {
  target: ThreadMenuTarget | null;
  inTrash?: boolean;
  onClose: () => void;
  onOpen: (threadId: string) => void;
  runBatch: (action: ThreadBatchAction, threadIds: string[]) => void;
}) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const compose = useCompose();
  const labels = useLabels();
  if (!target) return null;

  const { threads, multi } = target;
  const ids = threads.map((x) => x.threadId);
  const one = threads[0]!;
  const anyUnread = threads.some((x) => x.unread);
  const anyUnstarred = threads.some((x) => !x.flagged);
  const refresh = () => Promise.all(['threads', 'thread', 'stats', 'labels'].map((k) => qc.invalidateQueries({ queryKey: [k] })));

  // 标签：全部会话都有才打勾；点一下全部加上，再点全部去掉
  const labelItems: NonNullable<MenuProps['items']> = labels.data?.length
    ? labels.data.map((l) => {
        const all = threads.every((x) => x.labels.some((b) => b.id === l.id));
        return {
          key: `label:${l.id}`,
          label: labelName(l),
          icon: (
            <span className="ctx-label-icon">
              {all ? <CheckOutlined /> : <i style={{ background: (token as unknown as Record<string, string>)[l.color] ?? token.colorPrimary }} />}
            </span>
          ),
        };
      })
    : [{ key: 'labels:manage', label: t.threads.ctx.noLabels }];

  const waiting = !multi ? one.waiting : undefined;
  const followUpActive = waiting?.followUp?.status === 'open' || waiting?.followUp?.status === 'due';

  const items: MenuProps['items'] = [
    ...(multi ? [{ key: 'title', type: 'group' as const, label: t.threads.selected(threads.length) }] : []),
    ...(!multi
      ? [
          { key: 'open', label: t.threads.ctx.open, icon: <FolderOpenOutlined /> },
          { key: 'reply', label: t.reader.reply, icon: <RollbackOutlined /> },
          { key: 'replyAll', label: t.reader.replyAll, icon: <TeamOutlined /> },
          { key: 'forward', label: t.reader.forward, icon: <ShareAltOutlined /> },
          { type: 'divider' as const },
        ]
      : []),
    anyUnread
      ? { key: 'read', label: t.threads.markRead, icon: <EyeOutlined /> }
      : { key: 'unread', label: t.threads.markUnread, icon: <EyeInvisibleOutlined /> },
    anyUnstarred
      ? { key: 'star', label: t.threads.star, icon: <StarOutlined /> }
      : { key: 'unstar', label: t.threads.unstar, icon: <StarFilled style={{ color: token.colorWarning }} /> },
    { key: 'labels', label: t.threads.ctx.labels, icon: <TagOutlined />, children: labelItems },
    // 跟进提醒只针对自己发出、在等回复的邮件（「等回复」列表里的会话）
    ...(waiting
      ? [
          {
            key: 'followUp',
            label: t.threads.ctx.followUp,
            icon: <BellOutlined />,
            children: [
              ...FOLLOW_UP_PRESETS.map((d) => ({ key: `fu:${d}`, label: t.followUp.presets[d] })),
              { type: 'divider' as const },
              followUpActive ? { key: 'fu:clear', label: t.followUp.cancel } : { key: 'fu:done', label: t.followUp.noNeed },
            ],
          },
        ]
      : []),
    ...(!multi && one.from.address
      ? [
          { type: 'divider' as const },
          { key: 'sender', label: t.threads.ctx.fromSender, icon: <SearchOutlined /> },
          { key: 'copy', label: t.threads.ctx.copyAddress, icon: <CopyOutlined /> },
        ]
      : []),
    { type: 'divider' },
    { key: 'archive', label: t.threads.archive, icon: <ContainerOutlined /> },
    inTrash
      ? { key: 'delete', label: t.threads.deleteForever, icon: <DeleteOutlined />, danger: true }
      : { key: 'trash', label: t.threads.ctx.trashOne, icon: <DeleteOutlined /> },
  ];

  const setLabel = async (id: number) => {
    const l = labels.data?.find((x) => x.id === id);
    if (!l) return;
    const has = threads.every((x) => x.labels.some((b) => b.id === id));
    try {
      await api('/api/v1/threads/labels', { method: 'POST', body: { threadIds: ids, ...(has ? { remove: [id] } : { add: [id] }) } });
      message.success(has ? t.threads.ctx.labelRemoved(labelName(l), ids.length) : t.threads.ctx.labelAdded(labelName(l), ids.length));
      await refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const followUp = async (key: string) => {
    if (!waiting) return;
    const url = `/api/v1/messages/${waiting.messageId}/follow-up`;
    try {
      if (key === 'clear') {
        await api(url, { method: 'DELETE' });
        message.success(t.followUp.cancelled);
      } else if (key === 'done') {
        await api(url, { method: 'PUT', body: { done: true } });
        message.success(t.followUp.markedDone);
      } else {
        const at = dayjs().add(Number(key), 'day');
        await api(url, { method: 'PUT', body: { dueAt: at.toISOString() } });
        message.success(t.followUp.willRemind(formatSendAt(at.toDate())));
      }
      await refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const onClick = (key: string) => {
    if (key === 'open') return onOpen(one.threadId);
    if (key === 'reply' || key === 'replyAll' || key === 'forward') return compose({ mode: key, sourceMessageId: one.latestMessageId });
    if (['read', 'unread', 'star', 'unstar', 'archive', 'trash', 'delete'].includes(key)) return runBatch(key as ThreadBatchAction, ids);
    if (key === 'labels:manage') return navigate('/ai/labels');
    if (key.startsWith('label:')) return void setLabel(Number(key.slice(6)));
    if (key.startsWith('fu:')) return void followUp(key.slice(3));
    const address = one.from.address;
    if (!address) return;
    if (key === 'sender') return navigate(`/mail?view=all&q=${encodeURIComponent(`from:${address}`)}`);
    if (key === 'copy')
      return void navigator.clipboard.writeText(address).then(
        () => message.success(t.threads.ctx.copied(address)),
        (e: Error) => message.error(e.message),
      );
  };

  return <ContextMenu x={target.x} y={target.y} items={items} onClick={onClick} onClose={onClose} />;
}
