import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, EditOutlined, ExperimentOutlined, MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Checkbox, Drawer, Empty, Flex, Form, Input, Popconfirm, Radio, Select, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, type Rule, type RuleAction, type RuleCondition, type RuleTestResult } from '../../api';
import { CATEGORY_META, PRIORITY_META } from '../../components/Insight';
import { useAccounts, useFolders, useLabels } from '../../hooks/data';
import { labelName as nameOf } from '../../components/Labels';
import { folderLabel, fromNow, shortDate, sortFolders } from '../../lib/format';
import { horizontalForm } from '../../lib/form';
import { AccountScope, accountScopeRule } from '../../components/AccountScope';
import { TableFill } from '../../components/TableFill';
import { t } from '../../i18n';

// 名称按当前界面语言从 t.rules 取
const FIELDS: { value: string; kind: 'text' | 'category' | 'priority' | 'bool' | 'label'; ai?: boolean }[] = [
  { value: 'from', kind: 'text' },
  { value: 'to', kind: 'text' },
  { value: 'subject', kind: 'text' },
  { value: 'body', kind: 'text' },
  { value: 'any', kind: 'text' },
  { value: 'has_attachment', kind: 'bool' },
  { value: 'unread', kind: 'bool' },
  { value: 'category', kind: 'category', ai: true },
  { value: 'priority', kind: 'priority', ai: true },
  { value: 'needs_reply', kind: 'bool', ai: true },
  { value: 'has_code', kind: 'bool', ai: true },
  { value: 'label', kind: 'label', ai: true },
];
const FIELD_BY = Object.fromEntries(FIELDS.map((f) => [f.value, f]));
const fieldLabel = (v: string) => t.rules.fields[v] ?? v;
const fieldOptions = (ai: boolean) => FIELDS.filter((f) => !!f.ai === ai).map((f) => ({ value: f.value, label: fieldLabel(f.value) }));

const opOptions = (ops: string[]) => ops.map((value) => ({ value, label: t.rules.ops[value]! }));
const TEXT_OPS = ['contains', 'not_contains', 'equals', 'regex'];
const IS_OPS = ['is', 'is_not'];

const ACTIONS: { value: string; color?: string }[] = [
  { value: 'notify', color: 'blue' },
  { value: 'mark_read' },
  { value: 'star', color: 'gold' },
  { value: 'archive' },
  { value: 'move' },
  { value: 'junk', color: 'orange' },
  { value: 'trash', color: 'red' },
  { value: 'ai_reply', color: 'purple' },
];
const ACTION_BY = Object.fromEntries(ACTIONS.map((a) => [a.value, a]));

// accountIds：null 表示全部邮箱，数组表示指定邮箱（约定见 AccountScope）
type FormValues = Omit<Rule, 'id' | 'position' | 'matchCount' | 'lastMatchedAt' | 'accountIds'> & { accountIds?: number[] | null };

/** labelName：按 id 取标签名，标签已删除时返回 undefined */
function describeCondition(c: RuleCondition, labelName: (id: string) => string | undefined) {
  const f = FIELD_BY[c.field];
  if (!f) return c.field;
  const not = c.op === 'is_not' || c.op === 'not_contains';
  if (f.kind === 'bool') return t.rules.boolCond(fieldLabel(f.value), (c.value === false) !== not);
  if (f.kind === 'category') return t.rules.categoryCond(CATEGORY_META[String(c.value)]?.label ?? String(c.value), not);
  if (f.kind === 'label') return t.rules.labelCond(labelName(String(c.value)) ?? t.rules.deletedLabel, not);
  if (f.kind === 'priority') return t.rules.priorityCond(PRIORITY_META[c.value as 'high']?.label ?? String(c.value), not);
  return t.rules.textCond(fieldLabel(f.value), t.rules.ops[c.op] ?? c.op, String(c.value));
}

function defaultsFor(field: string): Partial<RuleCondition> {
  const kind = FIELD_BY[field]?.kind;
  if (kind === 'text') return { op: 'contains', value: '' };
  if (kind === 'category') return { op: 'is', value: 'finance' };
  if (kind === 'priority') return { op: 'is', value: 'high' };
  if (kind === 'label') return { op: 'is', value: undefined };
  return { op: 'is', value: true };
}

