import { ApiOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Flex, Form, Input, InputNumber, Modal, Popconfirm, Select, Table, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { api, type ProxyItem, type ProxyProtocol, type ProxyTestResult } from '../../api';
import { TableFill } from '../../components/TableFill';
import { useProxies } from '../../hooks/data';
import { horizontalForm, tip } from '../../lib/form';
import { t } from '../../i18n';

const PROTOCOLS: { value: ProxyProtocol; label: string; port: number }[] = [
  { value: 'socks5', label: 'SOCKS5', port: 1080 },
  { value: 'http', label: 'HTTP', port: 8080 },
  { value: 'https', label: 'HTTPS', port: 443 },
  { value: 'socks4', label: 'SOCKS4', port: 1080 },
];

const DEFAULT_TARGET = 'imap.gmail.com:993';

type FormValues = { name: string; protocol: ProxyProtocol; host: string; port: number; username?: string; password?: string; target: string };

const address = (p: Pick<ProxyItem, 'protocol' | 'host' | 'port'>) => `${p.protocol}://${p.host.includes(':') ? `[${p.host}]` : p.host}:${p.port}`;

export function ProxiesPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const list = useProxies();
  const [editing, setEditing] = useState<ProxyItem | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<number | 'form' | null>(null);
  const [result, setResult] = useState<ProxyTestResult | null>(null);
  const [form] = Form.useForm<FormValues>();
  const current = editing && editing !== 'new' ? editing : null;

  const open = (p: ProxyItem | 'new') => {
    setEditing(p);
    setResult(null);
    form.resetFields();
    if (p === 'new') form.setFieldsValue({ protocol: 'socks5', port: 1080, target: DEFAULT_TARGET });
    else form.setFieldsValue({ ...p, username: p.username ?? undefined, password: '', target: DEFAULT_TARGET });
  };

  const body = (v: FormValues) => ({ ...v, username: v.username || null, password: v.password || undefined });

  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      if (current) await api(`/api/admin/proxies/${current.id}`, { method: 'PATCH', body: body(v) });
      else await api('/api/admin/proxies', { method: 'POST', body: body(v) });
      message.success(current?.accountCount ? t.proxies.savedReconnecting : t.common.saved);
      await qc.invalidateQueries({ queryKey: ['proxies'] });
      setEditing(null);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const testForm = async () => {
    const v = await form.validateFields();
    setTesting('form');
    setResult(null);
    try {
      setResult(await api<ProxyTestResult>('/api/admin/proxies/test', { method: 'POST', body: { ...body(v), id: current?.id } }));
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(null);
    }
  };

  const testRow = async (p: ProxyItem) => {
    setTesting(p.id);
    try {
      const r = await api<ProxyTestResult>('/api/admin/proxies/test', { method: 'POST', body: { id: p.id, target: DEFAULT_TARGET } });
      if (r.ok) message.success(t.proxies.rowTestOk(p.name, DEFAULT_TARGET, r.ms));
      else message.error(t.proxies.rowTestFailed(p.name, r.error));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setTesting(null);
    }
  };

  const remove = async (p: ProxyItem) => {
    try {
      await api(`/api/admin/proxies/${p.id}`, { method: 'DELETE' });
      message.success(t.common.deleted);
      await Promise.all(['proxies', 'admin-accounts', 'oauth'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <Flex align="center" justify="space-between" style={{ marginBottom: 16 }} gap={16} wrap>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t.proxies.title}
          </Typography.Title>
          <Typography.Text type="secondary">{t.proxies.desc}</Typography.Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')}>
          {t.proxies.add}
        </Button>
      </Flex>

      <TableFill>
        {(y) => (
          <Table<ProxyItem>
            rowKey="id"
            bordered
            loading={list.isPending}
            dataSource={list.data}
            pagination={false}
            scroll={{ x: 720, y }}
            locale={{ emptyText: t.proxies.empty }}
            columns={[
              { title: t.proxies.name, dataIndex: 'name', width: 200, ellipsis: true },
              {
                title: t.proxies.address,
                width: 280,
                render: (_, p) => (
                  <Typography.Text code style={{ whiteSpace: 'nowrap' }}>
                    {address(p)}
                  </Typography.Text>
                ),
              },
              {
                title: t.proxies.auth,
                width: 160,
                ellipsis: true,
                render: (_, p) => (p.username ? p.username : <Typography.Text type="secondary">{t.proxies.none}</Typography.Text>),
              },
              {
                title: t.proxies.inUse,
                dataIndex: 'accountCount',
                width: 120,
                align: 'right',
                render: (n: number) => (n ? t.proxies.accountCount(n) : <Typography.Text type="secondary">{t.proxies.unused}</Typography.Text>),
              },
              {
                title: '',
                width: 130,
                render: (_, p) => (
                  <Flex gap={4}>
                    <Tooltip title={t.proxies.testTarget(DEFAULT_TARGET)}>
                      <Button type="text" icon={<ApiOutlined />} loading={testing === p.id} onClick={() => testRow(p)} />
                    </Tooltip>
                    <Button type="text" icon={<EditOutlined />} onClick={() => open(p)} />
                    <Popconfirm
                      title={t.proxies.deleteTitle}
                      description={p.accountCount ? t.proxies.deleteDesc(p.accountCount) : undefined}
                      okText={t.common.delete}
                      okButtonProps={{ danger: true }}
                      onConfirm={() => remove(p)}
                    >
                      <Button type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Flex>
                ),
              },
            ]}
          />
        )}
      </TableFill>

      <Modal
        open={!!editing}
        title={current ? t.proxies.edit : t.proxies.add}
        onCancel={() => setEditing(null)}
        destroyOnHidden
        footer={
          <Flex justify="space-between" gap={8}>
            <Button icon={<ApiOutlined />} loading={testing === 'form'} onClick={testForm}>
              {t.accountForm.testConnection}
            </Button>
            <Flex gap={8}>
              <Button onClick={() => setEditing(null)}>{t.common.cancel}</Button>
              <Button type="primary" loading={saving} onClick={save}>
                {t.common.save}
              </Button>
            </Flex>
          </Flex>
        }
      >
        <Form form={form} {...horizontalForm(undefined, { marginTop: 16 })} className="form-compact" requiredMark={false}>
          <Form.Item name="name" label={t.proxies.name} rules={[{ required: true, message: t.proxies.nameRequired }]}>
            <Input placeholder={t.proxies.namePlaceholder} />
          </Form.Item>
          <Form.Item name="protocol" label={t.proxies.type}>
            <Select
              options={PROTOCOLS}
              onChange={(v: ProxyProtocol) => {
                // 端口还是上一个类型的默认值时跟着换
                const prev = PROTOCOLS.find((p) => p.port === form.getFieldValue('port'));
                if (prev) form.setFieldValue('port', PROTOCOLS.find((p) => p.value === v)!.port);
              }}
            />
          </Form.Item>
          <Form.Item name="host" label={t.proxies.host} rules={[{ required: true, message: t.proxies.hostRequired }]}>
            <Input placeholder={t.proxies.hostPlaceholder} autoComplete="off" />
          </Form.Item>
          <Form.Item name="port" label={t.proxies.port} rules={[{ required: true, message: t.proxies.portRequired }]}>
            <InputNumber min={1} max={65535} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="username" label={t.proxies.username}>
            <Input placeholder={t.proxies.noAuth} autoComplete="off" />
          </Form.Item>
          <Form.Item name="password" label={t.proxies.password} tooltip={tip(t.accountForm.secretTip)}>
            <Input.Password placeholder={current?.hasPassword ? t.proxies.passwordSaved : t.proxies.noAuth} autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="target" label={t.proxies.target} tooltip={tip(t.proxies.targetTip)} style={{ marginBottom: result ? 16 : 0 }}>
            <Input placeholder={DEFAULT_TARGET} />
          </Form.Item>
        </Form>
        {result &&
          (result.ok ? (
            <Alert type="success" showIcon title={t.proxies.testOk(result.ms)} />
          ) : (
            <Alert type="error" showIcon title={t.accountForm.connectFailed} description={result.error} />
          ))}
      </Modal>
    </div>
  );
}
