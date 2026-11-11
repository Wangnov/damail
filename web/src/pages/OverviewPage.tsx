import { EditOutlined, RightOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Flex, Skeleton, Typography, theme } from 'antd';
import dayjs from 'dayjs';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { api, type Report, type ReportSummary, type ThreadSummary } from '../api';
import { useCompose } from '../components/Compose';
import { SenderAvatar } from '../components/SenderAvatar';
import { useAccounts, usePendingDrafts, useStats } from '../hooks/data';
import { greeting, shortDate } from '../lib/format';
import { NEEDS_REPLY_Q } from '../lib/search';
import { Summary } from './ReportsPage';
import { EmptyBlock } from '../components/EmptyBlock';
import { intlLocale, t } from '../i18n';

// 列表在卡片里滚动，只取最近一批，完整的点「全部」去邮件页
const LIST_LIMIT = 30;

function useThreads(view: string, q: string) {
  return useQuery({
    queryKey: ['threads', 'overview', view, q],
    queryFn: () => api<{ items: ThreadSummary[] }>(`/api/v1/threads?view=${view}&q=${encodeURIComponent(q)}&limit=${LIST_LIMIT}`).then((r) => r.items),
  });
}

/** 最新一份日报，超过两天的不算「今日」 */
function useLatestDaily() {
  const list = useQuery({ queryKey: ['reports', 'daily', 'latest'], queryFn: () => api<ReportSummary[]>('/api/v1/reports?kind=daily&limit=1') });
  const latest = list.data?.[0];
  const fresh = latest && dayjs(latest.periodEnd).isAfter(dayjs().subtract(2, 'day'));
  const id = fresh ? String(latest.id) : undefined;
  return useQuery({ queryKey: ['report', id], queryFn: () => api<Report>(`/api/v1/reports/${id}`), enabled: Boolean(id) });
}

