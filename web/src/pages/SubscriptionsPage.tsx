import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Flex, Progress, Segmented, Table, Tag, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, type SubscriptionFilter, type SubscriptionPage, type SubscriptionRow } from '../api';
import { SenderAvatar } from '../components/SenderAvatar';
import { TableFill } from '../components/TableFill';
import { DEFAULT_PAGE_SIZE, Paging } from '../components/Paging';
import { UnsubscribeButton, unsubscribeMethod } from '../components/Unsubscribe';
import { useAccounts } from '../hooks/data';
import { fromNow, fullDate } from '../lib/format';
import { getLocale, t } from '../i18n';

type Filter = SubscriptionFilter;
type SortField = 'count' | 'openRate' | 'lastDate';
type Sort = { field: SortField; order: 'ascend' | 'descend' } | null;

const openRate = (r: SubscriptionRow) => (r.count ? (r.count - r.unread) / r.count : 0);

// 发件人以外的列按内容定宽（英文文案更长），剩下的宽度给发件人列显示完整地址；sender 是发件人列的最小宽度
const COL_WIDTH = {
  'zh-CN': { sender: 240, count: 120, openRate: 160, lastDate: 110, method: 110, actions: 150 },
  en: { sender: 240, count: 150, openRate: 175, lastDate: 115, method: 180, actions: 220 },
};

