import { ReloadOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Flex, Segmented, Select, Skeleton, Table, Tag, Tooltip, Typography } from 'antd';
import dayjs from 'dayjs';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, type AiChannel, type AiPurpose, type AiSettings, type AiRequestRow, type AiStats, type AiStatsRange, type AiUsageAgg } from '../../api';
import { BarList, ColumnChart, StatTile, useChartColors } from '../../components/charts';
import { TableFill } from '../../components/TableFill';
import { DEFAULT_PAGE_SIZE, Paging } from '../../components/Paging';
import { intlLocale, t } from '../../i18n';

/** 用途的名字，按当前界面语言取 */
export const purposeLabel = (p: string) => t.aiUsage.purpose[p] ?? p;
const PURPOSES: AiPurpose[] = ['classify', 'reply', 'report', 'search', 'title', 'assistant', 'translate', 'labels', 'test'];

const num = (v: number) => v.toLocaleString(intlLocale());
const tokens = (v: number | null) => (v === null ? <Typography.Text type="secondary">-</Typography.Text> : num(v));
const seconds = (ms: number) => t.aiUsage.seconds((ms / 1000).toFixed(1));

/** 美元金额：很小的金额保留有效数字，避免全显示成 $0.00 */
export function formatCost(v: number | null) {
  if (v === null) return '-';
  if (v === 0) return '$0';
  if (v < 0.0001) return '<$0.0001';
  if (v < 0.01) return `$${Number(v.toPrecision(2))}`;
  return `$${v.toFixed(v < 100 ? 4 : 2).replace(/\.?0+$/, '')}`;
}

type Filter = { purpose?: AiPurpose; model?: string; channelId?: string; status?: 'ok' | 'error' };

