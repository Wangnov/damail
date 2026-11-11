import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Flex, Input, Popover, Segmented, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, type ContactRow, type IgnoredSender } from '../api';
import { SenderAvatar } from '../components/SenderAvatar';
import { TableFill } from '../components/TableFill';
import { DEFAULT_PAGE_SIZE, Paging } from '../components/Paging';
import { fromNow, fullDate } from '../lib/format';
import { t } from '../i18n';

type Filter = 'all' | 'ignored';
type Sort = 'count' | 'recent';

/** 地址命中的是哪条名单：自己的地址，或者所属的域名（含上级域名） */
function matchedPattern(address: string, patterns: Set<string>) {
  const a = address.toLowerCase();
  if (patterns.has(a)) return a;
  const labels = (a.split('@')[1] ?? '').split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const p = `@${labels.slice(i).join('.')}`;
    if (patterns.has(p)) return p;
  }
  return null;
}

export function ContactsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('count');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [adding, setAdding] = useState('');

  useEffect(() => {
    const t = window.setTimeout(() => setSearch(input.trim()), 300);
    return () => window.clearTimeout(t);
  }, [input]);
  useEffect(() => setPage(1), [search, filter, sort]);

  const params = new URLSearchParams({
    q: search,
    sort,
    limit: String(pageSize),
    offset: String((page - 1) * pageSize),
    ...(filter === 'ignored' ? { ignored: '1' } : {}),
  });
  const list = useQuery({
    queryKey: ['contacts', 'list', params.toString()],
    queryFn: () => api<{ total: number; items: ContactRow[] }>(`/api/admin/contacts?${params}`),
    placeholderData: keepPreviousData,
  });
  const ignored = useQuery({ queryKey: ['contacts', 'ignored'], queryFn: () => api<IgnoredSender[]>('/api/admin/ignored-senders') });
  const patterns = new Set((ignored.data ?? []).map((r) => r.pattern));

  // 忽略会删掉已有的分析结果，邮件列表、概览、统计都要刷新
  const refresh = () => ['contacts', 'threads', 'thread', 'stats'].forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
  const add = useMutation({
    mutationFn: (pattern: string) => api<{ pattern: string; removedInsights: number }>('/api/admin/ignored-senders', { method: 'POST', body: { pattern } }),
    onSuccess: (r) => {
      message.success(t.people.ignoredAdded(r.pattern, r.removedInsights));
      setAdding('');
      refresh();
    },
    onError: (e) => message.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (pattern: string) => api(`/api/admin/ignored-senders/${encodeURIComponent(pattern)}`, { method: 'DELETE' }),
    onSuccess: (_, pattern) => {
      message.success(t.people.ignoredRemoved(pattern));
      refresh();
    },
    onError: (e) => message.error(e.message),
  });
  const busy = add.isPending || remove.isPending;

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Flex align="center" justify="space-between" gap={16} wrap>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t.people.contactsTitle}
          </Typography.Title>
          <Typography.Text type="secondary">{t.people.contactsDesc}</Typography.Text>
        </div>
        <Flex gap={8} wrap>
          <Input.Search allowClear placeholder={t.people.searchContacts} value={input} onChange={(e) => setInput(e.target.value)} style={{ width: 220 }} />
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: t.people.all },
              { value: 'ignored', label: t.people.noAnalysis },
            ]}
          />
          <Segmented<Sort>
            value={sort}
            onChange={setSort}
            options={[
              { value: 'count', label: t.people.byCount },
              { value: 'recent', label: t.people.byRecent },
            ]}
          />
        </Flex>
      </Flex>

      <Flex align="center" gap={8} wrap>
        <Typography.Text type="secondary">{t.people.ignoreList}</Typography.Text>
        {(ignored.data ?? []).map((r) => (
          <Tag key={r.pattern} closable onClose={(e) => (e.preventDefault(), remove.mutate(r.pattern))} style={{ marginInlineEnd: 0 }}>
            {r.pattern}
          </Tag>
        ))}
        {ignored.data?.length === 0 && <Typography.Text type="secondary">{t.people.ignoreEmpty}</Typography.Text>}
        <Space.Compact size="small">
          <Input
            placeholder={t.people.ignorePlaceholder}
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onPressEnter={() => adding.trim() && add.mutate(adding)}
            style={{ width: 200 }}
          />
          <Button icon={<PlusOutlined />} disabled={!adding.trim()} loading={add.isPending} onClick={() => add.mutate(adding)}>
            {t.people.ignore}
          </Button>
        </Space.Compact>
      </Flex>

      <TableFill>
        {(y) => (
          <Table<ContactRow>
            // 只渲染看得见的行，行多时切换页面不卡
            virtual
            rowKey="address"
            bordered
            loading={list.isPending}
            dataSource={list.data?.items}
            pagination={false}
            scroll={{ x: 760, y }}
            locale={{ emptyText: search ? t.people.noMatch : filter === 'ignored' ? t.people.noIgnored : t.people.noContacts }}
            onRow={(r) => ({
              style: { cursor: 'pointer' },
              onClick: () => navigate(`/mail?view=all&q=${encodeURIComponent(`from:${r.address}`)}`),
            })}
            columns={[
              {
                title: t.people.contact,
                render: (_, r) => (
                  <Flex align="center" gap={10} style={{ minWidth: 0 }}>
                    <SenderAvatar address={r.address} name={r.name || r.address} size={32} />
                    <div style={{ minWidth: 0 }}>
                      <Flex align="center" gap={4} className="contact-name-line">
                        <Typography.Text strong ellipsis>
                          {r.alias || r.name || r.address.split('@')[0]}
                        </Typography.Text>
                        <AliasEditor row={r} />
                      </Flex>
                      <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>
                        {r.alias && r.name ? `${r.name} · ${r.address}` : r.address}
                      </Typography.Text>
                    </div>
                  </Flex>
                ),
              },
              { title: t.people.received, dataIndex: 'received', width: 90, align: 'right', render: (n: number) => (n ? t.people.emails(n) : '-') },
              { title: t.people.sent, dataIndex: 'sent', width: 90, align: 'right', render: (n: number) => (n ? t.people.emails(n) : '-') },
              {
                title: t.people.lastContact,
                dataIndex: 'lastDate',
                width: 120,
                render: (d: string | null) =>
                  d ? (
                    <Tooltip title={fullDate(d)}>
                      <span style={{ whiteSpace: 'nowrap' }}>{fromNow(d)}</span>
                    </Tooltip>
                  ) : (
                    '-'
                  ),
              },
              {
                title: t.people.noAnalysis,
                width: 90,
                align: 'center',
                fixed: 'right',
                render: (_, r) => {
                  const p = matchedPattern(r.address, patterns);
                  // 通过整个域名忽略的，要去忽略名单里移除域名
                  const byDomain = !!p && p !== r.address;
                  return (
                    <span onClick={(e) => e.stopPropagation()}>
                      <Tooltip title={byDomain ? t.people.domainIgnored(p) : undefined}>
                        <Switch
                          size="small"
                          checked={!!p || r.ignored}
                          disabled={byDomain || busy}
                          onChange={(on) => (on ? add.mutate(r.address) : remove.mutate(r.address))}
                        />
                      </Tooltip>
                    </span>
                  );
                },
              },
            ]}
          />
        )}
      </TableFill>
      <Paging
        page={page}
        pageSize={pageSize}
        total={list.data?.total ?? 0}
        totalText={(n) => t.people.contactsTotal(n)}
        onChange={(p, s) => {
          setPage(p);
          setPageSize(s);
        }}
      />
    </div>
  );
}

