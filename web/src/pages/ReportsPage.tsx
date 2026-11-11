import { BellOutlined, BulbOutlined, CalendarOutlined, DeleteOutlined, ReloadOutlined, ScheduleOutlined, SettingOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Flex,
  Form,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Skeleton,
  Switch,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, type Report, type ReportItem, type ReportKind, type ReportSettings, type ReportSummary } from '../api';
import { t } from '../i18n';
import { CATEGORY_META } from '../components/Insight';
import { BarList, ColumnChart, StatTile, useChartColors } from '../components/charts';
import { shortDate } from '../lib/format';
import { EmptyBlock } from '../components/EmptyBlock';

export function ReportsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [kind, setKind] = useState<ReportKind | 'all'>('all');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);

  const list = useQuery({
    queryKey: ['reports', kind],
    queryFn: () => api<ReportSummary[]>(`/api/v1/reports${kind === 'all' ? '' : `?kind=${kind}`}`),
  });

  // 没选中时打开最新一份
  useEffect(() => {
    if (!id && list.data?.[0]) navigate(`/reports/${list.data[0].id}`, { replace: true });
  }, [id, list.data, navigate]);

  return (
    <Flex className="reports-page" style={{ height: '100%' }}>
      <Flex
        vertical
        className="reports-side"
        style={{
          width: 280,
          flex: 'none',
          borderRight: '1px solid var(--ant-color-split)',
          minHeight: 0,
        }}
      >
        <Flex vertical gap={12} style={{ padding: '16px 16px 8px' }}>
          <Flex justify="space-between" align="center">
            <Typography.Title level={5} style={{ margin: 0 }}>
              {t.reports.title}
            </Typography.Title>
            <Flex gap={4}>
              <Tooltip title={t.reports.generate}>
                <Button size="small" type="text" icon={<ReloadOutlined />} aria-label={t.reports.generate} onClick={() => setGenerateOpen(true)} />
              </Tooltip>
              <Tooltip title={t.reports.settings}>
                <Button size="small" type="text" icon={<SettingOutlined />} aria-label={t.reports.settings} onClick={() => setSettingsOpen(true)} />
              </Tooltip>
            </Flex>
          </Flex>
          <Segmented
            block
            value={kind}
            onChange={(v) => setKind(v as typeof kind)}
            options={[
              { label: t.reports.all, value: 'all' },
              { label: t.reports.daily, value: 'daily' },
              { label: t.reports.weekly, value: 'weekly' },
            ]}
          />
        </Flex>
        <div style={{ flex: 1, overflow: 'auto', padding: '0 8px 16px' }}>
          {list.isPending ? (
            <Skeleton active style={{ padding: 8 }} />
          ) : list.data?.length ? (
            list.data.map((r) => (
              <div
                key={r.id}
                className={`report-item${String(r.id) === id ? ' active' : ''}`}
                onClick={() => navigate(`/reports/${r.id}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && navigate(`/reports/${r.id}`)}
              >
                <Flex justify="space-between" align="center" gap={8}>
                  <Typography.Text ellipsis strong={String(r.id) === id}>
                    {periodText(r)}
                  </Typography.Text>
                  <Tag color={r.kind === 'weekly' ? 'blue' : undefined} style={{ marginInlineEnd: 0 }}>
                    {r.kind === 'weekly' ? t.reports.weekly : t.reports.daily}
                  </Tag>
                </Flex>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t.reports.receivedN(r.received)}
                </Typography.Text>
              </div>
            ))
          ) : (
            <EmptyBlock description={t.reports.none}>
              <Button size="small" onClick={() => setGenerateOpen(true)}>
                {t.reports.generateNow}
              </Button>
            </EmptyBlock>
          )}
        </div>
      </Flex>
      <div className="reports-main" style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        {id ? <ReportDetail id={Number(id)} /> : !list.isPending && !list.data?.length ? <Intro /> : null}
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <GenerateModal open={generateOpen} onClose={() => setGenerateOpen(false)} />
    </Flex>
  );
}

function Intro() {
  return (
    <div style={{ padding: 48, maxWidth: 560 }}>
      <Typography.Title level={4}>{t.reports.introTitle}</Typography.Title>
      <Typography.Paragraph type="secondary">{t.reports.intro1}</Typography.Paragraph>
      <Typography.Paragraph type="secondary">{t.reports.intro2}</Typography.Paragraph>
    </div>
  );
}

function periodText(r: Pick<Report, 'kind' | 'periodStart' | 'periodEnd'>) {
  const start = dayjs(r.periodStart);
  const end = dayjs(r.periodEnd).subtract(1, 'ms');
  if (r.kind === 'daily') return `${start.format(t.reports.dateLong)} ${t.reports.weekdays[start.day()]}`;
  return `${start.format(t.reports.dateLong)} – ${end.format(start.year() === end.year() ? t.reports.dateShort : t.reports.dateLong)}`;
}

function ReportDetail({ id }: { id: number }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const colors = useChartColors();
  const report = useQuery({
    queryKey: ['report', id],
    queryFn: () => api<Report>(`/api/v1/reports/${id}`),
  });

  const regenerate = useMutation({
    mutationFn: (r: Report) =>
      api<Report>('/api/admin/reports/generate', {
        method: 'POST',
        body: { kind: r.kind, date: dayjs(r.periodStart).format('YYYY-MM-DD') },
      }),
    onSuccess: (r) => {
      qc.setQueryData(['report', r.id], r);
      void qc.invalidateQueries({ queryKey: ['reports'] });
      message.success(t.reports.regenerated);
    },
    onError: (e) => message.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/admin/reports/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['reports'] });
      navigate('/reports', { replace: true });
    },
    onError: (e) => message.error(e.message),
  });

  if (report.isPending) return <Skeleton active style={{ padding: 24 }} />;
  if (report.isError) return <Alert type="error" showIcon title={report.error.message} style={{ margin: 24 }} />;
  const r = report.data;
  const d = r.data;
  const partial = new Date(d.until) < new Date(r.periodEnd);
  const prevLabel = r.kind === 'daily' ? t.reports.vsYesterday : t.reports.vsLastWeek;
  const openThread = (threadId: string) => navigate(`/mail?view=all&thread=${encodeURIComponent(threadId)}`);

  return (
    <div style={{ padding: 24, boxSizing: 'border-box' }}>
      <Flex justify="space-between" align="start" gap={16} wrap style={{ marginBottom: 16 }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {r.kind === 'weekly' ? t.reports.weekly : t.reports.daily} · {periodText(r)}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {t.reports.generatedAt(dayjs(r.createdAt).format(t.reports.dateTime))}
            {partial && t.reports.partial(dayjs(d.until).format(t.reports.dateTime))}
          </Typography.Text>
        </div>
        <Flex gap={8}>
          <Button icon={<ReloadOutlined />} loading={regenerate.isPending} onClick={() => regenerate.mutate(r)}>
            {t.reports.regenerate}
          </Button>
          <Popconfirm title={t.reports.deleteTitle} okText={t.common.delete} okButtonProps={{ danger: true }} onConfirm={() => remove.mutate()}>
            <Button icon={<DeleteOutlined />} aria-label={t.reports.deleteReport} />
          </Popconfirm>
        </Flex>
      </Flex>

      {(r.summary || r.summaryError) && (
        <Card size="small" title={t.reports.aiBrief} style={{ marginBottom: 16 }}>
          {r.summary ? <Summary text={r.summary} /> : <Typography.Text type="secondary">{t.reports.aiBriefFailed(r.summaryError)}</Typography.Text>}
        </Card>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <StatTile
          title={t.reports.received}
          value={d.received}
          prev={d.receivedPrev}
          suffix={t.reports.unit}
          hint={t.reports.prevHint(prevLabel, d.receivedPrev)}
        />
        <StatTile title={t.reports.important} value={d.important.length} suffix={t.reports.unit} />
        <StatTile title={t.reports.needsReply} value={d.needsReply.length} suffix={t.reports.unit} />
        <StatTile title={t.reports.sent} value={d.sent} suffix={t.reports.unit} />
        <StatTile title={t.reports.inboxUnread} value={d.unreadNow} suffix={t.reports.unit} hint={t.reports.unreadHint} />
      </div>

      {r.kind === 'weekly' && d.byDay.length > 1 && (
        <Card size="small" title={t.reports.daily_} style={{ marginBottom: 16 }}>
          <ColumnChart
            series={[
              { name: t.reports.received, color: colors.s1 },
              { name: t.reports.sent, color: colors.s2 },
            ]}
            data={d.byDay.map((x) => {
              const day = dayjs(x.date);
              return {
                label: t.reports.weekdays[day.day()]!,
                hint: `${day.format(t.reports.dateShort)} ${t.reports.weekdays[day.day()]}`,
                values: [x.received, x.sent],
              };
            })}
          />
        </Card>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          alignItems: 'start',
          gap: 16,
          marginBottom: 16,
        }}
      >
        <ItemCard title={t.reports.needsReplyCard} items={d.needsReply} onOpen={openThread} empty={t.reports.needsReplyEmpty} />
        <ItemCard title={t.reports.importantCard} items={d.important} onOpen={openThread} empty={t.reports.importantEmpty} />
      </div>

      {d.bills.length > 0 && (
        <Card size="small" title={t.reports.bills} style={{ marginBottom: 16 }}>
          {d.bills.map((b) => (
            <div
              key={b.id}
              className="report-row"
              role="button"
              tabIndex={0}
              onClick={() => openThread(b.threadId)}
              onKeyDown={(e) => e.key === 'Enter' && openThread(b.threadId)}
            >
              <Flex justify="space-between" gap={12} style={{ width: '100%' }}>
                <div style={{ minWidth: 0 }}>
                  <Typography.Text ellipsis style={{ display: 'block' }}>
                    {b.subject}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {b.from}
                  </Typography.Text>
                </div>
                <Flex vertical align="end" style={{ flex: 'none' }}>
                  {b.amount && <Typography.Text strong>{b.amount}</Typography.Text>}
                  {b.dueDate && (
                    <Typography.Text type={dayjs(b.dueDate).isBefore(dayjs().add(3, 'day')) ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
                      {t.reports.dueOn(b.dueDate)}
                    </Typography.Text>
                  )}
                </Flex>
              </Flex>
            </div>
          ))}
        </Card>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          alignItems: 'start',
          gap: 16,
        }}
      >
        <Card size="small" title={t.reports.categories}>
          <BarList
            total={d.analyzed || undefined}
            items={d.byCategory.map((c) => ({
              key: c.category,
              label: CATEGORY_META[c.category]?.label ?? c.label,
              value: c.count,
            }))}
            empty={t.reports.noAnalysis}
          />
        </Card>
        <Card size="small" title={t.reports.topSenders}>
          <BarList
            items={d.topSenders.map((s) => ({
              key: s.address,
              label: s.name || s.address,
              value: s.count,
              hint: s.address,
            }))}
          />
        </Card>
        <Card size="small" title={t.reports.byAccount}>
          <BarList
            items={d.byAccount.map((a) => ({
              key: String(a.accountId),
              label: a.name,
              value: a.received,
              hint: a.email,
            }))}
          />
        </Card>
      </div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 16 }}>
        {t.reports.footnote(d.verificationCount, d.drafts.sent, d.drafts.failed, d.drafts.pending)}
      </Typography.Paragraph>
    </div>
  );
}

export function Summary({ text }: { text: string }) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const bullets = lines.every((l) => /^[-*•]\s/.test(l));
  if (!bullets) return <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{text}</Typography.Paragraph>;
  return (
    <ul style={{ margin: 0, paddingInlineStart: 20, lineHeight: 1.8 }}>
      {lines.map((l, i) => (
        <li key={i}>{l.replace(/^[-*•]\s+/, '')}</li>
      ))}
    </ul>
  );
}

function ItemCard({ title, items, onOpen, empty }: { title: string; items: ReportItem[]; onOpen: (threadId: string) => void; empty: string }) {
  return (
    <Card size="small" title={`${title}${items.length ? ` · ${items.length}` : ''}`} styles={{ body: { paddingBlock: 4 } }}>
      {items.length ? (
        items.map((i) => (
          <div
            key={i.id}
            className="report-row"
            role="button"
            tabIndex={0}
            onClick={() => onOpen(i.threadId)}
            onKeyDown={(e) => e.key === 'Enter' && onOpen(i.threadId)}
          >
            <div style={{ minWidth: 0, width: '100%' }}>
              <Flex justify="space-between" gap={8}>
                <Typography.Text ellipsis strong>
                  {i.subject || t.reports.noSubject}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12, flex: 'none' }}>
                  {shortDate(i.date)}
                </Typography.Text>
              </Flex>
              <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>
                {i.from}
                {i.summary ? ` · ${i.summary}` : ''}
              </Typography.Text>
            </div>
          </div>
        ))
      ) : (
        <EmptyBlock description={empty} minHeight={120} />
      )}
    </Card>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => ({
  label: `${String(h).padStart(2, '0')}:00`,
  value: h,
}));

function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<ReportSettings>();
  const settings = useQuery({
    queryKey: ['report-settings'],
    queryFn: () => api<ReportSettings>('/api/admin/reports/settings'),
    enabled: open,
  });
  const save = useMutation({
    mutationFn: (v: ReportSettings) =>
      api<ReportSettings>('/api/admin/reports/settings', {
        method: 'PUT',
        body: v,
      }),
    onSuccess: (v) => {
      qc.setQueryData(['report-settings'], v);
      message.success(t.common.saved);
      onClose();
    },
    onError: (e) => message.error(e.message),
  });
  useEffect(() => {
    if (open && settings.data) form.setFieldsValue(settings.data);
  }, [open, settings.data, form]);

  const daily = Form.useWatch(['daily'], form);
  const weekly = Form.useWatch(['weekly'], form);
  const aiOn = Form.useWatch('aiSummary', form);
  const at = (h?: number) => HOURS[h ?? 0]?.label;

  return (
    <Modal
      title={t.reports.settings}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={t.common.save}
      confirmLoading={save.isPending}
      width={520}
      destroyOnHidden
    >
      {settings.isPending ? (
        <Skeleton active />
      ) : (
        <Form form={form} onFinish={(v) => save.mutate(v)} className="report-settings">
          <div className="pref-list">
            <SettingRow
              icon={<CalendarOutlined />}
              tone="blue"
              title={t.reports.dailyRow}
              desc={daily?.enabled ? t.reports.dailyDesc(at(daily.hour)!) : t.reports.off}
            >
              <Form.Item name={['daily', 'hour']} noStyle>
                <Select options={HOURS} disabled={!daily?.enabled} style={{ width: 92 }} aria-label={t.reports.dailyTime} />
              </Form.Item>
              <Form.Item name={['daily', 'enabled']} valuePropName="checked" noStyle>
                <Switch aria-label={t.reports.dailyRow} />
              </Form.Item>
            </SettingRow>
            <SettingRow
              icon={<ScheduleOutlined />}
              tone="purple"
              title={t.reports.weeklyRow}
              desc={weekly?.enabled ? t.reports.weeklyDesc(at(weekly.hour)!) : t.reports.off}
            >
              <Form.Item name={['weekly', 'hour']} noStyle>
                <Select options={HOURS} disabled={!weekly?.enabled} style={{ width: 92 }} aria-label={t.reports.weeklyTime} />
              </Form.Item>
              <Form.Item name={['weekly', 'enabled']} valuePropName="checked" noStyle>
                <Switch aria-label={t.reports.weeklyRow} />
              </Form.Item>
            </SettingRow>
            <SettingRow
              icon={<BulbOutlined />}
              tone="gold"
              title={t.reports.aiBrief}
              desc={
                aiOn ? (
                  <>
                    {t.reports.aiDesc[0]}
                    <Link to="/ai/models">{t.reports.aiDesc[1]}</Link>
                    {t.reports.aiDesc[2]}
                  </>
                ) : (
                  t.reports.aiOff
                )
              }
            >
              <Form.Item name="aiSummary" valuePropName="checked" noStyle>
                <Switch aria-label={t.reports.aiBrief} />
              </Form.Item>
            </SettingRow>
          </div>
          <Flex gap={8} align="flex-start" className="pref-hint">
            <BellOutlined style={{ marginTop: 3 }} />
            <span>
              {t.reports.pushHint[0]}
              <Link to="/ai/channels">{t.reports.pushHint[1]}</Link>
              {t.reports.pushHint[2]}
            </span>
          </Flex>
        </Form>
      )}
    </Modal>
  );
}

type Tone = 'blue' | 'purple' | 'gold';

/** 带浅色底的圆角图标 */
function ToneIcon({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const { token } = theme.useToken();
  const [bg, fg] = { blue: [token.blue1, token.blue6], purple: [token.purple1, token.purple6], gold: [token.gold1, token.gold6] }[tone];
  return (
    <span className="pref-icon" style={{ background: bg, color: fg }}>
      {children}
    </span>
  );
}

/** 设置列表的一行：左边图标、标题、说明，右边控件 */
function SettingRow({
  icon,
  tone,
  title,
  desc,
  children,
}: {
  icon: React.ReactNode;
  tone: Tone;
  title: string;
  desc: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Flex align="center" gap={12} className="pref-row">
      <ToneIcon tone={tone}>{icon}</ToneIcon>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="pref-title">{title}</div>
        <div className="pref-desc">{desc}</div>
      </div>
      <Flex align="center" gap={12} style={{ flex: 'none' }}>
        {children}
      </Flex>
    </Flex>
  );
}

function GenerateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [kind, setKind] = useState<ReportKind>('daily');
  const [date, setDate] = useState(() => dayjs().subtract(1, 'day'));
  const generate = useMutation({
    mutationFn: () =>
      api<Report>('/api/admin/reports/generate', {
        method: 'POST',
        body: { kind, date: date.format('YYYY-MM-DD') },
      }),
    onSuccess: async (r) => {
      qc.setQueryData(['report', r.id], r);
      await qc.invalidateQueries({ queryKey: ['reports'] });
      navigate(`/reports/${r.id}`);
      onClose();
    },
    onError: (e) => message.error(e.message),
  });
  // 周从周一开始，和服务端 periodOf 一致
  const start = kind === 'daily' ? date.startOf('day') : date.startOf('day').subtract((date.day() + 6) % 7, 'day');
  const end = start.add(kind === 'daily' ? 1 : 7, 'day');
  const ongoing = end.isAfter(dayjs());
  const existing = useQuery({ queryKey: ['reports', 'all'], queryFn: () => api<ReportSummary[]>('/api/v1/reports'), enabled: open });
  const overwrite = existing.data?.some((r) => r.kind === kind && dayjs(r.periodStart).isSame(start, 'day'));
  const md = (d: dayjs.Dayjs) => t.reports.monthDay(d.month() + 1, d.date());
  const range = kind === 'daily' ? `${md(start)} ${t.reports.weekdays[start.day()]}` : `${md(start)} – ${md(end.subtract(1, 'day'))}`;
  const quick =
    kind === 'daily'
      ? [
          { label: t.reports.yesterday, value: dayjs().subtract(1, 'day') },
          { label: t.reports.today, value: dayjs() },
        ]
      : [
          { label: t.reports.lastWeek, value: dayjs().subtract(7, 'day') },
          { label: t.reports.thisWeek, value: dayjs() },
        ];
  const sameAsQuick = (d: dayjs.Dayjs) => (kind === 'daily' ? d.isSame(date, 'day') : d.subtract((d.day() + 6) % 7, 'day').isSame(start, 'day'));
  const pickKind = (k: ReportKind) => {
    setKind(k);
    setDate(dayjs().subtract(k === 'daily' ? 1 : 7, 'day'));
  };

  return (
    <Modal
      title={t.reports.generate}
      open={open}
      onCancel={onClose}
      onOk={() => generate.mutate()}
      okText={t.reports.generateOk}
      confirmLoading={generate.isPending}
      width={480}
    >
      <div className="gen-kinds" role="radiogroup" aria-label={t.reports.kind}>
        {(
          [
            { k: 'daily', icon: <CalendarOutlined />, tone: 'blue', title: t.reports.daily, desc: t.reports.dailyCardDesc },
            { k: 'weekly', icon: <ScheduleOutlined />, tone: 'purple', title: t.reports.weekly, desc: t.reports.weeklyCardDesc },
          ] as const
        ).map((o) => (
          <button
            key={o.k}
            type="button"
            role="radio"
            aria-checked={kind === o.k}
            className={`gen-kind${kind === o.k ? ' on' : ''}`}
            onClick={() => pickKind(o.k)}
          >
            <ToneIcon tone={o.tone}>{o.icon}</ToneIcon>
            <span>
              <span className="pref-title">{o.title}</span>
              <span className="pref-desc">{o.desc}</span>
            </span>
          </button>
        ))}
      </div>
      <Flex align="center" justify="space-between" style={{ margin: '20px 0 8px' }}>
        <Typography.Text strong>{kind === 'daily' ? t.reports.whichDay : t.reports.whichWeek}</Typography.Text>
        <Flex gap={4}>
          {quick.map((q) => (
            <Tag.CheckableTag key={q.label} checked={sameAsQuick(q.value)} onChange={() => setDate(q.value)} style={{ marginInlineEnd: 0 }}>
              {q.label}
            </Tag.CheckableTag>
          ))}
        </Flex>
      </Flex>
      <DatePicker
        value={date}
        onChange={(v) => v && setDate(v)}
        picker={kind === 'weekly' ? 'week' : 'date'}
        format={() =>
          kind === 'weekly'
            ? `${start.format('YYYY-MM-DD')} ~ ${end.subtract(1, 'day').format('YYYY-MM-DD')}`
            : `${start.format('YYYY-MM-DD')} ${t.reports.weekdays[start.day()]}`
        }
        disabledDate={(d) => d.isAfter(dayjs(), 'day')}
        allowClear={false}
        style={{ width: '100%' }}
      />
      <Flex vertical gap={4} className={`pref-hint${overwrite ? ' warn' : ''}`}>
        <span>
          {t.reports.willSummarize[0]}
          <b>{range}</b>
          {t.reports.willSummarize[1]}
          {ongoing && t.reports.ongoing}
          {t.reports.period}
        </span>
        {overwrite && <span>{t.reports.overwrite}</span>}
      </Flex>
    </Modal>
  );
}