/** 页面外框：标题和说明；scroll 时内容区自己滚动，否则交给内容撑满剩余高度（请求表格要靠它算出滚动高度） */
function PageFrame({ title, desc, scroll, children }: { title: string; desc: string; scroll?: boolean; children: ReactNode }) {
  return (
    <div style={{ padding: 24, height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        <Typography.Text type="secondary">{desc}</Typography.Text>
      </div>
      {scroll ? <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</div> : children}
    </div>
  );
}

/** 请求记录页 */
export function AiRequestsPage() {
  // 渠道下拉用已保存的渠道，和模型配置页共用同一份缓存
  const settings = useQuery({ queryKey: ['ai-settings'], queryFn: () => api<AiSettings>('/api/admin/ai') });
  return (
    <PageFrame title={t.aiUsage.requestsTitle} desc={t.aiUsage.requestsDesc}>
      <AiRequests channels={settings.data?.channels ?? []} />
    </PageFrame>
  );
}

/** 用量统计页 */
export function AiStatsPage() {
  return (
    <PageFrame title={t.aiUsage.statsTitle} desc={t.aiUsage.statsDesc} scroll>
      <AiStats />
    </PageFrame>
  );
}

/** 请求：每一次模型调用的记录，最新的在前 */
function AiRequests({ channels }: { channels: AiChannel[] }) {
  const [filter, setFilter] = useState<Filter>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  for (const [k, v] of Object.entries(filter)) if (v) qs.set(k, v);
  const q = useQuery({
    queryKey: ['ai-requests', filter, page, pageSize],
    queryFn: () => api<{ items: AiRequestRow[]; total: number; models: string[] }>(`/api/admin/ai/requests?${qs}`),
    placeholderData: (prev) => prev,
  });
  const set = (patch: Filter) => {
    setFilter({ ...filter, ...patch });
    setPage(1);
  };

  return (
    <>
      <Flex gap={8} wrap align="center" style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder={t.aiUsage.allPurposes}
          style={{ width: 160 }}
          value={filter.purpose}
          onChange={(v) => set({ purpose: v })}
          options={PURPOSES.map((value) => ({ value, label: purposeLabel(value) }))}
        />
        <Select
          allowClear
          showSearch
          placeholder={t.aiUsage.allModels}
          style={{ width: 220 }}
          value={filter.model}
          onChange={(v) => set({ model: v })}
          options={q.data?.models.map((m) => ({ value: m, label: m }))}
        />
        <Select
          allowClear
          placeholder={t.aiUsage.allChannels}
          style={{ width: 160 }}
          value={filter.channelId}
          onChange={(v) => set({ channelId: v })}
          options={channels.map((c) => ({ value: c.id, label: c.name }))}
        />
        <Select
          allowClear
          placeholder={t.aiUsage.allStatus}
          style={{ width: 110 }}
          value={filter.status}
          onChange={(v) => set({ status: v })}
          options={[
            { value: 'ok', label: t.aiUsage.ok },
            { value: 'error', label: t.aiUsage.failed },
          ]}
        />
        <Button icon={<ReloadOutlined />} loading={q.isFetching} onClick={() => q.refetch()}>
          {t.aiUsage.refresh}
        </Button>
      </Flex>
      {q.isError && <Alert type="error" showIcon title={q.error.message} style={{ marginBottom: 12 }} />}
      <TableFill>
        {(y) => (
          <Table<AiRequestRow>
            size="small"
            bordered
            rowKey="id"
            loading={q.isPending}
            dataSource={q.data?.items}
            pagination={false}
            scroll={{ x: 1280, y }}
            columns={[
              { title: t.aiUsage.time, dataIndex: 'createdAt', width: 165, render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm:ss') },
              {
                title: t.aiUsage.purposeCol,
                dataIndex: 'purpose',
                width: 180,
                // 标签不换行，列宽不够时截断，不能盖到下一列
                render: (v: AiPurpose) => (
                  <Tag
                    title={purposeLabel(v)}
                    style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'middle', marginInlineEnd: 0 }}
                  >
                    {purposeLabel(v)}
                  </Tag>
                ),
              },
              { title: t.aiUsage.channel, dataIndex: 'channelName', width: 140, ellipsis: true, render: (v: string | null) => v ?? '-' },
              { title: t.aiUsage.model, dataIndex: 'model', width: 220, ellipsis: true },
              {
                title: t.aiUsage.status,
                dataIndex: 'ok',
                width: 80,
                render: (ok: boolean) => (ok ? <Tag color="success">{t.aiUsage.ok}</Tag> : <Tag color="error">{t.aiUsage.failed}</Tag>),
              },
              { title: t.aiUsage.duration, dataIndex: 'durationMs', width: 90, align: 'right', render: seconds },
              { title: t.aiUsage.input, dataIndex: 'inputTokens', width: 90, align: 'right', render: tokens },
              { title: t.aiUsage.output, dataIndex: 'outputTokens', width: 90, align: 'right', render: tokens },
              { title: t.aiUsage.cacheHit, dataIndex: 'cacheReadTokens', width: 90, align: 'right', render: tokens },
              {
                title: t.aiUsage.cost,
                dataIndex: 'cost',
                width: 100,
                align: 'right',
                render: (v: number | null) => (v === null ? <Typography.Text type="secondary">-</Typography.Text> : formatCost(v)),
              },
              {
                title: t.aiUsage.error,
                dataIndex: 'error',
                ellipsis: { showTitle: false },
                render: (v: string | null) =>
                  v ? (
                    <Tooltip title={v} placement="topLeft">
                      <Typography.Text type="danger">{v}</Typography.Text>
                    </Tooltip>
                  ) : null,
              },
            ]}
          />
        )}
      </TableFill>
      <Paging
        page={page}
        pageSize={pageSize}
        total={q.data?.total ?? 0}
        totalText={(n) => t.aiUsage.total(n)}
        onChange={(p, s) => {
          setPage(p);
          setPageSize(s);
        }}
      />
    </>
  );
}

const RANGES: AiStatsRange[] = [1, 7, 30, 90];

const errorRate = (a: AiUsageAgg) => (a.requests ? Math.round((a.errors / a.requests) * 1000) / 10 : 0);
const usageHint = (a: AiUsageAgg) => t.aiUsage.usageHint(a.requests, a.errors, num(a.inputTokens), num(a.outputTokens), formatCost(a.cost), seconds(a.avgMs));

/** 统计：请求量、失败率、token 用量和耗时，按模型 / 用途 / 渠道拆分 */
function AiStats() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [days, setDays] = useState<AiStatsRange>(7);
  const [recosting, setRecosting] = useState(false);
  const colors = useChartColors();
  const q = useQuery({
    queryKey: ['ai-stats', days],
    queryFn: () => api<AiStats>(`/api/admin/ai/stats?days=${days}`),
    placeholderData: (prev) => prev,
  });
  const a = q.data;

  const recost = async () => {
    setRecosting(true);
    try {
      const res = await api<{ updated: number }>('/api/admin/ai/requests/recost', { method: 'POST', body: {} });
      message.success(res.updated ? t.aiUsage.recosted(res.updated) : t.aiUsage.nothingToRecost);
      await qc.invalidateQueries({ queryKey: ['ai-stats'] });
      await qc.invalidateQueries({ queryKey: ['ai-requests'] });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setRecosting(false);
    }
  };
  const prevLabel = days === 1 ? t.aiUsage.prev24h : t.aiUsage.prevDays(days);
  const weekdays = t.reports.weekdays;
  const dateFmt = t.common.date.monthDay;

  const label = (key: string) => {
    if (a?.bucket === 'hour') return { label: t.aiUsage.hourLabel(key.slice(11)), hint: `${dayjs(key.slice(0, 10)).format(dateFmt)} ${key.slice(11)}:00` };
    const d = dayjs(key);
    return { label: days <= 7 ? weekdays[d.day()]! : d.format('M/D'), hint: `${d.format(dateFmt)} ${weekdays[d.day()]}` };
  };

  return (
    <div>
      <Flex justify="space-between" align="center" wrap gap={12} style={{ marginBottom: 16 }}>
        <Typography.Text type="secondary">{a ? t.aiUsage.since(dayjs(a.start).format(t.common.date.full)) : ' '}</Typography.Text>
        <Segmented value={days} onChange={(v) => setDays(v as AiStatsRange)} options={RANGES.map((value) => ({ value, label: t.aiUsage.ranges[value]! }))} />
      </Flex>

      {q.isError && <Alert type="error" showIcon title={q.error.message} style={{ marginBottom: 16 }} />}
      {!a ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : (
        <div style={{ opacity: q.isFetching ? 0.6 : 1, transition: 'opacity .2s' }}>
          {a.totals.unpriced > 0 && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              title={t.aiUsage.unpriced(a.totals.unpriced)}
              description={
                <>
                  {t.aiUsage.unpricedBefore}
                  <Link to="/ai/models">{t.aiUsage.unpricedLink}</Link>
                  {t.aiUsage.unpricedAfter}
                </>
              }
              action={
                <Button size="small" loading={recosting} onClick={recost}>
                  {t.aiUsage.recost}
                </Button>
              }
            />
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
            <StatTile
              title={t.aiUsage.cost}
              value={a.totals.cost}
              prev={a.prev.cost}
              format={(v) => formatCost(v)}
              hint={t.aiUsage.vs(prevLabel, formatCost(a.prev.cost))}
            />
            <StatTile
              title={t.aiUsage.requests}
              value={a.totals.requests}
              prev={a.prev.requests}
              suffix={t.aiUsage.times || undefined}
              hint={t.aiUsage.vs(prevLabel, t.aiUsage.timesN(a.prev.requests))}
            />
            <StatTile title={t.aiUsage.errorRate} value={errorRate(a.totals)} suffix="%" hint={t.aiUsage.failedN(a.totals.errors)} />
            <StatTile
              title={t.aiUsage.inputTokens}
              value={a.totals.inputTokens}
              prev={a.prev.inputTokens}
              hint={t.aiUsage.vs(prevLabel, num(a.prev.inputTokens))}
            />
            <StatTile
              title={t.aiUsage.outputTokens}
              value={a.totals.outputTokens}
              prev={a.prev.outputTokens}
              hint={t.aiUsage.vs(prevLabel, num(a.prev.outputTokens))}
            />
            <StatTile
              title={t.aiUsage.cacheHit}
              value={a.totals.inputTokens ? Math.round((a.totals.cacheReadTokens / a.totals.inputTokens) * 1000) / 10 : 0}
              suffix="%"
              hint={t.aiUsage.cacheHint(num(a.totals.cacheReadTokens))}
            />
            <StatTile title={t.aiUsage.avgDuration} value={Math.round(a.totals.avgMs / 100) / 10} suffix={t.aiUsage.sec} />
          </div>

          <div className="dash-grid" style={{ marginBottom: 16 }}>
            <Card size="small" title={a.bucket === 'hour' ? t.aiUsage.hourlyRequests : t.aiUsage.dailyRequests} style={{ gridColumn: 'span 2' }}>
              <ColumnChart
                height={220}
                series={[
                  { name: t.aiUsage.ok, color: colors.s1 },
                  { name: t.aiUsage.failed, color: colors.s2 },
                ]}
                data={a.series.map((s) => ({ ...label(s.key), values: [s.requests - s.errors, s.errors] }))}
              />
            </Card>
            <Card size="small" title={t.aiUsage.byPurpose}>
              <BarList
                total={a.totals.requests || undefined}
                items={a.byPurpose.map((p) => ({ key: p.key, label: purposeLabel(p.key), value: p.requests, hint: usageHint(p) }))}
              />
            </Card>
          </div>

          <Card size="small" title={a.bucket === 'hour' ? t.aiUsage.hourlyTokens : t.aiUsage.dailyTokens} style={{ marginBottom: 16 }}>
            <ColumnChart
              height={200}
              series={[
                { name: t.aiUsage.input, color: colors.s1 },
                { name: t.aiUsage.output, color: colors.s3 },
              ]}
              data={a.series.map((s) => ({ ...label(s.key), values: [s.inputTokens, s.outputTokens] }))}
            />
          </Card>

          <div className="dash-grid">
            <Card size="small" title={t.aiUsage.byModel} style={{ gridColumn: 'span 2' }}>
              <Table
                size="small"
                bordered
                rowKey="key"
                pagination={false}
                dataSource={a.byModel}
                scroll={{ x: 660 }}
                locale={{ emptyText: t.aiUsage.noCalls }}
                columns={[
                  { title: t.aiUsage.model, dataIndex: 'key', ellipsis: true },
                  { title: t.aiUsage.requests, dataIndex: 'requests', width: 80, align: 'right' },
                  { title: t.aiUsage.errorRate, key: 'err', width: 80, align: 'right', render: (_, r) => `${errorRate(r)}%` },
                  { title: t.aiUsage.input, dataIndex: 'inputTokens', width: 110, align: 'right', render: num },
                  { title: t.aiUsage.output, dataIndex: 'outputTokens', width: 110, align: 'right', render: num },
                  {
                    title: t.aiUsage.cost,
                    dataIndex: 'cost',
                    width: 100,
                    align: 'right',
                    render: (v: number, r) => (r.unpriced === r.requests ? '-' : formatCost(v)),
                  },
                  { title: t.aiUsage.avgDuration, dataIndex: 'avgMs', width: 90, align: 'right', render: seconds },
                ]}
              />
            </Card>
            <Card size="small" title={t.aiUsage.byChannel}>
              <BarList
                total={a.totals.requests || undefined}
                items={a.byChannel.map((c) => ({ key: c.key ?? '-', label: c.name ?? t.aiUsage.unknownChannel, value: c.requests, hint: usageHint(c) }))}
              />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
