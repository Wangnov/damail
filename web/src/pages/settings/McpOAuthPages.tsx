import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Checkbox, Flex, Form, Input, InputNumber, Modal, Popconfirm, Radio, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { api, type McpAuthorization, type McpOAuthClient, type McpOAuthClientDoc, type McpOAuthInfo, type McpOAuthSettings } from '../../api';
import { ProxyField } from '../../components/ProxyField';
import { SettingsPage } from '../../components/SettingsPage';
import { TagList } from '../../components/TagList';
import { TableFill } from '../../components/TableFill';
import { fromNow } from '../../lib/format';
import { horizontalForm, tip } from '../../lib/form';
import { t } from '../../i18n';

const SCOPE_COLOR: Record<string, string> = { 'mail:organize': 'blue', 'mail:draft': 'gold', 'mail:send': 'red' };

type SettingsValues = { enabled: boolean; proxyId: number | null; sendLimitPerHour: number; scopeChallenge: 'http' | 'tool' };

/** 添加客户端：CIMD 填 client_id URL 后读取文档、勾选回调地址；预注册客户端手动填写 */
function AddClientModal({
  open,
  proxyId,
  existing,
  onCancel,
  onAdd,
}: {
  open: boolean;
  proxyId: number | null;
  existing: string[];
  onCancel: () => void;
  onAdd: (c: McpOAuthClient) => void;
}) {
  const { message } = App.useApp();
  const [type, setType] = useState<'cimd' | 'static'>('cimd');
  const [clientId, setClientId] = useState('');
  const [doc, setDoc] = useState<McpOAuthClientDoc | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [redirects, setRedirects] = useState('');

  useEffect(() => {
    if (!open) {
      setType('cimd');
      setClientId('');
      setDoc(null);
      setPicked([]);
      setName('');
      setRedirects('');
    }
  }, [open]);

  const inspect = async () => {
    setLoading(true);
    setDoc(null);
    try {
      const d = await api<McpOAuthClientDoc>('/api/admin/mcp-oauth/inspect-client', { method: 'POST', body: { clientId: clientId.trim(), proxyId } });
      setDoc(d);
      // 文档只声明了一个回调时默认勾选；多个时让用户对照客户端页面上显示的地址选择
      setPicked(d.redirectUris.length === 1 ? d.redirectUris : []);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const id = clientId.trim();
  const duplicate = existing.includes(id);
  const staticRedirects = redirects
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const canAdd =
    !duplicate && (type === 'cimd' ? Boolean(doc && doc.clientId === id && !doc.problems.length && picked.length) : Boolean(id && staticRedirects.length));

  const add = () =>
    onAdd(
      type === 'cimd'
        ? { type, clientId: id, name: doc?.clientName ?? null, redirectUris: picked }
        : { type, clientId: id, name: name.trim() || null, redirectUris: staticRedirects },
    );

  return (
    <Modal
      open={open}
      title={t.mcpOAuth.addClient}
      onCancel={onCancel}
      onOk={add}
      okText={t.accountForm.add}
      okButtonProps={{ disabled: !canAdd }}
      width={640}
      destroyOnHidden
    >
      <Flex vertical gap={16} style={{ marginTop: 16 }}>
        <Radio.Group
          optionType="button"
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setDoc(null);
          }}
          options={[
            { value: 'cimd', label: t.mcpOAuth.cimd },
            { value: 'static', label: t.mcpOAuth.static },
          ]}
        />
        {type === 'cimd' ? (
          <>
            <Typography.Text type="secondary">{t.mcpOAuth.cimdHint}</Typography.Text>
            <Flex gap={8}>
              <Input
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  setDoc(null);
                }}
                onPressEnter={() => id && void inspect()}
                placeholder="https://chatgpt.com/oauth/client.json"
                autoComplete="off"
                spellCheck={false}
              />
              <Button onClick={inspect} loading={loading} disabled={!id}>
                {t.mcpOAuth.fetch}
              </Button>
            </Flex>
            {duplicate && <Alert type="warning" showIcon title={t.mcpOAuth.duplicate} />}
            {doc && (
              <Flex vertical gap={12}>
                {doc.problems.length > 0 && <Alert type="error" showIcon title={t.mcpOAuth.unusable} description={doc.problems.join(t.mcpOAuth.problemSep)} />}
                <div>
                  {t.mcpOAuth.nameLabel}
                  <Typography.Text strong>{doc.clientName ?? t.mcpOAuth.undeclared}</Typography.Text>
                  {doc.authMethod && (
                    <Typography.Text type="secondary" style={{ marginInlineStart: 12 }}>
                      {t.mcpOAuth.authMethod(doc.authMethod)}
                    </Typography.Text>
                  )}
                </div>
                <div>
                  <div style={{ marginBottom: 6 }}>{t.mcpOAuth.pickRedirects}</div>
                  <Checkbox.Group
                    value={picked}
                    onChange={(v) => setPicked(v as string[])}
                    style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                    options={doc.redirectUris.map((u) => ({
                      value: u,
                      label: (
                        <Typography.Text code style={{ wordBreak: 'break-all' }}>
                          {u}
                        </Typography.Text>
                      ),
                    }))}
                  />
                </div>
              </Flex>
            )}
          </>
        ) : (
          <Form layout="vertical" requiredMark={false}>
            <Form.Item label="Client ID" help={t.mcpOAuth.clientIdHelp}>
              <Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={t.mcpOAuth.clientIdPlaceholder} autoComplete="off" />
            </Form.Item>
            <Form.Item label={t.mcpOAuth.name}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.mcpOAuth.namePlaceholder} />
            </Form.Item>
            <Form.Item label={t.mcpOAuth.redirects} help={t.mcpOAuth.redirectsHelp}>
              <Input.TextArea value={redirects} onChange={(e) => setRedirects(e.target.value)} autoSize={{ minRows: 2, maxRows: 5 }} spellCheck={false} />
            </Form.Item>
          </Form>
        )}
      </Flex>
    </Modal>
  );
}

