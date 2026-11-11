import { CheckOutlined, CopyOutlined, DeleteOutlined, PlusOutlined, SyncOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Checkbox, Flex, Form, Input, Modal, Popconfirm, Table, Tag, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { api, type ApiKey } from '../../api';
import { useAccounts } from '../../hooks/data';
import { fromNow } from '../../lib/format';
import { tip } from '../../lib/form';
import { AccountScope, accountScopeRule } from '../../components/AccountScope';
import { SettingsPage } from '../../components/SettingsPage';
import { TagList } from '../../components/TagList';
import { TableFill } from '../../components/TableFill';
import { SCOPE_COLOR, scopeLabel, Snippet, snippets } from './McpConnectPage';
import { t } from '../../i18n';

// 列表只显示前缀，复制时才向服务器取完整密钥
function KeyCell({ apiKey }: { apiKey: ApiKey }) {
  const { message } = App.useApp();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      const { key } = await api<{ key: string }>(`/api/admin/api-keys/${apiKey.id}/secret`);
      await navigator.clipboard.writeText(key);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  return (
    <Flex align="center" gap={4}>
      <Typography.Text code>{apiKey.prefix}…</Typography.Text>
      <Tooltip title={apiKey.copyable ? (copied ? t.openApi.copied : t.openApi.copyFull) : t.openApi.notCopyable}>
        <Button
          type="text"
          size="small"
          aria-label={t.openApi.copyKey}
          disabled={!apiKey.copyable}
          icon={copied ? <CheckOutlined style={{ color: 'var(--ant-color-success)' }} /> : <CopyOutlined />}
          onClick={copy}
        />
      </Tooltip>
    </Flex>
  );
}

export function ApiKeysPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const accounts = useAccounts();
  const keys = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api<ApiKey[]>('/api/admin/api-keys'),
  });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{
    name: string;
    key: string;
    rotated?: boolean;
  } | null>(null);
  const [form] = Form.useForm<{
    name: string;
    scopes: string[];
    accountIds?: number[] | null;
  }>();

  const create = async () => {
    const values = await form.validateFields();
    try {
      const res = await api<{ name: string; key: string }>('/api/admin/api-keys', { method: 'POST', body: values });
      setCreating(false);
      form.resetFields();
      setCreated(res);
      await qc.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const revoke = async (id: number) => {
    await api(`/api/admin/api-keys/${id}`, { method: 'DELETE' });
    message.success(t.openApi.revoked);
    await qc.invalidateQueries({ queryKey: ['api-keys'] });
  };

  const rotate = async (id: number) => {
    try {
      const res = await api<{ name: string; key: string }>(`/api/admin/api-keys/${id}/rotate`, { method: 'POST' });
      setCreated({ ...res, rotated: true });
      await qc.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const accountName = (id: number) => accounts.data?.find((a) => a.id === id)?.name ?? `#${id}`;

  return (
    <SettingsPage
      fill
      title="API Key"
      description={t.openApi.keysDesc}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
          {t.openApi.createKey}
        </Button>
      }
    >
      <TableFill>
        {(y) => (
          <Table<ApiKey>
            rowKey="id"
            bordered
            loading={keys.isPending}
            dataSource={keys.data}
            pagination={false}
            scroll={{ x: 720, y }}
            columns={[
              { title: t.openApi.name, dataIndex: 'name', minWidth: 140 },
              {
                title: t.openApi.key,
                dataIndex: 'prefix',
                render: (_, k) => <KeyCell apiKey={k} />,
              },
              {
                title: t.openApi.scope,
                dataIndex: 'scopes',
                render: (s: string[]) => (
                  <TagList>
                    {s.map((x) => (
                      <Tag key={x} color={SCOPE_COLOR[x]}>
                        {scopeLabel(x)}
                      </Tag>
                    ))}
                  </TagList>
                ),
              },
              {
                title: t.openApi.accounts,
                dataIndex: 'accountIds',
                render: (ids: number[] | null) =>
                  ids ? (
                    <TagList>
                      {ids.map((id) => (
                        <Tag key={id}>{accountName(id)}</Tag>
                      ))}
                    </TagList>
                  ) : (
                    <Tag color="blue">{t.openApi.all}</Tag>
                  ),
              },
              { title: t.openApi.lastUsed, dataIndex: 'lastUsedAt', render: fromNow },
              {
                title: '',
                width: 96,
                render: (_, k) => (
                  <Flex>
                    <Popconfirm title={t.openApi.rotateTitle} description={t.openApi.rotateDesc} okText={t.openApi.rotateOk} onConfirm={() => rotate(k.id)}>
                      <Tooltip title={t.openApi.rotate}>
                        <Button type="text" aria-label={t.openApi.rotate} icon={<SyncOutlined />} />
                      </Tooltip>
                    </Popconfirm>
                    <Popconfirm title={t.openApi.revokeTitle} okText={t.openApi.revoke} okButtonProps={{ danger: true }} onConfirm={() => revoke(k.id)}>
                      <Tooltip title={t.openApi.revoke}>
                        <Button type="text" danger aria-label={t.openApi.revoke} icon={<DeleteOutlined />} />
                      </Tooltip>
                    </Popconfirm>
                  </Flex>
                ),
              },
            ]}
          />
        )}
      </TableFill>

      <Modal
        open={creating}
        title={t.openApi.createKey}
        onCancel={() => setCreating(false)}
        onOk={create}
        okText={t.openApi.create}
        width={680}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" requiredMark={false} initialValues={{ scopes: [] }} style={{ marginTop: 16 }}>
          <Form.Item name="name" label={t.openApi.name} rules={[{ required: true, message: t.openApi.nameRequired }]}>
            <Input placeholder={t.openApi.namePlaceholder} />
          </Form.Item>
          <Form.Item label={t.openApi.scope} tooltip={tip(t.openApi.scopeTip)}>
            {/* 一行三张；Checkbox.Group 用 display: contents，让它的卡片和「只读」排进同一个网格 */}
            <div className="scope-grid">
              {/* 只读是每个密钥都有的，放一张勾选且禁用的卡片说明这一点 */}
              <Tooltip title={t.openApi.readOnlyTip} mouseEnterDelay={0.4}>
                <div className="option-card scope-card scope-card-fixed">
                  <Checkbox checked disabled />
                  <span className="scope-card-text">
                    <span className="scope-card-title">{t.openApi.readOnly}</span>
                    <span className="scope-card-desc">{t.openApi.readOnlyShort}</span>
                  </span>
                </div>
              </Tooltip>
              <Form.Item name="scopes" noStyle>
                <Checkbox.Group style={{ display: 'contents' }}>
                  {t.openApi.scopes.map((s) => (
                    <Tooltip key={s.value} title={s.desc} mouseEnterDelay={0.4}>
                      <label className="option-card scope-card">
                        <Checkbox value={s.value} />
                        <span className="scope-card-text">
                          <span className="scope-card-title">{s.label}</span>
                          <span className="scope-card-desc">{s.short}</span>
                        </span>
                      </label>
                    </Tooltip>
                  ))}
                </Checkbox.Group>
              </Form.Item>
            </div>
          </Form.Item>
          <Form.Item name="accountIds" label={t.openApi.accountsLabel} rules={[accountScopeRule]} style={{ marginBottom: 8 }}>
            <AccountScope maxRows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={!!created}
        title={created?.rotated ? t.openApi.rotated : t.openApi.created}
        onCancel={() => setCreated(null)}
        footer={<Button onClick={() => setCreated(null)}>{t.openApi.savedIt}</Button>}
        width={640}
      >
        {created && (
          <>
            {created.rotated && <Alert type="warning" showIcon title={t.openApi.oldInvalid} style={{ marginBottom: 16 }} />}
            <Snippet title="API Key" code={created.key} />
            <Snippet title={t.openApi.claudeCodeOneLine} code={snippets(created.key).claudeCode} />
            <Snippet title={t.openApi.jsonConfig} code={snippets(created.key).json} />
          </>
        )}
      </Modal>
    </SettingsPage>
  );
}