export function RulesPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const accounts = useAccounts();
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api<Rule[]>('/api/v1/rules') });
  const labels = useLabels();
  const labelName = (id: string) => {
    const l = labels.data?.find((x) => String(x.id) === id);
    return l && nameOf(l);
  };
  const channels = useQuery({
    queryKey: ['channel-list'],
    queryFn: () => api<{ id: number; name: string; type: string; enabled: boolean }[]>('/api/v1/channels'),
  });
  const ai = useQuery({ queryKey: ['ai-settings'], queryFn: () => api<{ enabled: boolean; hasApiKey: boolean }>('/api/admin/ai') });
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['rules'] });
  const list = rules.data ?? [];
  const usesAi = list.some((r) => r.enabled && r.conditions.some((c) => FIELD_BY[c.field]?.ai));
  const accountName = (id: number) => accounts.data?.find((a) => a.id === id)?.name ?? `#${id}`;
  const channelName = (id?: number) => channels.data?.find((c) => c.id === id)?.name ?? t.rules.deletedChannel;

  const toggle = async (r: Rule, enabled: boolean) => {
    await api(`/api/v1/rules/${r.id}`, { method: 'PATCH', body: { enabled } });
    await refresh();
  };

  const move = async (index: number, delta: number) => {
    const ids = list.map((r) => r.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + delta, 0, id!);
    await api('/api/v1/rules/reorder', { method: 'POST', body: { ids } });
    await refresh();
  };

  const remove = async (r: Rule) => {
    await api(`/api/v1/rules/${r.id}`, { method: 'DELETE' });
    message.success(t.common.deleted);
    await refresh();
  };

  const describeAction = (a: RuleAction) => {
    if (a.type === 'notify') return t.rules.notifyTo(channelName(a.channelId));
    return t.rules.actions[a.type] ?? a.type;
  };

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <Flex align="center" justify="space-between" style={{ marginBottom: 16 }} gap={16} wrap>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t.rules.title}
          </Typography.Title>
          <Typography.Text type="secondary">{t.rules.desc}</Typography.Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
          {t.rules.create}
        </Button>
      </Flex>

      {usesAi && ai.data && !(ai.data.enabled && ai.data.hasApiKey) && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title={t.rules.aiWarning}
          action={
            <Button size="small" onClick={() => navigate('/ai/models')}>
              {t.rules.goSettings}
            </Button>
          }
        />
      )}

      <TableFill>
        {(y) => (
          <Table<Rule>
            rowKey="id"
            bordered
            loading={rules.isPending}
            dataSource={list}
            pagination={false}
            scroll={{ x: 640, y }}
            locale={{ emptyText: <Empty description={t.rules.empty} /> }}
            columns={[
              {
                title: '',
                width: 72,
                render: (_, r, i) => (
                  <Flex>
                    <Button type="text" size="small" icon={<ArrowUpOutlined />} disabled={i === 0} onClick={() => move(i, -1)} />
                    <Button type="text" size="small" icon={<ArrowDownOutlined />} disabled={i === list.length - 1} onClick={() => move(i, 1)} />
                  </Flex>
                ),
              },
              {
                title: t.rules.rule,
                minWidth: 240,
                render: (_, r) => (
                  <div>
                    <Flex gap={8} align="center" wrap>
                      <Typography.Text strong>{r.name}</Typography.Text>
                      {r.accountIds?.map((id) => (
                        <Tag key={id} style={{ fontSize: 11 }}>
                          {accountName(id)}
                        </Tag>
                      ))}
                      {r.stopProcessing && <Tag style={{ fontSize: 11 }}>{t.rules.stopAfter}</Tag>}
                    </Flex>
                    <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                      {t.rules.when(
                        r.conditions.map((c) => describeCondition(c, labelName)),
                        r.match === 'all',
                      )}
                    </Typography.Text>
                    <Flex gap={4} wrap style={{ marginTop: 4 }}>
                      {r.actions.map((a, i) => (
                        <Tag key={i} color={ACTION_BY[a.type]?.color}>
                          {describeAction(a)}
                        </Tag>
                      ))}
                    </Flex>
                  </div>
                ),
              },
              {
                title: t.rules.hits,
                width: 120,
                render: (_, r) => (
                  <Tooltip title={r.lastMatchedAt ? t.rules.lastHit(fromNow(r.lastMatchedAt)) : undefined}>
                    <span>{t.rules.hitCount(r.matchCount)}</span>
                  </Tooltip>
                ),
              },
              {
                title: t.rules.enabled,
                dataIndex: 'enabled',
                width: 70,
                render: (v: boolean, r) => <Switch size="small" checked={v} onChange={(x) => toggle(r, x)} />,
              },
              {
                title: '',
                width: 90,
                render: (_, r) => (
                  <Flex gap={4}>
                    <Button type="text" icon={<EditOutlined />} onClick={() => setEditing(r)} />
                    <Popconfirm title={t.rules.deleteTitle} okText={t.common.delete} okButtonProps={{ danger: true }} onConfirm={() => remove(r)}>
                      <Button type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Flex>
                ),
              },
            ]}
          />
        )}
      </TableFill>

      <Drawer open={!!editing} title={editing === 'new' ? t.rules.create : t.rules.edit} size={720} onClose={() => setEditing(null)} destroyOnHidden>
        {editing && (
          <RuleEditor
            rule={editing === 'new' ? null : editing}
            channels={channels.data ?? []}
            onSaved={async () => {
              setEditing(null);
              await refresh();
            }}
          />
        )}
      </Drawer>
    </div>
  );
}