/** OAuth 设置：开关、允许的客户端、抓取代理、发信上限；保存后立即生效 */
function SettingsPanel({ info }: { info: McpOAuthInfo }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<SettingsValues>();
  const [clients, setClients] = useState<McpOAuthClient[]>(info.settings.clients);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const proxyId = Form.useWatch('proxyId', form) ?? null;
  const enabled = Form.useWatch('enabled', form);

  useEffect(() => {
    const s = info.settings;
    form.setFieldsValue({ enabled: s.enabled, proxyId: s.fetchProxyId, sendLimitPerHour: s.sendLimitPerHour, scopeChallenge: s.scopeChallenge });
    setClients(s.clients);
    setDirty(false);
  }, [info.settings, form]);

  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const body: McpOAuthSettings = {
        enabled: v.enabled,
        clients,
        fetchProxyId: v.proxyId ?? null,
        sendLimitPerHour: v.sendLimitPerHour,
        scopeChallenge: v.scopeChallenge,
      };
      await api('/api/admin/mcp-oauth/settings', { method: 'PUT', body });
      await qc.invalidateQueries({ queryKey: ['mcp-oauth'] });
      message.success(t.mcpOAuth.savedLive);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const changeClients = (next: McpOAuthClient[]) => {
    setClients(next);
    setDirty(true);
  };

  return (
    <Form form={form} {...horizontalForm(120)} requiredMark={false} onValuesChange={() => setDirty(true)} style={{ maxWidth: 960 }}>
      {info.settings.source === 'env' && (
        <Alert type="info" showIcon style={{ marginBottom: 16 }} title={t.mcpOAuth.envTitle} description={t.mcpOAuth.envDesc} />
      )}
      <Form.Item name="enabled" label={t.mcpOAuth.enabled} valuePropName="checked" tooltip={tip(t.mcpOAuth.enabledTip)}>
        <Switch />
      </Form.Item>
      <Form.Item label={t.mcpOAuth.mcpUrl}>
        <Typography.Text copyable code>
          {info.resource}
        </Typography.Text>
      </Form.Item>
      <Form.Item label={t.mcpOAuth.clients} tooltip={tip(t.mcpOAuth.clientsTip)}>
        <Flex vertical gap={8}>
          {enabled && clients.length === 0 && <Alert type="warning" showIcon title={t.mcpOAuth.noClients} />}
          {clients.length > 0 && (
            <Table<McpOAuthClient>
              rowKey="clientId"
              size="small"
              bordered
              pagination={false}
              dataSource={clients}
              scroll={{ x: 560 }}
              columns={[
                {
                  title: t.mcpOAuth.client,
                  dataIndex: 'clientId',
                  render: (id: string, c) => (
                    <Flex vertical gap={2}>
                      <span>
                        {c.name || (c.type === 'cimd' ? new URL(id).host : id)}
                        <Tag style={{ marginInlineStart: 8 }}>{c.type === 'cimd' ? t.mcpOAuth.cimdTag : t.mcpOAuth.staticTag}</Tag>
                      </span>
                      <Typography.Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                        {id}
                      </Typography.Text>
                    </Flex>
                  ),
                },
                {
                  title: t.mcpOAuth.redirects,
                  dataIndex: 'redirectUris',
                  render: (u: string[]) => (
                    <Flex vertical gap={2}>
                      {u.map((x) => (
                        <Typography.Text key={x} style={{ fontSize: 12, wordBreak: 'break-all' }}>
                          {x}
                        </Typography.Text>
                      ))}
                    </Flex>
                  ),
                },
                {
                  title: '',
                  width: 56,
                  render: (_, c) => (
                    <Popconfirm
                      title={t.mcpOAuth.deleteClient}
                      description={t.mcpOAuth.deleteClientDesc}
                      okText={t.common.delete}
                      okButtonProps={{ danger: true }}
                      onConfirm={() => changeClients(clients.filter((x) => x.clientId !== c.clientId))}
                    >
                      <Button type="text" danger icon={<DeleteOutlined />} aria-label={t.common.delete} />
                    </Popconfirm>
                  ),
                },
              ]}
            />
          )}
          <div>
            <Button icon={<PlusOutlined />} onClick={() => setAdding(true)}>
              {t.mcpOAuth.addClient}
            </Button>
          </div>
        </Flex>
      </Form.Item>
      <ProxyField help={t.mcpOAuth.proxyHelp} />
      <Form.Item
        name="sendLimitPerHour"
        label={t.mcpOAuth.sendLimit}
        tooltip={tip(t.mcpOAuth.sendLimitTip)}
        rules={[{ required: true, message: t.mcpOAuth.required }]}
      >
        <InputNumber min={0} max={1000} precision={0} suffix={t.mcpOAuth.perHour} style={{ width: 180 }} />
      </Form.Item>
      <Form.Item name="scopeChallenge" label={t.mcpOAuth.challenge} tooltip={tip(t.mcpOAuth.challengeTip)}>
        <Radio.Group
          options={[
            { value: 'http', label: t.mcpOAuth.challengeHttp },
            { value: 'tool', label: t.mcpOAuth.challengeTool },
          ]}
        />
      </Form.Item>
      <Flex justify="flex-end" align="center" gap={12}>
        {dirty && <Typography.Text type="secondary">{t.mcpOAuth.unsaved}</Typography.Text>}
        <Button type="primary" loading={saving} onClick={save}>
          {t.common.save}
        </Button>
      </Flex>
      <AddClientModal
        open={adding}
        proxyId={proxyId}
        existing={clients.map((c) => c.clientId)}
        onCancel={() => setAdding(false)}
        onAdd={(c) => {
          changeClients([...clients, c]);
          setAdding(false);
        }}
      />
    </Form>
  );
}

