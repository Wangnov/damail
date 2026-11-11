import { DeleteOutlined, EditOutlined, FolderOutlined, KeyOutlined, PlusOutlined, SignatureOutlined, SyncOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Drawer, Flex, Popconfirm, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { SignatureModal } from '../../components/SignatureModal';
import { useSearchParams } from 'react-router';
import { api, type Account, type AccountSummary, type Folder } from '../../api';
import { useAccounts, useFolders } from '../../hooks/data';
import { folderLabel, fromNow, sortFolders } from '../../lib/format';
import { AccountForm, minutes, useSyncDefaults } from './AccountForm';
import { oauthProviderOf, startOAuth, useOAuthChannel } from './OAuth';
import { TableFill } from '../../components/TableFill';
import { t } from '../../i18n';

const STATUS_COLOR: Record<AccountSummary['status'], string> = {
  idle: 'success',
  syncing: 'processing',
  connecting: 'warning',
  error: 'error',
  disabled: 'default',
};

// 窄列的表头不折行
const noWrap = () => ({ style: { whiteSpace: 'nowrap' as const } });

function FoldersDrawer({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const folders = useFolders();
  const list = sortFolders((folders.data ?? []).filter((f) => f.accountId === account?.id));

  const toggle = async (f: Folder, syncEnabled: boolean) => {
    try {
      await api(`/api/admin/folders/${f.id}`, { method: 'PATCH', body: { syncEnabled } });
      await qc.invalidateQueries({ queryKey: ['folders'] });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <Drawer open={!!account} onClose={onClose} title={t.accounts.foldersTitle(account?.email ?? '')} size={480}>
      <Typography.Paragraph type="secondary">{t.accounts.foldersHint}</Typography.Paragraph>
      <Table<Folder>
        rowKey="id"
        bordered
        size="small"
        pagination={false}
        dataSource={list}
        columns={[
          { title: t.accounts.folder, render: (_, f) => folderLabel(f), ellipsis: true },
          { title: t.accounts.messageCount, dataIndex: 'totalCount', width: 80 },
          {
            title: t.accounts.sync,
            width: 70,
            render: (_, f) => <Switch size="small" checked={f.syncEnabled} onChange={(v) => toggle(f, v)} />,
          },
        ]}
      />
    </Drawer>
  );
}

export function AccountsPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const summaries = useAccounts();
  const accounts = useQuery({ queryKey: ['admin-accounts'], queryFn: () => api<Account[]>('/api/admin/accounts') });
  const defaultPoll = useSyncDefaults().data?.pollIntervalSec;
  const [editing, setEditing] = useState<Account | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [foldersOf, setFoldersOf] = useState<Account | null>(null);
  const [signatureOf, setSignatureOf] = useState<Account | null>(null);

  // 授权在新标签页完成，结果页把结果传回来（详情已在结果页显示，这里只提示一下）
  useOAuthChannel({
    onResult: (r) => {
      if (!r.ok) return void message.error(t.accounts.authFailed(r.error));
      message.success(t.accounts.connected(r.email));
      setFormOpen(false);
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['admin-accounts'] });
    },
  });

  useEffect(() => {
    if (params.get('add')) {
      setEditing(null);
      setFormOpen(true);
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  // 状态以 /v1/accounts 为准（SSE 会刷新它）
  const statusOf = (id: number) => summaries.data?.find((s) => s.id === id);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['accounts'] }), qc.invalidateQueries({ queryKey: ['admin-accounts'] })]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) message.success(ok);
      await refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <Flex align="center" justify="space-between" style={{ marginBottom: 16 }} gap={16} wrap>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t.accounts.title}
          </Typography.Title>
          <Typography.Text type="secondary">{t.accounts.desc}</Typography.Text>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          {t.accounts.add}
        </Button>
      </Flex>
      <TableFill>
        {(y) => (
          <Table<Account>
            rowKey="id"
            bordered
            loading={accounts.isPending}
            dataSource={accounts.data}
            pagination={false}
            scroll={{ x: 1028, y }}
            columns={[
              {
                title: t.accounts.account,
                minWidth: 170,
                render: (_, a) => (
                  <Flex vertical>
                    <Typography.Text strong>{a.name}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {a.email}
                      {a.authType === 'oauth2' && (
                        <Tag color="blue" style={{ marginInlineStart: 6, fontSize: 11 }}>
                          OAuth
                        </Tag>
                      )}
                    </Typography.Text>
                  </Flex>
                ),
              },
              {
                title: t.accounts.server,
                dataIndex: 'imapHost',
                width: 180,
                render: (h, a) => (a.protocol === 'graph' ? 'Microsoft Graph API' : `${h}:${a.imapPort}`),
                ellipsis: true,
                responsive: ['lg'],
              },
              {
                title: t.accounts.status,
                width: 100,
                render: (_, a) => {
                  const s = statusOf(a.id);
                  const status = s?.status ?? a.status;
                  const tag = (
                    <Tag color={STATUS_COLOR[status]} icon={s?.status === 'syncing' ? <SyncOutlined spin /> : undefined}>
                      {t.layout.accountStatus[status]}
                    </Tag>
                  );
                  const err = s?.lastError ?? a.lastError;
                  return err ? <Tooltip title={err}>{tag}</Tooltip> : tag;
                },
              },
              { title: t.accounts.messageCount, width: 90, onHeaderCell: noWrap, render: (_, a) => statusOf(a.id)?.messageCount ?? '—' },
              { title: t.accounts.lastSync, width: 110, onHeaderCell: noWrap, render: (_, a) => fromNow(statusOf(a.id)?.lastSyncAt ?? a.lastSyncAt) },
              {
                title: t.accounts.pollInterval,
                width: 100,
                render: (_, a) => {
                  // 没单独设置就用服务器默认值；收件箱实时推送（Graph 每分钟检查），这个间隔管其他文件夹
                  const sec = a.pollIntervalSec ?? defaultPoll;
                  if (!sec) return '—';
                  return (
                    <Tooltip title={a.protocol === 'graph' ? t.accountForm.pollTipGraph : t.accountForm.pollTip}>
                      <Flex vertical>
                        <span>{minutes(sec)}</span>
                        {!a.pollIntervalSec && (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {t.accounts.pollDefault}
                          </Typography.Text>
                        )}
                      </Flex>
                    </Tooltip>
                  );
                },
              },
              {
                title: t.accounts.enabled,
                width: 70,
                render: (_, a) => (
                  <Switch
                    size="small"
                    checked={a.enabled}
                    onChange={(enabled) => run(() => api(`/api/admin/accounts/${a.id}`, { method: 'PATCH', body: { enabled } }))}
                  />
                ),
              },
              {
                title: t.accounts.actions,
                // OAuth 邮箱多一个「重新授权」，6 个按钮
                width: 208,
                fixed: 'end',
                render: (_, a) => (
                  <Space size={0}>
                    <Tooltip title={t.accounts.syncNow}>
                      <Button
                        type="text"
                        icon={<SyncOutlined />}
                        disabled={!a.enabled}
                        onClick={() => run(() => api(`/api/admin/accounts/${a.id}/sync`, { method: 'POST' }), t.accounts.syncStarted)}
                      />
                    </Tooltip>
                    {a.authType === 'oauth2' && (
                      <Tooltip title={t.accounts.reauthorize}>
                        <Button type="text" icon={<KeyOutlined />} onClick={() => startOAuth(oauthProviderOf(a), a.id)} aria-label={t.accounts.reauthorize} />
                      </Tooltip>
                    )}
                    <Tooltip title={t.accounts.syncFolders}>
                      <Button type="text" icon={<FolderOutlined />} onClick={() => setFoldersOf(a)} />
                    </Tooltip>
                    <Tooltip title={a.signatureHtml ? t.compose.editSignature : t.compose.addSignature}>
                      <Button
                        type="text"
                        icon={<SignatureOutlined />}
                        aria-label={a.signatureHtml ? t.compose.editSignature : t.compose.addSignature}
                        onClick={() => setSignatureOf(a)}
                      />
                    </Tooltip>
                    <Tooltip title={t.common.edit}>
                      <Button
                        type="text"
                        icon={<EditOutlined />}
                        onClick={() => {
                          setEditing(a);
                          setFormOpen(true);
                        }}
                      />
                    </Tooltip>
                    <Popconfirm
                      title={t.accounts.deleteTitle}
                      description={t.accounts.deleteDesc}
                      okText={t.common.delete}
                      okButtonProps={{ danger: true }}
                      onConfirm={() => run(() => api(`/api/admin/accounts/${a.id}`, { method: 'DELETE' }), t.common.deleted)}
                    >
                      <Button type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        )}
      </TableFill>
      <AccountForm open={formOpen} account={editing} onClose={() => setFormOpen(false)} />
      <FoldersDrawer account={foldersOf} onClose={() => setFoldersOf(null)} />
      <SignatureModal account={signatureOf} open={!!signatureOf} onClose={() => setSignatureOf(null)} />
    </div>
  );
}
