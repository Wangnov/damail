import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Flex, Segmented, Skeleton, Typography } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, type Analytics, type AnalyticsRange } from '../api';
import { BarList, ColumnChart, Heatmap, StatTile, useChartColors } from '../components/charts';
import { CATEGORY_META } from '../components/Insight';
import { t } from '../i18n';

// 热力图从周一排到周日
const ROW_ORDER = [1, 2, 3, 4, 5, 6, 0];
const HOURS = Array.from({ length: 24 }, (_, h) => String(h));

const RANGES: AnalyticsRange[] = [7, 30, 90, 365];

function rangeKey(): AnalyticsRange {
  try {
    const v = Number(localStorage.getItem('damail.dashboard.range'));
    return RANGES.includes(v as AnalyticsRange) ? (v as AnalyticsRange) : 30;
  } catch {
    return 30;
  }
}

export function DashboardPage() {
  const [days, setDays] = useState<AnalyticsRange>(rangeKey);
  const navigate = useNavigate();
  const colors = useChartColors();
  const q = useQuery({
    queryKey: ['analytics', days],
    queryFn: () => api<Analytics>(`/api/v1/analytics?days=${days}`),
    placeholderData: (prev) => prev,
  });

  const pick = (v: AnalyticsRange) => {
    setDays(v);
    try {
      localStorage.setItem('damail.dashboard.range', String(v));
    } catch {
      // 隐私模式下写不进去，不影响使用
    }
  };

  const a = q.data;
  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto', boxSizing: 'border-box' }}>
      <div>
        <Flex justify="space-between" align="center" wrap gap={12} style={{ marginBottom: 16 }}>
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {t.dashboard.title}
            </Typography.Title>
            {a && (
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                {t.dashboard.since(dayjs(a.start).format(t.dashboard.dateLong))}
              </Typography.Text>
            )}
          </div>
          <Segmented value={days} onChange={(v) => pick(v as AnalyticsRange)} options={RANGES.map((value) => ({ value, label: t.dashboard.ranges[value] }))} />
        </Flex>

        {q.isError && <Alert type="error" showIcon title={q.error.message} style={{ marginBottom: 16 }} />}
        {!a ? (
          <Skeleton active paragraph={{ rows: 10 }} />
        ) : (
          <div style={{ opacity: q.isFetching ? 0.6 : 1, transition: 'opacity .2s' }}>
            <Stats a={a} />

            <Card size="small" title={a.bucket === 'week' ? t.dashboard.weekly : t.dashboard.daily} style={{ marginBottom: 16 }}>
              <ColumnChart
                height={220}
                series={[
                  { name: t.dashboard.received, color: colors.s1 },
                  { name: t.dashboard.sent, color: colors.s2 },
                ]}
                data={a.series.map((s) => {
                  const d = dayjs(s.date);
                  if (a.bucket === 'week')
                    return { label: d.format('M/D'), hint: t.dashboard.weekOf(d.format(t.dashboard.dateShort)), values: [s.received, s.sent] };
                  return {
                    label: a.days <= 7 ? t.reports.weekdays[d.day()]! : d.format('M/D'),
                    hint: `${d.format(t.dashboard.dateShort)} ${t.reports.weekdays[d.day()]}`,
                    values: [s.received, s.sent],
                  };
                })}
              />
            </Card>

            <div className="dash-grid" style={{ marginBottom: 16 }}>
              <Card size="small" title={t.dashboard.hours} style={{ gridColumn: 'span 2' }}>
                <Heatmap
                  rows={ROW_ORDER.map((d) => t.reports.weekdays[d]!)}
                  cols={HOURS}
                  values={ROW_ORDER.map((d) => a.heatmap[d]!)}
                  format={(r, c, v) => t.dashboard.heatCell(t.reports.weekdays[ROW_ORDER[r]!]!, c, v)}
                />
              </Card>
              <Card size="small" title={t.dashboard.backlog} extra={<Typography.Text type="secondary">{t.dashboard.backlogHint}</Typography.Text>}>
                <BarList
                  color={colors.s2}
                  items={[
                    { key: 'd1', label: t.dashboard.backlogBuckets.d1, value: a.backlog.d1 },
                    { key: 'd7', label: t.dashboard.backlogBuckets.d7, value: a.backlog.d7 },
                    { key: 'd30', label: t.dashboard.backlogBuckets.d30, value: a.backlog.d30 },
                    { key: 'older', label: t.dashboard.backlogBuckets.older, value: a.backlog.older },
                  ]}
                />
              </Card>
            </div>

            <div className="dash-grid">
              <Card size="small" title={t.dashboard.categories}>
                <BarList
                  total={a.totals.received || undefined}
                  items={a.categories.map((c) => ({
                    key: c.category,
                    label: c.category === 'unanalyzed' ? t.dashboard.unanalyzed : (CATEGORY_META[c.category]?.label ?? c.label),
                    value: c.count,
                    hint: t.dashboard.unreadN(c.unread),
                    onClick: c.category === 'unanalyzed' ? undefined : () => navigate(`/mail?view=all&q=${encodeURIComponent(`category:${c.category}`)}`),
                  }))}
                />
              </Card>
              <Card size="small" title={t.dashboard.topSenders}>
                <BarList
                  items={a.senders.map((s) => ({
                    key: s.address,
                    label: s.name,
                    value: s.count,
                    hint: t.dashboard.senderHint(s.address, s.unread, dayjs(s.last).format(t.dashboard.dateShort)),
                    onClick: () => navigate(`/mail?view=all&q=${encodeURIComponent(`from:${s.address}`)}`),
                  }))}
                />
              </Card>
              <Card size="small" title={t.dashboard.domains}>
                <BarList items={a.domains.map((d) => ({ key: d.domain, label: d.domain, value: d.count }))} />
              </Card>
              <Card size="small" title={t.dashboard.accounts}>
                <BarList
                  items={a.accounts.map((x) => ({
                    key: String(x.accountId),
                    label: x.name,
                    value: x.received,
                    hint: t.dashboard.accountHint(x.email, x.received, x.sent),
                    onClick: () => navigate(`/mail?account=${x.accountId}`),
                  }))}
                />
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stats({ a }: { a: Analytics }) {
  const n = a.totals;
  const unread = a.backlog.d1 + a.backlog.d7 + a.backlog.d30 + a.backlog.older;
  const prevLabel = a.days === 365 ? '' : t.dashboard.vsPrev(a.days);
  const L = t.dashboard;
  // 一年范围没有可比的上一周期数据（同步通常只拉一年内），不显示变化
  const prev = (v: number) => (a.days === 365 ? undefined : v);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
      <StatTile title={L.received} value={n.received} prev={prev(n.receivedPrev)} suffix={L.unit} hint={prevLabel && L.prevHint(prevLabel, n.receivedPrev)} />
      <StatTile title={L.sent} value={n.sent} prev={prev(n.sentPrev)} suffix={L.unit} hint={prevLabel && L.prevHint(prevLabel, n.sentPrev)} />
      <StatTile title={L.dailyAvg} value={Math.round((n.received / a.days) * 10) / 10} suffix={L.unit} />
      <StatTile title={L.senders} value={n.senders} suffix={L.people} />
      <StatTile
        title={L.replyRate}
        value={n.needsReply ? Math.round((n.replied / n.needsReply) * 100) : 0}
        suffix="%"
        hint={L.replyRateHint(n.needsReply, n.replied)}
      />
      <StatTile title={L.inboxUnread} value={unread} suffix={L.unit} />
    </div>
  );
}
