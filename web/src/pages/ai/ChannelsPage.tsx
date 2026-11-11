import {
  ApiOutlined,
  BellFilled,
  DeleteOutlined,
  DingdingOutlined,
  EditOutlined,
  HistoryOutlined,
  PlusOutlined,
  SendOutlined,
  WechatWorkOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Checkbox, Drawer, Flex, Form, Input, Modal, Popconfirm, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { useState, type ReactNode } from 'react';
import { api, type Channel, type ChannelDelivery } from '../../api';
import { fromNow } from '../../lib/format';
import { horizontalForm } from '../../lib/form';
import { TableFill } from '../../components/TableFill';
import { t, type Messages } from '../../i18n';

type ChannelList = { items: Channel[]; events: Record<string, string>; types: Channel['type'][] };

type Field = { name: string; secret?: boolean; required?: boolean };

type TypeMeta = {
  /** 图标底色 */
  brand: string;
  icon: ReactNode;
  fields: Field[];
};

/** 渠道的图标和字段；名称、说明、步骤和字段文字按当前界面语言从 t.channels.types 取 */
const TYPES: Record<Channel['type'], TypeMeta> = {
  bark: {
    brand: '#fa8c16',
    icon: <BellFilled />,
    fields: [{ name: 'key', secret: true, required: true }, { name: 'server' }],
  },
  wecom: { brand: '#0082ef', icon: <WechatWorkOutlined />, fields: [{ name: 'webhook', secret: true, required: true }] },
  dingtalk: {
    brand: '#1677ff',
    icon: <DingdingOutlined />,
    fields: [
      { name: 'webhook', secret: true, required: true },
      { name: 'secret', secret: true },
    ],
  },
  feishu: {
    brand: '#3370ff',
    icon: '飞',
    fields: [
      { name: 'webhook', secret: true, required: true },
      { name: 'secret', secret: true },
    ],
  },
  telegram: {
    brand: '#229ed9',
    icon: <SendOutlined />,
    fields: [{ name: 'botToken', secret: true, required: true }, { name: 'chatId', required: true }, { name: 'apiBase' }],
  },
  webhook: {
    brand: '#722ed1',
    icon: <ApiOutlined />,
    fields: [
      { name: 'url', secret: true, required: true },
      { name: 'secret', secret: true },
    ],
  },
};

const typeText = (type: Channel['type']) => t.channels.types[type];

/** 步骤文字里 **加粗**、`代码` */
function rich(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) =>
    part.startsWith('**') ? (
      <Typography.Text key={i} strong>
        {part.slice(2, -2)}
      </Typography.Text>
    ) : part.startsWith('`') ? (
      <Typography.Text key={i} code>
        {part.slice(1, -1)}
      </Typography.Text>
    ) : (
      part
    ),
  );
}

// 订阅事件分组显示；服务端以后新增的事件归到「其他」
const EVENT_GROUPS: Array<{ key: keyof Messages['channels']['groups']; keys: string[] }> = [
  { key: 'received', keys: ['message.received', 'message.important', 'message.verification'] },
  { key: 'sending', keys: ['draft.pending', 'draft.sent', 'draft.failed', 'followup.due'] },
  { key: 'reports', keys: ['report.daily', 'report.weekly'] },
  { key: 'system', keys: ['account.error'] },
];
const RECOMMENDED_EVENTS = ['message.important', 'message.verification', 'draft.pending', 'followup.due', 'account.error'];

function TypeIcon({ type, size = 32 }: { type: Channel['type']; size?: number }) {
  const meta = TYPES[type];
  return (
    <span className="channel-type-icon" style={{ width: size, height: size, fontSize: size * 0.5, background: meta.brand }}>
      {meta.icon}
    </span>
  );
}