/** 给联系人设置备注名：只在 DaMail 里显示，不会写进发出去的邮件 */
function AliasEditor({ row }: { row: ContactRow }) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async (alias: string) => {
    setSaving(true);
    try {
      await api(`/api/admin/contacts/${encodeURIComponent(row.address)}/alias`, { method: 'PUT', body: { alias } });
      await qc.invalidateQueries({ queryKey: ['contacts'] });
      setOpen(false);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) setValue(row.alias ?? '');
        }}
        trigger="click"
        title={t.people.aliasTitle}
        content={
          <div style={{ width: 260 }}>
            <Input
              autoFocus
              maxLength={100}
              placeholder={row.name || row.address}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onPressEnter={() => void save(value)}
              onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
            />
            <Typography.Paragraph type="secondary" style={{ margin: '8px 0', fontSize: 12 }}>
              {t.people.aliasHint}
            </Typography.Paragraph>
            <Flex justify="end" gap={8}>
              {row.alias && (
                <Button size="small" type="text" danger onClick={() => void save('')} disabled={saving} style={{ marginInlineEnd: 'auto' }}>
                  {t.people.aliasClear}
                </Button>
              )}
              <Button size="small" onClick={() => setOpen(false)} disabled={saving}>
                {t.common.cancel}
              </Button>
              <Button size="small" type="primary" loading={saving} onClick={() => void save(value)}>
                {t.common.save}
              </Button>
            </Flex>
          </div>
        }
      >
        {/* 备注框打开时不再显示提示，免得挡住 */}
        <Tooltip title={row.alias ? t.people.aliasEdit : t.people.aliasAdd} mouseEnterDelay={0.4} open={open ? false : undefined}>
          <Button
            type="text"
            size="small"
            className="contact-alias-btn"
            icon={<EditOutlined />}
            aria-label={row.alias ? t.people.aliasEdit : t.people.aliasAdd}
          />
        </Tooltip>
      </Popover>
    </span>
  );
}
