import { HistoryOutlined, LoadingOutlined, LockOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Flex, Form, InputNumber, Progress, Space, Spin, Switch, Tag, Typography, theme } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, type IgnoredSender } from '../../api';
import { AccountScope, accountScopeRule } from '../../components/AccountScope';
import { intlLocale, t } from '../../i18n';

type Analysis = {
  enabled: boolean;
  accountIds: number[] | null;
  ai: { enabled: boolean; hasApiKey: boolean; model: string; channelName: string | null };
  accounts: Array<{ accountId: number; inbox: number; analyzed: number }>;
  last24h: number;
  queued: number;
};

type FormValues = { enabled: boolean; accountIds: number[] | null };

const fmt = (n: number) => n.toLocaleString(intlLocale());
const IGNORED_PREVIEW = 6;

/** 设置行：左边标题和说明，右边控件；窄屏上下排 */
function SettingRow({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div>
        <Typography.Text strong>{title}</Typography.Text>
        {desc && (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '2px 0 0' }}>
            {desc}
          </Typography.Paragraph>
        )}
      </div>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

function Metric({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <div className="analysis-metric">
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
      <div className="analysis-metric-value">{value}</div>
      {children}
    </div>
  );
}

export function AnalysisPage() {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const qc = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const enabled = Form.useWatch('enabled', form) ?? true;
  // null 表示全部邮箱，数组表示指定邮箱（约定见 AccountScope）
  const accountIds: number[] | null | undefined = Form.useWatch('accountIds', form);
  const scope = Array.isArray(accountIds) ? 'some' : 'all';
  const [saving, setSaving] = useState(false);
  const [backfill, setBackfill] = useState(100);
  const [queuing, setQueuing] = useState(false);

  const ignored = useQuery({ queryKey: ['contacts', 'ignored'], queryFn: () => api<IgnoredSender[]>('/api/admin/ignored-senders') });
  const data = useQuery({
    queryKey: ['ai-analysis'],
    queryFn: () => api<Analysis>('/api/admin/ai/analysis'),
    // 队列里有任务时刷新进度
    refetchInterval: (q) => (q.state.data?.queued ? 3000 : false),
  });

  // 只在第一次加载时填表单，之后轮询进度不覆盖正在编辑的内容
  const loaded = !!data.data;
  useEffect(() => {
    if (!loaded) return;
    const d = qc.getQueryData<Analysis>(['ai-analysis'])!;
    form.setFieldsValue({ enabled: d.enabled, accountIds: d.accountIds?.length ? d.accountIds : null });
  }, [loaded, form, qc]);

  if (data.isPending) return <Spin style={{ margin: 48 }} />;
  if (data.isError) return <Alert type="error" showIcon title={t.analysis.loadFailed} description={data.error.message} style={{ margin: 24 }} />;
  const d = data.data;
  const aiReady = d.ai.enabled && d.ai.hasApiKey;

  const coverage = new Map(d.accounts.map((a) => [a.accountId, a]));
  const inScope = d.accounts.filter((a) => !accountIds || accountIds.includes(a.accountId));
  const inbox = inScope.reduce((n, a) => n + a.inbox, 0);
  const analyzed = inScope.reduce((n, a) => n + a.analyzed, 0);
  const pending = inbox - analyzed;

  const save = async () => {
    const v = { ...(form.getFieldsValue(true) as FormValues), ...(await form.validateFields()) };
    setSaving(true);
    try {
      await api('/api/admin/ai/analysis', { method: 'PUT', body: { enabled: v.enabled, accountIds: v.accountIds ?? null } });
      message.success(t.common.saved);
      await qc.invalidateQueries({ queryKey: ['ai-analysis'] });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const runBackfill = async () => {
    setQueuing(true);
    try {
      const res = await api<{ queued: number }>('/api/admin/ai/backfill', {
        method: 'POST',
        body: { limit: backfill, ...(scope === 'some' ? { accountIds } : {}) },
      });
      message.success(res.queued ? t.analysis.queued(fmt(res.queued)) : t.analysis.allDone);
      await data.refetch();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setQueuing(false);
    }
  };

  return (
    <Form form={form} component={false} initialValues={{ enabled: true, accountIds: null }}>
      <div style={{ padding: 24, height: '100%', boxSizing: 'border-box', overflow: 'auto' }}>
        <Flex vertical gap={16}>
          <Flex align="center" justify="space-between" gap={16} wrap>
            <div>
              <Typography.Title level={4} style={{ margin: 0 }}>
                {t.analysis.title}
              </Typography.Title>
              <Typography.Text type="secondary">{t.analysis.desc}</Typography.Text>
            </div>
            <Button type="primary" loading={saving} onClick={save}>
              {t.analysis.saveSettings}
            </Button>
          </Flex>

          {!aiReady && (
            <Alert
              type="warning"
              showIcon
              title={d.ai.enabled ? t.analysis.noKey : t.analysis.aiDisabled}
              description={t.analysis.needModel}
              action={
                <Link to="/ai/models">
                  <Button size="small">{t.analysis.goModels}</Button>
                </Link>
              }
            />
          )}

          <Card size="small" title={t.analysis.progress}>
            <div className="analysis-metrics">
              <Metric
                label={scope === 'all' ? t.analysis.inboxAnalyzed : t.analysis.selectedAnalyzed}
                value={
                  <>
                    {fmt(analyzed)}
                    <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>
                      {t.analysis.ofTotal(fmt(inbox))}
                    </Typography.Text>
                  </>
                }
              >
                <Progress percent={inbox ? Math.floor((analyzed / inbox) * 100) : 0} size="small" showInfo={false} style={{ margin: 0 }} />
              </Metric>
              <Metric label={t.analysis.last24h} value={t.analysis.emails(fmt(d.last24h))} />
              <Metric
                label={t.analysis.inQueue}
                value={
                  <Space size={6}>
                    {d.queued > 0 && <LoadingOutlined style={{ fontSize: 14, color: token.colorPrimary }} />}
                    {t.analysis.emails(fmt(d.queued))}
                  </Space>
                }
              />
            </div>
          </Card>

          <Card size="small" title={t.analysis.auto} styles={{ body: { paddingBlock: 0 } }}>
            <div className="setting-rows">
              <SettingRow title={t.analysis.analyzeNew} desc={t.analysis.analyzeNewDesc}>
                <Flex vertical gap={10} align="flex-start">
                  <Form.Item name="enabled" valuePropName="checked" noStyle>
                    <Switch />
                  </Form.Item>
                  <Flex wrap gap={6}>
                    {t.analysis.capabilities.map((c) => (
                      <Tag key={c} style={{ marginInlineEnd: 0 }}>
                        {c}
                      </Tag>
                    ))}
                  </Flex>
                </Flex>
              </SettingRow>

              <SettingRow title={t.analysis.scope} desc={t.analysis.scopeDesc}>
                <Form.Item name="accountIds" rules={enabled ? [accountScopeRule] : []} style={{ marginBottom: 0 }}>
                  <AccountScope
                    disabled={!enabled}
                    maxRows={4}
                    showCount
                    // 右侧显示「已分析 / 收件箱」
                    count={(a) => {
                      const c = coverage.get(a.id);
                      return c && `${fmt(c.analyzed)}/${fmt(c.inbox)}`;
                    }}
                  />
                </Form.Item>
              </SettingRow>

              <SettingRow title={t.analysis.ignored} desc={t.analysis.ignoredDesc}>
                <Space size={8} wrap>
                  {(ignored.data ?? []).slice(0, IGNORED_PREVIEW).map((r) => (
                    <Tag key={r.pattern} style={{ marginInlineEnd: 0 }}>
                      {r.pattern}
                    </Tag>
                  ))}
                  {(ignored.data?.length ?? 0) > IGNORED_PREVIEW && (
                    <Typography.Text type="secondary">{t.analysis.andMore(ignored.data!.length)}</Typography.Text>
                  )}
                  {ignored.data?.length === 0 && <Typography.Text type="secondary">{t.analysis.none}</Typography.Text>}
                  <Link to="/contacts">{t.analysis.manageInContacts}</Link>
                </Space>
              </SettingRow>

              <SettingRow title={t.analysis.model} desc={t.analysis.modelDesc}>
                <Space size={8} wrap>
                  <Tag style={{ marginInlineEnd: 0 }}>{d.ai.model}</Tag>
                  {d.ai.channelName && <Typography.Text type="secondary">{d.ai.channelName}</Typography.Text>}
                  <Link to="/ai/models">{t.analysis.change}</Link>
                </Space>
              </SettingRow>
            </div>
          </Card>

          <Card size="small" title={t.analysis.backfill}>
            <Flex align="center" justify="space-between" gap={16} wrap>
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                {t.analysis.backfillDesc}
                {pending > 0 ? t.analysis.pendingLeft(scope === 'all', fmt(pending)) : t.analysis.allAnalyzed}
              </Typography.Text>
              <Space wrap>
                <InputNumber
                  min={1}
                  max={1000}
                  prefix={t.analysis.recent}
                  suffix={t.analysis.unit}
                  value={backfill}
                  onChange={(v) => setBackfill(v ?? 100)}
                  style={{ width: 150 }}
                />
                <Button icon={<HistoryOutlined />} loading={queuing} onClick={runBackfill} disabled={!aiReady || pending === 0}>
                  {t.analysis.start}
                </Button>
              </Space>
            </Flex>
          </Card>

          <Flex gap={8} align="flex-start" className="analysis-privacy">
            <LockOutlined style={{ marginTop: 3 }} />
            <span>{t.analysis.privacy}</span>
          </Flex>
        </Flex>
      </div>
    </Form>
  );
}