function SectionTitle({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
  return (
    <Flex align="center" justify="space-between" className="form-section-title">
      <Typography.Text strong>{children}</Typography.Text>
      {extra}
    </Flex>
  );
}

const DELIVERY_COLOR: Record<ChannelDelivery['status'], string> = {
  queued: 'default',
  running: 'processing',
  done: 'success',
  failed: 'error',
};

type FormValues = { name: string; type: Channel['type']; events: string[]; enabled: boolean; config: Record<string, string> };

export function ChannelsPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['channels'], queryFn: () => api<ChannelList>('/api/admin/channels') });
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const [history, setHistory] = useState<Channel | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<FormValues>();
  const type = Form.useWatch('type', form) ?? 'bark';
  const events = list.data?.events ?? {};
  const known = new Set(EVENT_GROUPS.flatMap((g) => g.keys));
  const eventGroups = [
    ...EVENT_GROUPS.map((g) => ({ title: t.channels.groups[g.key], keys: g.keys.filter((k) => k in events) })),
    { title: t.channels.groups.other, keys: Object.keys(events).filter((k) => !known.has(k)) },
  ].filter((g) => g.keys.length);

  const open = (ch: Channel | 'new') => {
    setEditing(ch);
    form.resetFields();
    if (ch === 'new') form.setFieldsValue({ type: 'bark', name: typeText('bark').label, enabled: true, events: RECOMMENDED_EVENTS, config: {} });
    else form.setFieldsValue({ name: ch.name, type: ch.type, enabled: ch.enabled, events: ch.events, config: ch.config });
  };

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing === 'new') await api('/api/admin/channels', { method: 'POST', body: values });
      else if (editing) await api(`/api/admin/channels/${editing.id}`, { method: 'PATCH', body: values });
      message.success(t.common.saved);
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ['channels'] });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const pickType = (next: Channel['type']) => {
    if (next === type) return;
    form.setFieldsValue({ type: next, config: {} });
    // 名称还是上一个类型的默认名时跟着换
    const name = form.getFieldValue('name') as string | undefined;
    if (!name || Object.values(t.channels.types).some((x) => name === x.label)) form.setFieldValue('name', typeText(next).label);
  };

  const sendTest = async () => {
    const values = await form.validateFields();
    setTesting(true);
    try {
      const res = await api<{ ok: boolean; error?: string }>('/api/admin/channels/test', {
        method: 'POST',
        body: { ...values, id: editing !== 'new' ? editing?.id : undefined },
      });
      if (res.ok) message.success(t.channels.testSent);
      else message.error(res.error ?? t.channels.sendFailed, 6);
    } finally {
      setTesting(false);
    }
  };

  const toggle = async (ch: Channel, enabled: boolean) => {
    await api(`/api/admin/channels/${ch.id}`, { method: 'PATCH', body: { enabled } });
    await qc.invalidateQueries({ queryKey: ['channels'] });
  };

  const remove = async (ch: Channel) => {
    await api(`/api/admin/channels/${ch.id}`, { method: 'DELETE' });
    message.success(t.common.deleted);
    await qc.invalidateQueries({ queryKey: ['channels'] });
  };

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <Flex align="center" justify="space-between" style={{ marginBottom: 16 }} gap={16} wrap>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t.channels.title}
          </Typography.Title>
          <Typography.Text type="secondary">{t.channels.desc}</Typography.Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')}>
          {t.channels.add}
        </Button>
      </Flex>

      <TableFill>
        {(y) => (
          <Table<Channel>
            rowKey="id"
            bordered
            loading={list.isPending}
            dataSource={list.data?.items}
            pagination={false}
            scroll={{ x: 720, y }}
            columns={[
              {
                title: t.channels.name,
                dataIndex: 'name',
                minWidth: 180,
                render: (name, ch) => (
                  <Flex gap={8} align="center">
                    <TypeIcon type={ch.type} size={22} />
                    <span>{name}</span>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {typeText(ch.type).label}
                    </Typography.Text>
                  </Flex>
                ),
              },
              {
                title: t.channels.events,
                minWidth: 200,
                dataIndex: 'events',
                render: (ev: string[]) =>
                  ev.length ? (
                    <Flex wrap gap={4}>
                      {ev.map((e) => (
                        <Tooltip key={e} title={events[e]}>
                          <Tag>{e}</Tag>
                        </Tooltip>
                      ))}
                    </Flex>
                  ) : (
                    <Typography.Text type="secondary">{t.channels.rulesOnly}</Typography.Text>
                  ),
              },
              {
                title: t.channels.enabled,
                dataIndex: 'enabled',
                width: 80,
                render: (v: boolean, ch) => <Switch size="small" checked={v} onChange={(x) => toggle(ch, x)} />,
              },
              {
                title: '',
                width: 130,
                render: (_, ch) => (
                  <Flex gap={4}>
                    <Tooltip title={t.channels.history}>
                      <Button type="text" icon={<HistoryOutlined />} onClick={() => setHistory(ch)} />
                    </Tooltip>
                    <Button type="text" icon={<EditOutlined />} onClick={() => open(ch)} />
                    <Popconfirm title={t.channels.deleteTitle} okText={t.common.delete} okButtonProps={{ danger: true }} onConfirm={() => remove(ch)}>
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
        title={editing === 'new' ? t.channels.addTitle : t.channels.editTitle}
        onCancel={() => setEditing(null)}
        width={720}
        destroyOnHidden
        styles={{ body: { maxHeight: 'calc(100vh - 240px)', overflow: 'auto', marginInline: -24, paddingInline: 24 } }}
        footer={
          <Flex justify="space-between" gap={8}>
            <Button icon={<SendOutlined />} loading={testing} onClick={sendTest}>
              {t.channels.sendTest}
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
        <Form form={form} {...horizontalForm(116)} requiredMark={false}>
          <Form.Item name="type" hidden>
            <Input />
          </Form.Item>

          {editing === 'new' ? (
            <>
              <SectionTitle>{t.channels.type}</SectionTitle>
              <div className="channel-types" role="radiogroup" aria-label={t.channels.type}>
                {(Object.keys(TYPES) as Channel['type'][]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={k === type}
                    className={`channel-type${k === type ? ' is-active' : ''}`}
                    onClick={() => pickType(k)}
                  >
                    <TypeIcon type={k} />
                    <span style={{ minWidth: 0 }}>
                      <Typography.Text strong style={{ display: 'block' }}>
                        {typeText(k).label}
                      </Typography.Text>
                      <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>
                        {typeText(k).desc}
                      </Typography.Text>
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <Flex align="center" gap={10} style={{ marginBottom: 20 }}>
              <TypeIcon type={type} />
              <div>
                <Typography.Text strong style={{ display: 'block' }}>
                  {typeText(type).label}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {typeText(type).desc}
                </Typography.Text>
              </div>
            </Flex>
          )}

          <SectionTitle>{t.channels.connection}</SectionTitle>
          <ol className="channel-steps">
            {typeText(type).steps.map((step, i) => (
              <li key={i}>{rich(step)}</li>
            ))}
          </ol>
          <Form.Item name="name" label={t.channels.name} rules={[{ required: true, whitespace: true, message: t.channels.nameRequired }]}>
            <Input placeholder={t.channels.namePlaceholder(typeText(type).label)} maxLength={100} />
          </Form.Item>
          <Form.Item name="enabled" label={t.channels.enabled} valuePropName="checked">
            <Switch />
          </Form.Item>
          {TYPES[type].fields.map((f) => {
            const text = typeText(type).fields[f.name]!;
            return (
              <Form.Item
                key={`${type}.${f.name}`}
                name={['config', f.name]}
                label={text.label}
                extra={editing !== 'new' && f.secret ? `${text.extra ? `${text.extra}${t.channels.extraSep}` : ''}${t.channels.masked}` : text.extra}
                rules={f.required ? [{ required: true, whitespace: true, message: t.channels.fieldRequired(text.label) }] : undefined}
              >
                <Input placeholder={text.placeholder} autoComplete="off" spellCheck={false} />
              </Form.Item>
            );
          })}

          <Form.Item label={t.channels.pushEvents} extra={t.channels.pushEventsExtra}>
            <Flex gap={12} align="center" style={{ height: 'var(--ant-control-height)', marginBottom: 4 }}>
              <Typography.Link onClick={() => form.setFieldValue('events', RECOMMENDED_EVENTS)}>{t.channels.recommended}</Typography.Link>
              <Typography.Link onClick={() => form.setFieldValue('events', Object.keys(events))}>{t.channels.all}</Typography.Link>
              <Typography.Link onClick={() => form.setFieldValue('events', [])}>{t.channels.clear}</Typography.Link>
            </Flex>
            <Form.Item name="events" noStyle>
              <Checkbox.Group style={{ display: 'block' }}>
                <Flex vertical gap={12}>
                  {eventGroups.map((g) => (
                    <div key={g.title}>
                      <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 6 }}>
                        {g.title}
                      </Typography.Text>
                      <div className="event-options">
                        {g.keys.map((k) => (
                          <label key={k} className="option-card">
                            <Checkbox value={k} />
                            <span style={{ minWidth: 0 }}>
                              <span style={{ display: 'block' }}>{events[k]}</span>
                              <Typography.Text type="secondary" style={{ fontSize: 11, fontFamily: 'var(--ant-font-family-code)' }}>
                                {k}
                              </Typography.Text>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </Flex>
              </Checkbox.Group>
            </Form.Item>
          </Form.Item>
        </Form>
      </Modal>

      <Drawer open={!!history} title={t.channels.historyTitle(history?.name ?? '')} size={560} onClose={() => setHistory(null)} destroyOnHidden>
        {history && <Deliveries channelId={history.id} />}
      </Drawer>
    </div>
  );
}

function Deliveries({ channelId }: { channelId: number }) {
  const q = useQuery({
    queryKey: ['channel-deliveries', channelId],
    queryFn: () => api<ChannelDelivery[]>(`/api/admin/channels/${channelId}/deliveries`),
    refetchInterval: 5000,
  });
  return (
    <Table<ChannelDelivery>
      rowKey="id"
      bordered
      size="small"
      loading={q.isPending}
      dataSource={q.data}
      pagination={false}
      columns={[
        {
          title: t.channels.content,
          minWidth: 200,
          dataIndex: 'title',
          render: (title: string, d) => (
            <div>
              <Typography.Text ellipsis style={{ maxWidth: 300, display: 'block' }}>
                {title}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {d.event} · {fromNow(d.createdAt)}
              </Typography.Text>
              {d.error && (
                <Typography.Text type="danger" style={{ fontSize: 12, display: 'block' }}>
                  {d.error}
                </Typography.Text>
              )}
            </div>
          ),
        },
        {
          title: t.channels.status,
          dataIndex: 'status',
          width: 110,
          render: (s: ChannelDelivery['status'], d) => (
            <Tag color={DELIVERY_COLOR[s]}>
              {t.channels.delivery[s]}
              {d.attempts > 1 ? ` ×${d.attempts}` : ''}
            </Tag>
          ),
        },
      ]}
    />
  );
}
