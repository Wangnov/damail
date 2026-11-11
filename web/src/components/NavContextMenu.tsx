import { CheckCircleOutlined, EditOutlined, EyeInvisibleOutlined, FilterOutlined, SettingOutlined, SyncOutlined, TagsOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { App, type MenuProps } from 'antd';
import { useNavigate } from 'react-router';
import { api, type Label } from '../api';
import { t } from '../i18n';
import { ContextMenu } from './ContextMenu';
import { labelName } from './Labels';

/** 侧栏某一项的右键菜单要用到的信息，由 AppLayout 按菜单项算好 */
export type NavMenuTarget = {
  x: number;
  y: number;
  name: string;
  // 左键点击去的地址；支持「全部 / 未读」筛选时可以「只看未读」
  url: string;
  unreadFilter: boolean;
  // 「全部标为已读」用的筛选条件（和会话列表一样）；unread 是已知的未读数，0 时不可点
  markRead?: { body: { view?: string; account?: number; folder?: number; q?: string }; unread?: number };
  label?: Label;
  category?: boolean;
  accountId?: number;
};

export function NavContextMenu({ target, onClose }: { target: NavMenuTarget | null; onClose: () => void }) {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  if (!target) return null;
  const c = t.layout.navCtx;
  const { markRead, label, accountId } = target;

  const items: NonNullable<MenuProps['items']> = [
    ...(target.unreadFilter ? [{ key: 'unread', label: c.onlyUnread, icon: <FilterOutlined /> }] : []),
    ...(markRead ? [{ key: 'markRead', label: c.markAllRead, icon: <CheckCircleOutlined />, disabled: markRead.unread === 0 }] : []),
  ];
  const more: NonNullable<MenuProps['items']> = [
    ...(label
      ? [
          { key: 'edit', label: c.editLabel, icon: <EditOutlined /> },
          { key: 'hide', label: c.hideLabel, icon: <EyeInvisibleOutlined /> },
        ]
      : []),
    ...(label || target.category ? [{ key: 'manage', label: c.manageLabels, icon: <TagsOutlined /> }] : []),
    ...(accountId
      ? [
          { key: 'sync', label: c.syncNow, icon: <SyncOutlined /> },
          { key: 'settings', label: c.mailboxSettings, icon: <SettingOutlined /> },
        ]
      : []),
  ];
  if (items.length && more.length) items.push({ type: 'divider' });
  items.push(...more);
  if (!items.length) return null;

  const refresh = () => Promise.all(['threads', 'thread', 'stats', 'labels', 'accounts', 'folders'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) message.success(ok);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const onClick = (key: string) => {
    if (key === 'unread') return navigate(`${target.url}${target.url.includes('?') ? '&' : '?'}filter=unread`);
    if (key === 'markRead' && markRead)
      return void modal.confirm({
        title: c.markAllReadTitle(target.name, markRead.unread),
        content: c.markAllReadContent,
        onOk: () =>
          run(async () => {
            const r = await api<{ updated: number }>('/api/v1/threads/mark-read', { method: 'POST', body: markRead.body });
            message.success(c.markedAllRead(r.updated));
            await refresh();
          }),
      });
    if (key === 'manage') return navigate('/ai/labels');
    if (key === 'edit' && label) return navigate(`/ai/labels?edit=${label.id}`);
    if (key === 'hide' && label)
      return void run(
        async () => {
          await api(`/api/admin/labels/${label.id}`, { method: 'PATCH', body: { pinned: false } });
          await refresh();
        },
        c.labelHidden(labelName(label)),
      );
    if (key === 'sync' && accountId) return void run(() => api(`/api/admin/accounts/${accountId}/sync`, { method: 'POST' }), c.syncStarted);
    if (key === 'settings') return navigate('/settings/accounts');
  };

  return <ContextMenu x={target.x} y={target.y} items={items} onClick={onClick} onClose={onClose} />;
}