export function OverviewPage({ username }: { username: string }) {
  const navigate = useNavigate();
  const compose = useCompose();
  const { token } = theme.useToken();
  const stats = useStats();
  const pending = usePendingDrafts();
  const accounts = useAccounts();
  const needsReply = useThreads('inbox', NEEDS_REPLY_Q);
  const important = useThreads('important', 'is:unread');
  const report = useLatestDaily();

  const st = stats.data;
  const broken = (accounts.data ?? []).filter((a) => a.status === 'error');
  const bills = (report.data?.data.bills ?? []).filter((b) => !b.dueDate || !dayjs(b.dueDate).isBefore(dayjs(), 'day'));
  const now = dayjs();

  const tiles: Array<{ title: string; value: number | undefined; to: string; hint: string; warn?: boolean }> = [
    { title: t.overview.tiles.pending, value: pending.data?.length, to: '/outbox', hint: t.overview.tiles.pendingHint, warn: true },
    { title: t.overview.tiles.important, value: st?.importantUnread, to: '/mail?view=important', hint: t.overview.tiles.importantHint },
    { title: t.overview.tiles.followUps, value: st?.followUpsDue, to: '/mail?view=waiting', hint: t.overview.tiles.followUpsHint },
    { title: t.overview.tiles.inbox, value: st?.inboxUnreadTotal, to: '/mail', hint: t.overview.tiles.inboxHint },
  ];

  return (
    <div className="overview-page">
      <Flex justify="space-between" align="center" wrap gap={12}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t.overview.hello(greeting(), username)}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {now.format(t.overview.dateFormat)} {t.overview.weekdays[now.day()]}
            {st ? t.overview.receivedToday(st.receivedToday) : ''}
          </Typography.Text>
        </div>
        <Button
          type="primary"
          icon={<EditOutlined />}
          disabled={!accounts.data?.length}
          onClick={() => compose({ mode: 'new', accountId: accounts.data?.[0]?.id })}
        >
          {t.layout.compose}
        </Button>
      </Flex>

      {broken.length > 0 && (
        <Alert
          type="error"
          showIcon
          title={t.overview.syncError(broken.map((a) => a.name))}
          description={broken.length === 1 ? broken[0]!.lastError : undefined}
          action={
            <Button size="small" onClick={() => navigate('/settings/accounts')}>
              {t.overview.fix}
            </Button>
          }
        />
      )}

      {report.data?.summary && (
        <Card
          size="small"
          title={t.overview.todaySummary(dayjs(report.data.createdAt).format(t.overview.summaryTime))}
          extra={<Typography.Link onClick={() => navigate(`/reports/${report.data!.id}`)}>{t.overview.viewDaily}</Typography.Link>}
          className="overview-summary"
          // 大屏时摘要按内容撑开，和下面的列表卡片分页面高度，页面本身不滚动；小屏最多露出五条，多的在卡片里滚动（见 styles.css）
          style={{ background: token.colorFillQuaternary }}
        >
          <Summary text={report.data.summary} />
        </Card>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        {tiles.map((tile) => (
          <button key={tile.title} type="button" className="overview-tile" title={tile.hint} onClick={() => navigate(tile.to)}>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {tile.title}
            </Typography.Text>
            <div
              style={{
                fontSize: 26,
                fontWeight: 600,
                lineHeight: 1.3,
                fontVariantNumeric: 'tabular-nums',
                color: tile.warn && tile.value ? token.colorWarningText : token.colorText,
              }}
            >
              {tile.value === undefined ? '–' : tile.value.toLocaleString(intlLocale())}
            </div>
          </button>
        ))}
      </div>

      <div className="overview-grid">
        <ThreadCard
          title={t.overview.needsReply}
          q={needsReply}
          more={`/mail?view=inbox&q=${encodeURIComponent(NEEDS_REPLY_Q)}`}
          view="inbox"
          empty={t.overview.needsReplyEmpty}
        />
        <ThreadCard title={t.overview.importantUnread} q={important} more="/mail?view=important" view="important" empty={t.overview.importantEmpty} />
        {bills.length > 0 && (
          <Card size="small" title={t.overview.bills} styles={{ body: { paddingBlock: 4 } }}>
            {bills.map((b) => (
              <Row key={b.id} onOpen={() => navigate(`/mail?view=all&thread=${encodeURIComponent(b.threadId)}`)}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Typography.Text ellipsis style={{ display: 'block' }}>
                    {b.subject}
                  </Typography.Text>
                  <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>
                    {b.from}
                  </Typography.Text>
                </div>
                <Flex vertical align="end" style={{ flex: 'none' }}>
                  {b.amount && <Typography.Text strong>{b.amount}</Typography.Text>}
                  {b.dueDate && (
                    <Typography.Text type={dayjs(b.dueDate).isBefore(dayjs().add(3, 'day')) ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
                      {t.overview.dueOn(b.dueDate)}
                    </Typography.Text>
                  )}
                </Flex>
              </Row>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}

function Row({ onOpen, children }: { onOpen: () => void; children: ReactNode }) {
  return (
    <div className="report-row" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <Flex align="center" gap={10} style={{ width: '100%' }}>
        {children}
      </Flex>
    </div>
  );
}

function ThreadCard({
  title,
  q,
  more,
  view,
  empty,
}: {
  title: string;
  q: { data?: ThreadSummary[]; isPending: boolean };
  more: string;
  view: string;
  empty: string;
}) {
  const navigate = useNavigate();
  return (
    <Card
      size="small"
      title={title}
      extra={
        <Typography.Link onClick={() => navigate(more)}>
          {t.overview.all} <RightOutlined style={{ fontSize: 10 }} />
        </Typography.Link>
      }
      styles={{ body: { paddingBlock: 4 } }}
    >
      {q.isPending ? (
        <Skeleton active paragraph={{ rows: 3 }} style={{ padding: '8px 0' }} />
      ) : !q.data?.length ? (
        <EmptyBlock description={empty} />
      ) : (
        q.data.map((th) => (
          <Row key={th.threadId} onOpen={() => navigate(`/mail?view=${view}&thread=${encodeURIComponent(th.threadId)}`)}>
            <SenderAvatar address={th.from.address} name={th.from.name || th.from.address || '?'} size={28} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <Flex justify="space-between" gap={8}>
                <Typography.Text ellipsis strong={th.unread}>
                  {th.from.name || th.from.address}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12, flex: 'none' }}>
                  {shortDate(th.lastDate)}
                </Typography.Text>
              </Flex>
              <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 13 }}>
                {th.subject || t.overview.noSubject}
              </Typography.Text>
            </div>
          </Row>
        ))
      )}
    </Card>
  );
}
