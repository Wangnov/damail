import { BulbOutlined, DeleteOutlined, EditOutlined, HistoryOutlined, LoadingOutlined, LockOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Empty, Flex, Form, Input, Modal, Popconfirm, Space, Switch, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { TableFill } from '../../components/TableFill';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, ApiError, type Category, type LabelAdmin, type LabelSuggestion, type LabelSuggestRun, type LabelText } from '../../api';
import { ColorChoice, labelUrl } from '../../components/Labels';
import { useCategories, useStats } from '../../hooks/data';
import { intlLocale, LOCALES, pickText, t, useLocale, type I18n, type Locale } from '../../i18n';
import { fromNow } from '../../lib/format';
import { categoryQuery } from '../../lib/search';

type AdminList = { items: LabelAdmin[]; limit: number; colors: string[] };
type SuggestList = { run: LabelSuggestRun | null; days: number; suggestions: LabelSuggestion[] };
type LabelForm = { i18n: I18n<Partial<LabelText>>; color: string; pinned: boolean };

const fmt = (n: number) => n.toLocaleString(intlLocale());
const threadUrl = (threadId: string) => `/mail?view=all&thread=${encodeURIComponent(threadId)}`;
const categoryUrl = (key: string) => `/mail?view=all&q=${encodeURIComponent(categoryQuery(key))}`;

/** 名称、说明分开按当前语言取（某种语言只填了名称时，说明退回其他语言的） */
function textOf(i18n: I18n<Partial<LabelText>>) {
  const field = (k: keyof LabelText) => pickText(Object.fromEntries(Object.entries(i18n).map(([l, v]) => [l, v?.[k] ?? ''])) as I18n<string>) ?? '';
  return { name: field('name'), description: field('description') };
}
const allNames = (i18n: I18n<Partial<LabelText>>) => Object.values(i18n).flatMap((v) => (v?.name?.trim() ? [v.name.trim().toLowerCase()] : []));
/** 其他语言的名称，鼠标悬停时显示 */
const otherNames = (i18n: I18n<Partial<LabelText>>, shown: string) =>
  LOCALES.flatMap((l) => (i18n[l.value]?.name && i18n[l.value]!.name !== shown ? [`${l.label}：${i18n[l.value]!.name}`] : [])).join('\n') || undefined;
const stripReason = (i18n: LabelSuggestion['i18n']): I18n<LabelText> =>
  Object.fromEntries(Object.entries(i18n).map(([l, v]) => [l, { name: v?.name ?? '', description: v?.description ?? '' }]));

/** 名称标签；悬停显示其他语言的名称 */
function NameTag({ i18n, color }: { i18n: I18n<Partial<LabelText>>; color: string }) {
  const name = textOf(i18n).name;
  return (
    <Tooltip title={otherNames(i18n, name)} styles={{ container: { whiteSpace: 'pre-line' } }}>
      <Tag color={color} style={{ marginInlineEnd: 0 }}>
        {name}
      </Tag>
    </Tooltip>
  );
}

