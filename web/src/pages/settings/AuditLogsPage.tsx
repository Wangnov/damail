import { ApiOutlined, KeyOutlined, QuestionOutlined, ReloadOutlined, SettingOutlined, ThunderboltOutlined, UserOutlined } from '@ant-design/icons';
import { CodeHighlighter } from '@ant-design/x';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Avatar, Badge, Button, DatePicker, Descriptions, Flex, Input, Select, Table, Tag, theme, Tooltip, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { Fragment, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { SettingsPage } from '../../components/SettingsPage';
import { TableFill } from '../../components/TableFill';
import { DEFAULT_PAGE_SIZE, Paging } from '../../components/Paging';
import { useIpGeo } from '../../lib/ipGeo';
import { t } from '../../i18n';

type AuditSource = 'web' | 'api' | 'mcp' | 'oauth' | 'system';

type AuditRow = {
  id: number;
  createdAt: string;
  actor: string;
  actorLabel: string;
  action: string;
  actionLabel: string | null;
  target: string | null;
  targetLabel: string | null;
  accountId: number | null;
  account: string | null;
  source: AuditSource | null;
  ip: string | null;
  userAgent: string | null;
  status: number | null;
  durationMs: number | null;
  detail: Record<string, unknown> | null;
};

type ActorOption = { value: string; label: string; type: 'user' | 'key' | 'oauth'; revoked?: boolean };

type Filter = { source?: AuditSource; actor?: string; q?: string; result?: 'ok' | 'failed'; range?: [Dayjs, Dayjs] | null };

const SOURCE_COLOR: Partial<Record<AuditSource, string>> = { api: 'blue', mcp: 'purple', oauth: 'cyan', system: 'default' };
const SOURCES: AuditSource[] = ['web', 'api', 'mcp', 'oauth', 'system'];
const sourceLabel = (s: string) => t.audit.source[s] ?? s;

const RETENTION_DAYS = [30, 90, 180, 365, 0];
const retentionLabel = (d: number) => (d === 0 ? t.audit.keepForever : d === 365 ? t.audit.keepYear : t.audit.keepDays(d));

const MONO = 'var(--ant-font-family-code)';

const actorType = (actor: string) => actor.split(':')[0]!;

/** 两行单元格：主信息 + 灰色小字补充 */
function Cell({ main, sub, title }: { main: ReactNode; sub?: ReactNode; title?: string }) {
  return (
    <div style={{ minWidth: 0, lineHeight: 1.45 }} title={title}>
      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{main}</div>
      {sub !== undefined && sub !== null && (
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {sub}
          </Typography.Text>
        </div>
      )}
    </div>
  );
}

const Muted = () => <Typography.Text type="secondary">-</Typography.Text>;

function ActorCell({ row }: { row: AuditRow }) {
  const { token } = theme.useToken();
  const type = actorType(row.actor);
  const look: Record<string, { icon: ReactNode; color: string; bg: string }> = {
    user: { icon: <UserOutlined />, color: token.colorPrimary, bg: token.colorPrimaryBg },
    key: { icon: <KeyOutlined />, color: token.colorWarning, bg: token.colorWarningBg },
    oauth: { icon: <ApiOutlined />, color: token.purple6, bg: token.purple1 },
    rule: { icon: <ThunderboltOutlined />, color: token.cyan6, bg: token.cyan1 },
    system: { icon: <SettingOutlined />, color: token.colorTextSecondary, bg: token.colorFillSecondary },
  };
  const l = look[type] ?? { icon: <QuestionOutlined />, color: token.colorTextTertiary, bg: token.colorFillTertiary };
  return (
    <Flex align="center" gap={10} style={{ minWidth: 0 }}>
      <Avatar size={28} icon={l.icon} style={{ color: l.color, background: l.bg, flex: 'none' }} />
      <Cell main={row.actorLabel} sub={t.audit.actorType[type] ?? type} title={row.actorLabel} />
    </Flex>
  );
}

/** 操作：中文名称 + 原始动作（MCP 工具名、请求路由或业务动作） */
function ActionCell({ row }: { row: AuditRow }) {
  const tool = typeof row.detail?.tool === 'string' ? row.detail.tool : null;
  const code = row.action === 'mcp.call' ? row.target : tool ? `${tool} · ${row.action}` : row.action;
  return <Cell main={row.actionLabel ?? code} sub={row.actionLabel ? code : undefined} title={code ?? undefined} />;
}

function targetText(row: AuditRow) {
  if (!row.target || row.action === 'mcp.call') return null;
  const ref = /^([a-z_]+):(\d+)$/.exec(row.target);
  const kind = ref && t.audit.targetKind[ref[1]!];
  if (ref && kind) return row.targetLabel ? t.audit.namedTarget(kind, row.targetLabel) : `${kind} #${ref[2]}`;
  return row.target;
}

/** 对象：操作的对象 + 所属邮箱 */
function TargetCell({ row }: { row: AuditRow }) {
  const target = targetText(row);
  const account = row.account ?? (row.accountId !== null ? t.audit.deletedAccount(row.accountId) : null);
  if (!target && !account) return <Muted />;
  const isPath = target?.startsWith('/');
  const main = target ?? account;
  return (
    <Cell
      main={isPath ? <Typography.Text style={{ fontFamily: MONO }}>{main}</Typography.Text> : main}
      sub={target ? account : undefined}
      title={[target, account].filter(Boolean).join('\n')}
    />
  );
}

/** IP：点击后才查询归属地 */
function IpCell({ ip }: { ip: string | null }) {
  if (!ip) return <Muted />;
  return <IpWithGeo ip={ip} />;
}

function IpWithGeo({ ip }: { ip: string }) {
  const g = useIpGeo(ip);
  const sub =
    g.local ?? (g.loading ? t.audit.geoLoading : g.error ? t.audit.geoFailed : g.geo ? [g.place, g.geo.org].filter(Boolean).join(' · ') : t.audit.geoHint);
  const main =
    g.local || g.geo ? (
      <Typography.Text style={{ fontFamily: MONO }}>{ip}</Typography.Text>
    ) : (
      <Typography.Link onClick={g.query} style={{ fontFamily: MONO }}>
        {ip}
      </Typography.Link>
    );
  const cell = <Cell main={main} sub={sub} />;
  if (!g.geo) return cell;
  // 列宽有限（英文地名更长），悬停显示完整归属地
  const lines = [
    [t.audit.country, g.geo.country],
    [t.audit.region, g.geo.region],
    [t.audit.city, g.geo.city],
    [t.audit.isp, g.geo.org],
  ].filter((x): x is [string, string] => Boolean(x[1]));
  return (
    <Tooltip
      placement="topLeft"
      title={
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 2, fontSize: 12 }}>
          <span style={{ opacity: 0.65 }}>IP</span>
          <span style={{ fontFamily: MONO, wordBreak: 'break-all' }}>{ip}</span>
          {lines.map(([label, value]) => (
            <Fragment key={label}>
              <span style={{ opacity: 0.65 }}>{label}</span>
              <span>{value}</span>
            </Fragment>
          ))}
        </div>
      }
    >
      <div style={{ minWidth: 0 }}>{cell}</div>
    </Tooltip>
  );
}