/** OAuth 设置：ChatGPT 等客户端通过登录授权接入 MCP */
export function McpOAuthSettingsPage() {
  const info = useQuery({ queryKey: ['mcp-oauth'], queryFn: () => api<McpOAuthInfo>('/api/admin/mcp-oauth') });
  return (
    <SettingsPage title={t.mcpOAuth.settingsTitle} description={t.mcpOAuth.settingsDesc}>
      {info.data ? (
        <SettingsPanel info={info.data} />
      ) : (
        <Typography.Text type="secondary">{info.isPending ? t.openApi.loading : t.openApi.loadFailed}</Typography.Text>
      )}
    </SettingsPage>
  );
}

/** OAuth 授权：查看每个应用的权限和邮箱范围，随时撤销 */
export function McpAuthorizationsPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ['mcp-oauth'], queryFn: () => api<McpOAuthInfo>('/api/admin/mcp-oauth') });
  const list = useQuery({ queryKey: ['mcp-authorizations'], queryFn: () => api<McpAuthorization[]>('/api/admin/mcp-authorizations') });
  const label = (s: string) => info.data?.scopes.find((x) => x.name === s)?.label ?? s;

  async function revoke(id: number) {
    try {
      await api(`/api/admin/mcp-authorizations/${id}`, { method: 'DELETE' });
      message.success(t.mcpOAuth.revokedToast);
      await qc.invalidateQueries({ queryKey: ['mcp-authorizations'] });
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  return (
    <SettingsPage fill title={t.mcpOAuth.grantsTitle} description={t.mcpOAuth.grantsDesc}>
      <TableFill>
        {(y) => (
          <Table<McpAuthorization>
            rowKey="id"
            bordered
            loading={list.isPending}
            dataSource={list.data}
            pagination={false}
            scroll={{ x: 720, y }}
            locale={{ emptyText: t.mcpOAuth.grantsEmpty }}
            columns={[
              {
                title: t.mcpOAuth.app,
                dataIndex: 'clientName',
                minWidth: 160,
                render: (name: string | null, r) => (
                  <Tooltip title={r.clientId}>
                    <span>{name || r.clientId}</span>
                  </Tooltip>
                ),
              },
              {
                title: t.mcpOAuth.scopes,
                dataIndex: 'scopes',
                render: (s: string[]) => (
                  <TagList>
                    {s.map((x) => (
                      <Tag key={x} color={SCOPE_COLOR[x]}>
                        {label(x)}
                      </Tag>
                    ))}
                  </TagList>
                ),
              },
              {
                title: t.mcpOAuth.accounts,
                dataIndex: 'accounts',
                render: (a: McpAuthorization['accounts']) =>
                  a ? (
                    <TagList>
                      {a.map((x) => (
                        <Tag key={x.id}>{x.email ?? `#${x.id}`}</Tag>
                      ))}
                    </TagList>
                  ) : (
                    <Tag color="blue">{t.openApi.all}</Tag>
                  ),
              },
              { title: t.mcpOAuth.createdAt, dataIndex: 'createdAt', render: fromNow },
              { title: t.openApi.lastUsed, dataIndex: 'lastUsedAt', render: fromNow },
              {
                title: '',
                width: 120,
                render: (_, r) =>
                  r.revokedAt ? (
                    <Typography.Text type="secondary">{t.mcpOAuth.revokeReason[r.revokeReason ?? ''] ?? t.mcpOAuth.revoked}</Typography.Text>
                  ) : (
                    <Popconfirm
                      title={t.mcpOAuth.revokeTitle}
                      description={t.mcpOAuth.revokeDesc}
                      okText={t.mcpOAuth.revoke}
                      okButtonProps={{ danger: true }}
                      onConfirm={() => revoke(r.id)}
                    >
                      <Button type="text" danger icon={<DeleteOutlined />}>
                        {t.mcpOAuth.revoke}
                      </Button>
                    </Popconfirm>
                  ),
              },
            ]}
          />
        )}
      </TableFill>
    </SettingsPage>
  );
}