/** 编辑 / 新建标签、改名后采用推荐，共用一个表单：每种语言一个页签 */
function LabelModal({
  open,
  title,
  initial,
  withPinned,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial: Partial<LabelForm>;
  withPinned: boolean;
  onCancel: () => void;
  onSubmit: (v: LabelForm) => Promise<void>;
}) {
  const locale = useLocale();
  const [form] = Form.useForm<LabelForm>();
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Locale>(locale);
  const values = Form.useWatch('i18n', form) as LabelForm['i18n'] | undefined;
  const filled = (l: Locale, k: keyof LabelText) => !!values?.[l]?.[k]?.trim();
  // 至少一种语言有名称、一种语言有说明；改了一种语言要重新校验其他语言的同名字段
  const anyFilled = (k: keyof LabelText, msg: string) => ({
    validator: () => (LOCALES.some((l) => form.getFieldValue(['i18n', l.value, k])?.trim()) ? Promise.resolve() : Promise.reject(new Error(msg))),
  });
  const names = LOCALES.map((l) => ['i18n', l.value, 'name']);
  const descs = LOCALES.map((l) => ['i18n', l.value, 'description']);

  return (
    <Modal
      open={open}
      title={title}
      onCancel={onCancel}
      destroyOnHidden
      afterOpenChange={(o) => o && setTab(locale)}
      confirmLoading={saving}
      onOk={async () => {
        let v: LabelForm;
        try {
          v = await form.validateFields();
        } catch (e) {
          // 出错的字段都在别的页签里时，切到第一个出错的页签
          const errored = ((e as { errorFields?: { name: (string | number)[] }[] }).errorFields ?? []).map((f) => f.name[1]);
          const bad = LOCALES.find((l) => errored.includes(l.value));
          if (bad && !errored.includes(tab)) setTab(bad.value);
          return;
        }
        setSaving(true);
        try {
          await onSubmit(v);
        } finally {
          setSaving(false);
        }
      }}
    >
      <Form form={form} layout="vertical" preserve={false} initialValues={{ color: 'blue', pinned: true, i18n: {}, ...initial }}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
          {t.labels.languagesHelp}
        </Typography.Paragraph>
        <Tabs
          size="small"
          activeKey={tab}
          onChange={(k) => setTab(k as Locale)}
          items={LOCALES.map((l) => ({
            key: l.value,
            forceRender: true,
            label: (
              <Space size={4}>
                {l.label}
                {!filled(l.value, 'name') && !filled(l.value, 'description') && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    ({t.labels.notFilled})
                  </Typography.Text>
                )}
              </Space>
            ),
            children: (
              <>
                <Form.Item
                  name={['i18n', l.value, 'name']}
                  label={t.labels.name}
                  dependencies={names.filter((n) => n[1] !== l.value)}
                  rules={[anyFilled('name', t.labels.nameRequired)]}
                >
                  <Input maxLength={20} showCount />
                </Form.Item>
                <Form.Item
                  name={['i18n', l.value, 'description']}
                  label={t.labels.description}
                  extra={t.labels.descriptionHelp}
                  dependencies={descs.filter((n) => n[1] !== l.value)}
                  rules={[anyFilled('description', t.labels.descriptionRequired)]}
                >
                  <Input.TextArea
                    maxLength={200}
                    autoSize={{ minRows: 2, maxRows: 5 }}
                    placeholder={l.value === locale ? t.labels.descriptionPlaceholder : undefined}
                  />
                </Form.Item>
              </>
            ),
          }))}
        />
        <Form.Item name="color" label={t.labels.color}>
          <ColorChoice />
        </Form.Item>
        {withPinned && (
          <Form.Item name="pinned" label={t.labels.pinned} valuePropName="checked">
            <Switch />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}

export function LabelsPage() {
  useLocale();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [editing, setEditing] = useState<LabelAdmin | 'new' | null>(null);
  const [renaming, setRenaming] = useState<LabelSuggestion | null>(null);
  const [view, setView] = useState<'mine' | 'system'>('mine');

  const categories = useCategories();
  const stats = useStats();
  const labels = useQuery({ queryKey: ['labels', 'admin'], queryFn: () => api<AdminList>('/api/admin/labels') });
  const sugg = useQuery({
    queryKey: ['label-suggestions'],
    queryFn: () => api<SuggestList>('/api/admin/label-suggestions'),
    // 推荐进行中时轮询
    refetchInterval: (q) => (q.state.data?.run && ['queued', 'running'].includes(q.state.data.run.status) ? 3000 : false),
  });

  const refreshLabels = () => {
    qc.invalidateQueries({ queryKey: ['labels'] });
    qc.invalidateQueries({ queryKey: ['stats'] });
    qc.invalidateQueries({ queryKey: ['threads'] });
  };

  const run = sugg.data?.run ?? null;
  const running = !!run && (run.status === 'queued' || run.status === 'running');
  const suggestions = sugg.data?.suggestions ?? [];
  const items = labels.data?.items ?? [];
  const limit = labels.data?.limit ?? 50;
  const cats = categories.data ?? [];

  // 侧栏标签右键「编辑」跳过来时带 ?edit=<id>：直接打开编辑框，然后去掉参数
  const [params, setParams] = useSearchParams();
  const editId = Number(params.get('edit'));
  useEffect(() => {
    if (!editId || !labels.data) return;
    const l = labels.data.items.find((x) => x.id === editId);
    if (l) setEditing(l);
    setParams(
      (p) => {
        p.delete('edit');
        return p;
      },
      { replace: true },
    );
  }, [editId, labels.data, setParams]);

  const start = async () => {
    setStarting(true);
    try {
      await api('/api/admin/label-suggestions/run', { method: 'POST' });
      message.success(t.labels.started);
      await qc.invalidateQueries({ queryKey: ['label-suggestions'] });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const accept = async (s: LabelSuggestion, body: { i18n?: I18n<Partial<LabelText>>; color?: string; mergeInto?: number } = {}) => {
    setBusy(s.id);
    try {
      const res = await api<{ label: LabelAdmin; labeled: number }>(`/api/admin/label-suggestions/${s.id}/accept`, { method: 'POST', body });
      message.success(t.labels.accepted(textOf(res.label.i18n).name, res.labeled));
      setRenaming(null);
      await qc.invalidateQueries({ queryKey: ['label-suggestions'] });
      refreshLabels();
    } catch (e) {
      // 任何一种语言的名称和已有标签（任何一种语言）重名：可以合并到已有标签，或者改名后再采用
      const wanted = new Set(allNames(body.i18n ?? s.i18n));
      const existing = items.find((l) => allNames(l.i18n).some((n) => wanted.has(n)));
      if (e instanceof ApiError && e.status === 409 && existing) {
        modal.confirm({
          title: t.labels.conflictTitle(textOf(existing.i18n).name),
          content: t.labels.conflictDesc,
          okText: t.labels.merge,
          cancelText: t.labels.rename,
          onOk: () => accept(s, { mergeInto: existing.id }),
          onCancel: () => setRenaming(s),
        });
      } else {
        message.error((e as Error).message);
      }
      throw e;
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async (s: LabelSuggestion) => {
    setBusy(s.id);
    try {
      await api(`/api/admin/label-suggestions/${s.id}/dismiss`, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['label-suggestions'] });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveLabel = async (v: LabelForm) => {
    try {
      if (editing === 'new') await api('/api/admin/labels', { method: 'POST', body: v });
      else if (editing) await api(`/api/admin/labels/${editing.id}`, { method: 'PATCH', body: v });
      setEditing(null);
      refreshLabels();
    } catch (e) {
      message.error((e as Error).message);
      throw e;
    }
  };

  const setPinned = async (l: LabelAdmin, pinned: boolean) => {
    try {
      await api(`/api/admin/labels/${l.id}`, { method: 'PATCH', body: { pinned } });
      refreshLabels();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const backfill = async (l: LabelAdmin) => {
    try {
      const res = await api<{ queued: number }>(`/api/admin/labels/${l.id}/backfill`, { method: 'POST', body: { days: 30 } });
      message.success(t.labels.backfillQueued(res.queued));
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const remove = async (l: LabelAdmin) => {
    try {
      const res = await api<{ rules: Array<{ id: number; name: string }> }>(`/api/admin/labels/${l.id}`, { method: 'DELETE' });
      if (res.rules.length) message.warning(t.labels.deletedWithRules(res.rules.map((r) => r.name)), 8);
      refreshLabels();
      qc.invalidateQueries({ queryKey: ['rules'] });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const runAlert = (() => {
    if (running) return <Alert type="info" showIcon icon={<LoadingOutlined />} title={t.labels.running(sugg.data?.days ?? 90)} />;
    if (!run) return null;
    if (run.status === 'failed') return <Alert type="error" showIcon title={t.labels.failed} description={run.error} />;
    if (run.tooFew) return <Alert type="info" showIcon title={t.labels.tooFew} />;
    return null;
  })();

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Flex align="center" justify="space-between" gap={16} wrap>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t.labels.title}
          </Typography.Title>
          <Typography.Text type="secondary">{t.labels.desc}</Typography.Text>
        </div>
        <Flex vertical align="end" gap={4}>
          <Space>
            <Button icon={<PlusOutlined />} disabled={items.length >= limit} onClick={() => setEditing('new')}>
              {t.labels.createManual}
            </Button>
            <Button type="primary" icon={<BulbOutlined />} loading={starting || running} onClick={start}>
              {run ? t.labels.suggestAgain : t.labels.suggest}
            </Button>
          </Space>
          {run && !running && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <HistoryOutlined /> {t.labels.lastRun(fromNow(run.finishedAt ?? run.createdAt))}
            </Typography.Text>
          )}
        </Flex>
      </Flex>

      {runAlert}

      {suggestions.length > 0 && (
        <>
          <Typography.Title level={5} style={{ margin: 0 }}>
            {t.labels.suggestions(suggestions.length)}
          </Typography.Title>
          <div className="label-suggestions">
            {suggestions.map((s) => {
              const text = textOf(s.i18n);
              const reason = pickText(Object.fromEntries(Object.entries(s.i18n).map(([l, v]) => [l, v?.reason ?? ''])) as I18n<string>);
              return (
                <Card key={s.id} size="small">
                  <Flex vertical gap={8}>
                    <Flex align="center" justify="space-between" gap={8}>
                      <Tooltip title={otherNames(s.i18n, text.name)} styles={{ container: { whiteSpace: 'pre-line' } }}>
                        <Tag color={s.color} style={{ fontSize: 14, padding: '2px 8px', marginInlineEnd: 0 }}>
                          {text.name}
                        </Tag>
                      </Tooltip>
                      <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
                        {t.labels.covers(s.count)}
                      </Typography.Text>
                    </Flex>
                    <Typography.Paragraph style={{ margin: 0 }}>{text.description}</Typography.Paragraph>
                    {reason && (
                      <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
                        {reason}
                      </Typography.Paragraph>
                    )}
                    {s.examples.length > 0 && (
                      <div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {t.labels.examples}
                        </Typography.Text>
                        <ul className="label-examples">
                          {s.examples.map((m) => (
                            <li key={m.id}>
                              <Link to={threadUrl(m.threadId)} className="ellipsis" title={m.subject}>
                                {m.subject || t.threads.noSubject}
                              </Link>
                              <Typography.Text type="secondary" className="ellipsis" style={{ fontSize: 12 }}>
                                {m.from}
                              </Typography.Text>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <Space size={8} wrap className="label-suggestion-actions">
                      <Button type="primary" size="small" loading={busy === s.id} onClick={() => accept(s).catch(() => {})}>
                        {t.labels.accept}
                      </Button>
                      <Button size="small" disabled={busy === s.id} onClick={() => setRenaming(s)}>
                        {t.labels.rename}
                      </Button>
                      <Button size="small" type="text" disabled={busy === s.id} onClick={() => dismiss(s)}>
                        {t.labels.dismiss}
                      </Button>
                    </Space>
                  </Flex>
                </Card>
              );
            })}
          </div>
        </>
      )}

      <Tabs
        activeKey={view}
        onChange={(k) => setView(k as 'mine' | 'system')}
        styles={{ header: { marginBottom: 0 }, body: { display: 'none' } }}
        items={[
          { key: 'mine', label: t.labels.tabMine(items.length, limit) },
          { key: 'system', label: t.labels.tabSystem(cats.length) },
        ]}
        tabBarExtraContent={
          view === 'system' && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <LockOutlined /> {t.labels.systemReadonly}
            </Typography.Text>
          )
        }
      />
      <TableFill key={view}>
        {(y) =>
          view === 'mine' ? (
            <Table<LabelAdmin>
              rowKey="id"
              bordered
              loading={labels.isLoading}
              dataSource={items}
              pagination={false}
              scroll={{ x: 880, y }}
              locale={{ emptyText: <Empty description={t.labels.empty} /> }}
              columns={[
                {
                  title: t.labels.name,
                  key: 'name',
                  width: 160,
                  render: (_, l) => <NameTag i18n={l.i18n} color={l.color} />,
                },
                {
                  title: t.labels.description,
                  key: 'description',
                  render: (_, l) => <Typography.Text style={{ fontSize: 13 }}>{textOf(l.i18n).description}</Typography.Text>,
                },
                {
                  title: t.labels.source,
                  key: 'source',
                  width: 120,
                  render: (_, l) => (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {l.source === 'suggested' ? t.labels.sourceSuggested : t.labels.sourceManual}
                    </Typography.Text>
                  ),
                },
                {
                  title: t.labels.count,
                  dataIndex: 'total',
                  width: 90,
                  align: 'right',
                  render: (n: number, l) => <Link to={labelUrl(textOf(l.i18n).name)}>{fmt(n)}</Link>,
                },
                {
                  title: t.labels.pinned,
                  dataIndex: 'pinned',
                  width: 120,
                  align: 'center',
                  render: (v: boolean, l) => <Switch size="small" checked={v} onChange={(c) => setPinned(l, c)} />,
                },
                {
                  key: 'actions',
                  width: 200,
                  render: (_, l) => (
                    <Space size={0}>
                      <Button type="link" size="small" icon={<EditOutlined />} aria-label={t.labels.edit} onClick={() => setEditing(l)} />
                      <Popconfirm title={t.labels.backfillTitle} description={t.labels.backfillDesc} onConfirm={() => backfill(l)}>
                        <Button type="link" size="small">
                          {t.labels.backfill}
                        </Button>
                      </Popconfirm>
                      <Popconfirm title={t.labels.deleteTitle} description={t.labels.deleteDesc} okButtonProps={{ danger: true }} onConfirm={() => remove(l)}>
                        <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          ) : (
            <Table<Category>
              rowKey="key"
              bordered
              loading={categories.isLoading}
              dataSource={cats}
              pagination={false}
              scroll={{ x: 640, y }}
              columns={[
                {
                  title: t.labels.name,
                  key: 'name',
                  width: 160,
                  render: (_, c) => <NameTag i18n={c.i18n} color={c.color} />,
                },
                {
                  title: t.labels.description,
                  key: 'description',
                  render: (_, c) => <Typography.Text style={{ fontSize: 13 }}>{textOf(c.i18n).description}</Typography.Text>,
                },
                {
                  title: t.labels.count,
                  key: 'total',
                  width: 90,
                  align: 'right',
                  render: (_, c) => <Link to={categoryUrl(c.key)}>{fmt(stats.data?.categories[c.key]?.total ?? 0)}</Link>,
                },
              ]}
            />
          )
        }
      </TableFill>

      <LabelModal
        open={editing !== null}
        title={editing === 'new' ? t.labels.create : t.labels.edit}
        initial={editing && editing !== 'new' ? { i18n: editing.i18n, color: editing.color, pinned: editing.pinned } : {}}
        withPinned
        onCancel={() => setEditing(null)}
        onSubmit={saveLabel}
      />
      <LabelModal
        open={renaming !== null}
        title={t.labels.rename}
        initial={renaming ? { i18n: stripReason(renaming.i18n), color: renaming.color } : {}}
        withPinned={false}
        onCancel={() => setRenaming(null)}
        onSubmit={(v) => accept(renaming!, { i18n: v.i18n, color: v.color })}
      />
    </div>
  );
}