export function SubscriptionsPage() {
  const navigate = useNavigate();
  const accounts = useAccounts();
  const [days, setDays] = useState(90);
  const [filter, setFilter] = useState<Filter>('all');
  // 筛选、计数、排序、分页都在服务端做，这里只取当前这一页
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [sort, setSort] = useState<Sort>(null);
  const list = useQuery({
    queryKey: ['subscriptions', { days, filter, page, pageSize, sort }],
    queryFn: () => {
      const p = new URLSearchParams({ days: String(days), filter, page: String(page), pageSize: String(pageSize) });
      if (sort) {
        p.set('sort', sort.field);
        p.set('order', sort.order === 'ascend' ? 'asc' : 'desc');
      }
      return api<SubscriptionPage>(`/api/v1/subscriptions?${p}`);
    },
    // 翻页、换筛选时先保留上一页的内容，不闪一下空表
    placeholderData: keepPreviousData,
  });

  const counts = list.data?.counts;
  const total = list.data?.total ?? 0;
  const w = COL_WIDTH[getLocale()];
  // 退订后行会移到别的筛选里，当前页可能超出范围，退回最后一页
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (list.data && !list.isPlaceholderData && page > lastPage) setPage(lastPage);
  const sortOrder = (field: SortField) => (sort?.field === field ? sort.order : null);
  const emailOf = new Map((accounts.data ?? []).map((a) => [a.id, a.email]));
  const multiAccount = emailOf.size > 1;

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <Flex align="center" justify="space-between" style={{ marginBottom: 16 }} gap={16} wrap>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t.people.subsTitle}
          </Typography.Title>
          <Typography.Text type="secondary">{t.people.subsDesc}</Typography.Text>
        </div>
        <Flex gap={8} wrap>
          <Segmented<Filter>
            value={filter}
            onChange={(v) => {
              setFilter(v);
              setPage(1);
            }}
            options={[
              { value: 'all', label: t.people.filterAll(counts?.all ?? 0) },
              { value: 'ignored', label: t.people.filterIgnored(counts?.ignored ?? 0) },
              { value: 'unsubscribed', label: t.people.filterUnsubscribed(counts?.unsubscribed ?? 0) },
            ]}
          />
          <Segmented<number>
            value={days}
            onChange={(v) => {
              setDays(v);
              setPage(1);
            }}
            options={[
              { value: 30, label: t.people.lastDays(30) },
              { value: 90, label: t.people.lastDays(90) },
              { value: 180, label: t.people.lastDays(180) },
            ]}
          />
        </Flex>
      </Flex>
      <TableFill>
        {(y) => (
          <Table<SubscriptionRow>
            // 只渲染看得见的行，行多时切换页面不卡
            virtual
            rowKey={(r) => `${r.accountId}:${r.listKey}`}
            bordered
            loading={list.isPending || (list.isPlaceholderData && list.isFetching)}
            dataSource={list.data?.items}
            onChange={(_, __, sorter) => {
              const s = Array.isArray(sorter) ? sorter[0] : sorter;
              setSort(s?.order && s.columnKey ? { field: s.columnKey as SortField, order: s.order } : null);
              setPage(1);
            }}
            pagination={false}
            scroll={{ x: Object.values(w).reduce((a, b) => a + b, 0), y }}
            locale={{ emptyText: filter === 'all' ? t.people.subsEmptyAll(days) : t.people.subsEmpty }}
            onRow={(r) => ({
              style: { cursor: 'pointer' },
              onClick: () => r.address && navigate(`/mail?view=all&q=${encodeURIComponent(`from:${r.address}`)}`),
            })}
            columns={[
              {
                title: t.people.sender,
                render: (_, r) => (
                  <Flex align="center" gap={10} style={{ minWidth: 0 }}>
                    <SenderAvatar address={r.address} name={r.name} size={32} />
                    <div style={{ minWidth: 0 }}>
                      <Typography.Text strong ellipsis style={{ display: 'block' }}>
                        {r.name}
                      </Typography.Text>
                      <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>
                        {r.address}
                        {multiAccount && t.people.receivingAccount(emailOf.get(r.accountId))}
                      </Typography.Text>
                    </div>
                  </Flex>
                ),
              },
              {
                title: t.people.lastDays(days),
                dataIndex: 'count',
                width: w.count,
                align: 'right',
                onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
                key: 'count',
                sorter: true,
                sortOrder: sortOrder('count'),
                render: (n: number) => t.people.emails(n),
              },
              {
                title: t.people.openRate,
                width: w.openRate,
                key: 'openRate',
                sorter: true,
                sortOrder: sortOrder('openRate'),
                render: (_, r) => (
                  <Tooltip title={t.people.readOf(r.count - r.unread, r.count)}>
                    <Flex align="center" gap={8}>
                      <Progress
                        percent={Math.round(openRate(r) * 100)}
                        size="small"
                        status="normal"
                        showInfo={false}
                        style={{ width: 48, flex: 'none', margin: 0 }}
                      />
                      {r.count >= 3 && r.unread === r.count ? (
                        <Tag color="warning" style={{ marginInlineEnd: 0, fontSize: 11 }}>
                          {t.people.neverRead}
                        </Tag>
                      ) : (
                        <Typography.Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{Math.round(openRate(r) * 100)}%</Typography.Text>
                      )}
                    </Flex>
                  </Tooltip>
                ),
              },
              {
                title: t.people.lastEmail,
                dataIndex: 'lastDate',
                width: w.lastDate,
                key: 'lastDate',
                sorter: true,
                sortOrder: sortOrder('lastDate'),
                render: (d: string) => (
                  <Tooltip title={fullDate(d)}>
                    <span style={{ whiteSpace: 'nowrap' }}>{fromNow(d)}</span>
                  </Tooltip>
                ),
              },
              {
                title: t.people.method,
                width: w.method,
                render: (_, r) => (
                  <Tooltip title={unsubscribeMethod(r.method, r.fromBody).hint}>
                    <Tag
                      color={r.method === 'one-click' ? 'success' : 'default'}
                      style={{ marginInlineEnd: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      {unsubscribeMethod(r.method, r.fromBody).label}
                    </Tag>
                  </Tooltip>
                ),
              },
              {
                title: t.people.actions,
                width: w.actions,
                fixed: 'right',
                render: (_, r) => (
                  <span onClick={(e) => e.stopPropagation()}>
                    <UnsubscribeButton
                      target={{ messageId: r.latestMessageId, method: r.method, url: r.url, fromBody: r.fromBody, sender: r.name }}
                      unsubscribed={r.unsubscribed}
                    />
                  </span>
                ),
              },
            ]}
          />
        )}
      </TableFill>
      <Paging
        page={page}
        pageSize={pageSize}
        total={total}
        totalText={(n) => t.people.subsTotal(n)}
        onChange={(p, s) => {
          setPage(p);
          setPageSize(s);
        }}
      />
    </div>
  );
}
