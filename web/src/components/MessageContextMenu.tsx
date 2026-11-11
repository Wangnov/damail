import {
  ColumnHeightOutlined,
  ContainerOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  RollbackOutlined,
  SearchOutlined,
  ShareAltOutlined,
  StarFilled,
  StarOutlined,
  TeamOutlined,
  VerticalAlignMiddleOutlined,
} from '@ant-design/icons';
import { App, theme, type MenuProps } from 'antd';
import { useNavigate } from 'react-router';
import type { BatchAction, MessageDetail } from '../api';
import { t } from '../i18n';
import { useCompose } from './Compose';
import { ContextMenu } from './ContextMenu';

export type MessageMenuTarget = { x: number; y: number; message: MessageDetail };

const isInbox = (m: MessageDetail) => m.folderSpecialUse === '\\Inbox' || m.folder.toUpperCase() === 'INBOX';

/**
 * 会话详情里单封邮件的右键菜单（在邮件头部右键）。只处理这一封邮件；
 * 会话只有这一封时，归档 / 删除后和顶栏按钮一样离开这个会话。
 */
export function MessageContextMenu({
  target,
  onClose,
  inTrash,
  count,
  allExpanded,
  onExpandAll,
  act,
  onPurge,
}: {
  target: MessageMenuTarget | null;
  onClose: () => void;
  inTrash?: boolean;
  count: number;
  allExpanded: boolean;
  onExpandAll: (open: boolean) => void;
  act: (action: BatchAction, ids: number[], done?: string) => Promise<boolean>;
  onPurge: (m: MessageDetail) => void;
}) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const compose = useCompose();
  const navigate = useNavigate();
  if (!target) return null;
  const m = target.message;
  const address = m.from.address;
  const trashed = m.folderSpecialUse === '\\Trash';

  const items: MenuProps['items'] = [
    { key: 'reply', label: t.reader.reply, icon: <RollbackOutlined /> },
    { key: 'replyAll', label: t.reader.replyAll, icon: <TeamOutlined /> },
    { key: 'forward', label: t.reader.forward, icon: <ShareAltOutlined /> },
    { type: 'divider' },
    m.seen ? { key: 'unread', label: t.threads.markUnread, icon: <EyeInvisibleOutlined /> } : { key: 'read', label: t.threads.markRead, icon: <EyeOutlined /> },
    m.flagged
      ? { key: 'unstar', label: t.threads.unstar, icon: <StarFilled style={{ color: token.colorWarning }} /> }
      : { key: 'star', label: t.threads.star, icon: <StarOutlined /> },
    ...(count > 1
      ? [
          allExpanded
            ? { key: 'collapseAll', label: t.reader.ctx.collapseAll, icon: <VerticalAlignMiddleOutlined /> }
            : { key: 'expandAll', label: t.reader.ctx.expandAll, icon: <ColumnHeightOutlined /> },
        ]
      : []),
    ...(address
      ? [
          { type: 'divider' as const },
          { key: 'sender', label: t.threads.ctx.fromSender, icon: <SearchOutlined /> },
          { key: 'copy', label: t.threads.ctx.copyAddress, icon: <CopyOutlined /> },
        ]
      : []),
    { key: 'raw', label: t.reader.downloadEml, icon: <DownloadOutlined /> },
    { type: 'divider' },
    ...(isInbox(m) ? [{ key: 'archive', label: t.reader.archive, icon: <ContainerOutlined /> }] : []),
    trashed || inTrash
      ? { key: 'delete', label: t.reader.deleteForever, icon: <DeleteOutlined />, danger: true }
      : { key: 'trash', label: t.threads.ctx.trashOne, icon: <DeleteOutlined /> },
  ];

  // 只影响这一封、不离开会话的操作：成功后自己提示
  const quiet = async (action: BatchAction, done: string) => {
    if (await act(action, [m.id])) message.success(done);
  };
  // 归档 / 删除：会话只剩这一封时和顶栏按钮一样离开会话
  const remove = async (action: 'archive' | 'trash', done: string) => {
    if (count === 1) await act(action, [m.id], done);
    else await quiet(action, done);
  };

  const onClick = (key: string) => {
    if (key === 'reply' || key === 'replyAll' || key === 'forward') return compose({ mode: key, sourceMessageId: m.id });
    if (key === 'read') return void quiet('read', t.reader.ctx.markedRead);
    if (key === 'unread') return void quiet('unread', t.reader.markedUnread);
    if (key === 'star') return void quiet('star', t.reader.ctx.starred);
    if (key === 'unstar') return void quiet('unstar', t.reader.ctx.unstarred);
    if (key === 'expandAll' || key === 'collapseAll') return onExpandAll(key === 'expandAll');
    if (key === 'archive') return void remove('archive', t.reader.archived);
    if (key === 'trash') return void remove('trash', t.reader.trashed);
    if (key === 'delete') return onPurge(m);
    if (key === 'raw') {
      // 和顶栏的下载按钮一样走链接下载，不离开页面
      const a = document.createElement('a');
      a.href = `/api/v1/messages/${m.id}/raw`;
      a.download = '';
      a.click();
      return;
    }
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