function RuleEditor({ rule, channels, onSaved }: { rule: Rule | null; channels: { id: number; name: string; enabled: boolean }[]; onSaved: () => void }) {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const accounts = useAccounts();
  const folders = useFolders();
  const [form] = Form.useForm<FormValues>();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<RuleTestResult | null>(null);
  const conditions = Form.useWatch('conditions', form) ?? [];
  const labels = useLabels();
  const actions = Form.useWatch('actions', form) ?? [];

  const initial: FormValues = rule
    ? { ...rule, accountIds: rule.accountIds?.length ? rule.accountIds : null }
    : {
        name: '',
        enabled: true,
        match: 'all',
        accountIds: null,
        conditions: [{ field: 'from', op: 'contains', value: '' }],
        actions: [{ type: channels[0] ? 'notify' : 'star', channelId: channels[0]?.id }],
        stopProcessing: false,
      };

  const folderOptions = useMemo(
    () =>
      (accounts.data ?? []).map((a) => ({
        label: a.name,
        title: a.email,
        options: sortFolders((folders.data ?? []).filter((f) => f.accountId === a.id)).map((f) => ({ value: f.id, label: folderLabel(f) })),
      })),
    [accounts.data, folders.data],
  );

  const body = (v: FormValues) => ({ ...v, accountIds: v.accountIds?.length ? v.accountIds : null });

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (rule) await api(`/api/v1/rules/${rule.id}`, { method: 'PATCH', body: body(values) });
      else await api('/api/v1/rules', { method: 'POST', body: body(values) });
      message.success(t.common.saved);
      onSaved();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    const values = await form.validateFields();
    setTesting(true);
    try {
      setResult(await api<RuleTestResult>('/api/v1/rules/test', { method: 'POST', body: body(values) }));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Form form={form} {...horizontalForm()} requiredMark={false} initialValues={initial} onValuesChange={() => setResult(null)}>
      <Form.Item name="name" label={t.rules.name} rules={[{ required: true, message: t.rules.nameRequired }]}>
        <Input placeholder={t.rules.namePlaceholder} />
      </Form.Item>
      <Form.Item name="accountIds" label={t.rules.accounts} rules={[accountScopeRule]}>
        <AccountScope maxRows={3} />
      </Form.Item>

      <Form.Item label={t.rules.conditions}>
        <Card
          size="small"
          title={
            <Flex align="center" gap={8}>
              <span>{t.rules.whenMail}</span>
              <Form.Item name="match" noStyle>
                <Radio.Group
                  size="small"
                  optionType="button"
                  options={[
                    { value: 'all', label: t.rules.all },
                    { value: 'any', label: t.rules.any },
                  ]}
                />
              </Form.Item>
              <span>{t.rules.condSuffix}</span>
            </Flex>
          }
        >
          <Form.List name="conditions">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => {
                  const c = conditions[field.name] ?? {};
                  const kind = FIELD_BY[c.field]?.kind ?? 'text';
                  return (
                    <Flex key={field.key} gap={8} align="flex-start" wrap>
                      <Form.Item name={[field.name, 'field']} style={{ width: 150, marginBottom: 8 }}>
                        <Select
                          options={[
                            { label: t.rules.mailContent, options: fieldOptions(false) },
                            { label: t.rules.needsAi, options: fieldOptions(true) },
                          ]}
                          onChange={(v: string) => form.setFieldValue(['conditions', field.name], { field: v, ...defaultsFor(v) })}
                        />
                      </Form.Item>
                      <Form.Item name={[field.name, 'op']} style={{ width: 110, marginBottom: 8 }}>
                        <Select options={opOptions(kind === 'text' ? TEXT_OPS : IS_OPS)} />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, 'value']}
                        style={{ flex: 1, minWidth: 160, marginBottom: 8 }}
                        rules={
                          kind === 'text'
                            ? [{ required: true, message: t.rules.valueRequired }]
                            : kind === 'label'
                              ? [{ required: true, message: t.rules.labelRequired }]
                              : undefined
                        }
                      >
                        {kind === 'text' ? (
                          <Input placeholder={c.op === 'regex' ? t.rules.regexPlaceholder : t.rules.textPlaceholder} />
                        ) : kind === 'category' ? (
                          <Select options={Object.entries(CATEGORY_META).map(([value, m]) => ({ value, label: m.label }))} />
                        ) : kind === 'label' ? (
                          <Select
                            placeholder={t.rules.pickLabel}
                            showSearch={{ optionFilterProp: 'name' }}
                            options={(labels.data ?? []).map((l) => ({ value: String(l.id), name: nameOf(l), label: <Tag color={l.color}>{nameOf(l)}</Tag> }))}
                            notFoundContent={t.rules.noLabels}
                          />
                        ) : kind === 'priority' ? (
                          <Select options={Object.entries(PRIORITY_META).map(([value, m]) => ({ value, label: m.label }))} />
                        ) : (
                          <Select
                            options={[
                              { value: true, label: t.rules.yes },
                              { value: false, label: t.rules.no },
                            ]}
                          />
                        )}
                      </Form.Item>
                      <Button type="text" icon={<MinusCircleOutlined />} disabled={fields.length === 1} onClick={() => remove(field.name)} />
                    </Flex>
                  );
                })}
                <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ field: 'subject', op: 'contains', value: '' })} block>
                  {t.rules.addCondition}
                </Button>
              </>
            )}
          </Form.List>
        </Card>
      </Form.Item>

      <Form.Item label={t.rules.actionsLabel}>
        <Card size="small">
          <Form.List name="actions">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => {
                  const a = actions[field.name] ?? {};
                  return (
                    <Flex key={field.key} gap={8} align="flex-start" wrap>
                      <Form.Item name={[field.name, 'type']} style={{ width: 210, marginBottom: 8 }}>
                        <Select options={ACTIONS.map(({ value }) => ({ value, label: t.rules.actions[value] }))} />
                      </Form.Item>
                      {a.type === 'notify' && (
                        <Form.Item
                          name={[field.name, 'channelId']}
                          style={{ flex: 1, minWidth: 200, marginBottom: 8 }}
                          rules={[{ required: true, message: t.rules.channelRequired }]}
                        >
                          <Select
                            placeholder={t.rules.pickChannel}
                            options={channels.map((c) => ({ value: c.id, label: c.enabled ? c.name : t.rules.channelDisabled(c.name) }))}
                            notFoundContent={
                              <Button type="link" size="small" onClick={() => navigate('/ai/channels')}>
                                {t.rules.addChannelFirst}
                              </Button>
                            }
                          />
                        </Form.Item>
                      )}
                      {a.type === 'move' && (
                        <Form.Item
                          name={[field.name, 'folderId']}
                          style={{ flex: 1, minWidth: 200, marginBottom: 8 }}
                          rules={[{ required: true, message: t.rules.folderRequired }]}
                          extra={t.rules.folderExtra}
                        >
                          <Select placeholder={t.rules.pickFolder} options={folderOptions} showSearch={{ optionFilterProp: 'label' }} />
                        </Form.Item>
                      )}
                      {a.type === 'ai_reply' && (
                        <Form.Item name={[field.name, 'instruction']} style={{ flex: 1, minWidth: 240, marginBottom: 8 }} extra={t.rules.aiReplyExtra}>
                          <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} placeholder={t.rules.aiReplyPlaceholder} />
                        </Form.Item>
                      )}
                      {!['notify', 'move', 'ai_reply'].includes(a.type) && <div style={{ flex: 1 }} />}
                      <Button type="text" icon={<MinusCircleOutlined />} disabled={fields.length === 1} onClick={() => remove(field.name)} />
                    </Flex>
                  );
                })}
                <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ type: 'mark_read' })} block>
                  {t.rules.addAction}
                </Button>
              </>
            )}
          </Form.List>
        </Card>
      </Form.Item>

      <Form.Item name="stopProcessing" valuePropName="checked" className="form-offset" style={{ marginBottom: 8 }}>
        <Checkbox>{t.rules.stopProcessing}</Checkbox>
      </Form.Item>
      <Form.Item name="enabled" valuePropName="checked" className="form-offset">
        <Checkbox>{t.rules.enabled}</Checkbox>
      </Form.Item>

      <Flex gap={8} className="form-offset" style={{ marginBottom: 16 }}>
        <Button type="primary" loading={saving} onClick={save}>
          {t.common.save}
        </Button>
        <Button icon={<ExperimentOutlined />} loading={testing} onClick={test}>
          {t.rules.dryRun}
        </Button>
      </Flex>

      {result && (
        <Card size="small" className="form-offset" title={t.rules.dryRunResult(result.scanned, result.matched)}>
          {result.note && <Alert type="info" showIcon title={result.note} style={{ marginBottom: 12 }} />}
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            {t.rules.dryRunNote}
          </Typography.Paragraph>
          {result.samples.length > 0 && (
            <Table
              size="small"
              bordered
              rowKey="id"
              pagination={false}
              dataSource={result.samples}
              columns={[
                { title: t.rules.from, dataIndex: 'from', width: 140, ellipsis: true },
                { title: t.rules.subject, dataIndex: 'subject', ellipsis: true },
                { title: t.rules.time, dataIndex: 'date', width: 100, render: shortDate },
              ]}
            />
          )}
        </Card>
      )}
    </Form>
  );
}