function ResultCell({ row }: { row: AuditRow }) {
  if (row.status === null) return <Muted />;
  const ok = row.status < 400;
  const text = ok ? t.audit.ok : `${row.status} ${t.audit.statusText[row.status] ?? (row.status >= 500 ? t.audit.serverError : t.audit.failed)}`;
  const duration = row.durationMs === null ? undefined : row.durationMs < 1000 ? `${row.durationMs} ms` : `${(row.durationMs / 1000).toFixed(1)} s`;
  return <Cell main={<Badge status={ok ? 'success' : 'error'} text={text} />} sub={duration} />;
}

function DetailPanel({ row }: { row: AuditRow }) {
  return (
    <Descriptions
      size="small"
      column={1}
      styles={{ label: { width: 96 } }}
      items={[
        { label: t.audit.action, children: <Typography.Text code>{row.action}</Typography.Text> },
        ...(row.target ? [{ label: t.audit.target, children: <Typography.Text copyable>{row.target}</Typography.Text> }] : []),
        ...(row.account ? [{ label: t.audit.account, children: row.account }] : []),
        { label: t.audit.actor, children: t.audit.actorWithId(row.actorLabel, row.actor) },
        ...(row.ip ? [{ label: 'IP', children: <Typography.Text copyable>{row.ip}</Typography.Text> }] : []),
        ...(row.userAgent ? [{ label: 'User-Agent', children: <Typography.Text style={{ wordBreak: 'break-all' }}>{row.userAgent}</Typography.Text> }] : []),
        ...(row.detail
          ? [
              {
                label: t.audit.detail,
                children: (
                  <CodeHighlighter className="assistant-code audit-code" lang="json" highlightProps={{ useInlineStyles: false }}>
                    {JSON.stringify(row.detail, null, 2)}
                  </CodeHighlighter>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

/** 保留期限：保存后由服务端定时清理更早的记录 */
function RetentionSelect() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['audit-settings'], queryFn: () => api<{ retentionDays: number }>('/api/admin/audit-logs/settings') });
  const [saving, setSaving] = useState(false);
  const save = async (retentionDays: number) => {
    setSaving(true);
    try {
      await api('/api/admin/audit-logs/settings', { method: 'PUT', body: { retentionDays } });
      await qc.invalidateQueries({ queryKey: ['audit-settings'] });
      message.success(retentionDays ? t.audit.savedRetention(retentionDays) : t.audit.savedForever);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const value = q.data?.retentionDays;
  const days = value !== undefined && !RETENTION_DAYS.includes(value) ? [...RETENTION_DAYS, value] : RETENTION_DAYS;
  const options = days.map((d) => ({ value: d, label: retentionLabel(d) }));
  return <Select style={{ width: 140 }} loading={q.isPending || saving} value={value} options={options} onChange={save} aria-label={t.audit.retention} />;
}

/** 审计日志：开放接口（API Key、OAuth、MCP）的每次调用，以及网页后台的写操作 */
export function AuditLogsPage() {
  const [filter, setFilter] = useState<Filter>({});
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (filter.source) qs.set('source', filter.source);
  if (filter.actor) qs.set('actor', filter.actor);
  if (filter.q) qs.set('q', filter.q);
  if (filter.result) qs.set('result', filter.result);
  if (filter.range) {
    qs.set('from', filter.range[0].startOf('day').toISOString());
    qs.set('to', filter.range[1].endOf('day').toISOString());
  }
  const q = useQuery({
    queryKey: ['audit-logs', qs.toString()],
    queryFn: () => api<{ items: AuditRow[]; total: number }>(`/api/admin/audit-logs?${qs}`),
    placeholderData: (prev) => prev,
  });
  const actors = useQuery({ queryKey: ['audit-actors'], queryFn: () => api<ActorOption[]>('/api/admin/audit-logs/actors') });

  const set = (patch: Filter) => {
    setFilter({ ...filter, ...patch });
    setPage(1);
  };

  const actorOptions = [
    {
      label: t.audit.byType,
      options: [
        { value: 'user', label: t.audit.allUsers },
        { value: 'key', label: t.audit.allKeys },
        { value: 'oauth', label: t.audit.allOAuth },
        { value: 'rule', label: t.audit.allRules },
        { value: 'system', label: t.audit.actorType.system! },
        { value: 'anonymous', label: t.audit.actorType.anonymous! },
      ],
    },
    ...(['user', 'key', 'oauth'] as const).map((type) => ({
      label: t.audit.actorType[type]!,
      options: (actors.data ?? []).filter((a) => a.type === type).map((a) => ({ value: a.value, label: a.revoked ? t.audit.expired(a.label) : a.label })),
    })),
  ].filter((g) => g.options.length);

  return (
    <SettingsPage fill title={t.audit.title} description={t.audit.desc} extra={<RetentionSelect />}>
      <Flex gap={8} wrap align="center" style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder={t.audit.allResults}
          style={{ width: 120 }}
          value={filter.result}
          onChange={(v) => set({ result: v })}
          options={[
            { value: 'ok', label: t.audit.ok },
            { value: 'failed', label: t.audit.failed },
          ]}
        />
        <Select
          allowClear
          placeholder={t.audit.allSources}
          style={{ width: 140 }}
          value={filter.source}
          onChange={(v) => set({ source: v })}
          options={SOURCES.map((value) => ({ value, label: sourceLabel(value) }))}
        />
        <Select
          allowClear
          showSearch={{ optionFilterProp: 'label' }}
          placeholder={t.audit.allActors}
          style={{ width: 200 }}
          value={filter.actor}
          onChange={(v) => set({ actor: v })}
          options={actorOptions}
        />
        <DatePicker.RangePicker
          value={filter.range ?? null}
          onChange={(v) => set({ range: v && v[0] && v[1] ? [v[0], v[1]] : null })}
          disabledDate={(d) => d.isAfter(dayjs(), 'day')}
          style={{ width: 260 }}
        />
        <Button icon={<ReloadOutlined />} loading={q.isFetching} onClick={() => q.refetch()}>
          {t.audit.refresh}
        </Button>
        <Input.Search
          allowClear
          placeholder={t.audit.search}
          style={{ width: 240 }}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            if (!e.target.value) set({ q: undefined });
          }}
          onSearch={(v) => set({ q: v.trim() || undefined })}
        />
      </Flex>
      {q.isError && <Alert type="error" showIcon title={q.error.message} style={{ marginBottom: 12 }} />}
      <TableFill>
        {(y) => (
          <Table<AuditRow>
            // 只渲染看得见的行，行多时切换页面不卡
            virtual
            size="small"
            bordered
            rowKey="id"
            loading={q.isPending}
            dataSource={q.data?.items}
            pagination={false}
            scroll={{ x: 1100, y }}
            locale={{ emptyText: t.audit.empty }}
            expandable={{ expandedRowRender: (row) => <DetailPanel row={row} />, columnWidth: 40 }}
            columns={[
              {
                title: t.audit.time,
                dataIndex: 'createdAt',
                width: 110,
                render: (v: string) => (
                  <Cell main={dayjs(v).format('HH:mm:ss')} sub={dayjs(v).format('YYYY-MM-DD')} title={dayjs(v).format('YYYY-MM-DD HH:mm:ss')} />
                ),
              },
              { title: t.audit.actor, dataIndex: 'actorLabel', width: 170, render: (_, r) => <ActorCell row={r} /> },
              { title: t.audit.operation, dataIndex: 'actionLabel', width: 200, render: (_, r) => <ActionCell row={r} /> },
              { title: t.audit.target, dataIndex: 'target', render: (_, r) => <TargetCell row={r} /> },
              {
                title: t.audit.sourceTitle,
                dataIndex: 'source',
                width: 104,
                render: (s: AuditSource | null) =>
                  s ? (
                    <Tag color={SOURCE_COLOR[s]} style={{ marginInlineEnd: 0 }}>
                      {sourceLabel(s)}
                    </Tag>
                  ) : (
                    <Muted />
                  ),
              },
              { title: t.audit.ipGeo, dataIndex: 'ip', width: 190, render: (ip: string | null) => <IpCell ip={ip} /> },
              { title: t.audit.result, dataIndex: 'status', width: 120, render: (_, r) => <ResultCell row={r} /> },
            ]}
          />
        )}
      </TableFill>
      <Paging
        page={page}
        pageSize={pageSize}
        total={q.data?.total ?? 0}
        totalText={(n) => t.audit.total(n)}
        onChange={(p, s) => {
          setPage(p);
          setPageSize(s);
        }}
      />
    </SettingsPage>
  );
}
