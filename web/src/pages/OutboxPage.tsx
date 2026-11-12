import { ClockCircleOutlined, CloseOutlined, DeleteOutlined, EditOutlined, EyeOutlined, RollbackOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { App, Button, Flex, Popconfirm, Table, Tag, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, type DraftSummary } from '../api';
import { useCompose } from '../components/Compose';
import { useDraftList, usePendingDrafts } from '../hooks/data';
import { formatAddress, formatSendAt, fromNow, fullDate } from '../lib/format';
import { TableFill } from '../components/TableFill';
import { t } from '../i18n';

/** 草稿的几个分类，显示在左侧面板里；名字和页头说明见 t.outbox.tabs / tabDesc */
export const DRAFT_TABS = [
  { key: 'pending', status: 'pending' },
  { key: 'drafts', status: 'draft,rejected' },
  { key: 'outbox', status: 'queued,sending' },
  { key: 'sent', status: 'sent' },
  { key: 'failed', status: 'failed' },
] as const;

/** 没指定分类时：有待审批的先看待审批，否则看草稿 */
export const defaultDraftTab = (pendingCount: number) => (pendingCount ? 'pending' : 'drafts');

const STATUS_COLOR: Record<string, string> = {
  draft: 'default',
  pending: 'gold',
  queued: 'blue',
  sending: 'processing',
  sent: 'green',
  failed: 'red',
  rejected: 'orange',
};

// 后端自动写的说明是「AI 助手起草」这类，和来源标签重复（旧数据是中文，切到英文后也要认出来）
const AUTO_NOTES = new Set(['网页起草', 'API起草', 'MCP起草', '规则起草', 'AI 助手起草']);

/** 一分钟以后才发的视为定时发送 */
const isScheduled = (d: DraftSummary) => d.status === 'queued' && !!d.sendAt && new Date(d.sendAt).getTime() - Date.now() > 60_000;

export function OutboxPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const compose = useCompose();
  const [params] = useSearchParams();
  const pending = usePendingDrafts();
  const tab = params.get('tab') ?? defaultDraftTab(pending.data?.length ?? 0);
  const current = DRAFT_TABS.find((x) => x.key === tab) ?? DRAFT_TABS[0];
  const list = useDraftList(current.status);
  // 只有这两类里状态各不相同，其他分类的状态就是分类名本身，不再单独显示
  const showStatus = current.key === 'drafts' || current.key === 'outbox';
  // 正在执行的操作，`${id}${path}`，只让点的那个按钮转圈
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (id: number, path: string, method: 'POST' | 'DELETE', done: string) => {
    setBusy(`${id}${path}`);
    try {
      await api(`/api/v1/drafts/${id}${path}`, { method, body: method === 'POST' ? {} : undefined });
      message.success(done);
      await qc.invalidateQueries({ queryKey: ['drafts'] });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const recipients = (d: DraftSummary) => [...d.to, ...d.cc, ...d.bcc].map(formatAddress).join(t.outbox.listSep) || t.outbox.noRecipients;
  // 「AI 助手起草」这类说明和来源标签重复，不显示，改显示正文摘要
  const noteOf = (d: DraftSummary) => (d.note && !AUTO_NOTES.has(d.note) && !/^\S.* drafted$/.test(d.note) ? t.outbox.note(d.note) : d.snippet);

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.outbox.tabs[current.key]}
        </Typography.Title>
        <Typography.Text type="secondary">{t.outbox.tabDesc[current.key]}</Typography.Text>
      </div>
      <TableFill>
        {(y) => (
          <Table<DraftSummary>
            rowKey="id"
            bordered
            loading={list.isPending}
            dataSource={list.data}
            pagination={false}
            scroll={{ x: 640, y }}
            onRow={(d) => ({ onDoubleClick: () => compose({ draftId: d.id }) })}
            columns={[
              {
                title: t.outbox.colSubject,
                minWidth: 240,
                render: (_, d) => (
                  <div style={{ minWidth: 0, maxWidth: 480 }}>
                    <Flex align="center" gap={6}>
                      <Typography.Text type="secondary" ellipsis style={{ minWidth: 0, fontSize: 12 }}>
                        {d.accountEmail} → {recipients(d)}
                      </Typography.Text>
                      <Tag style={{ flex: 'none', marginInlineEnd: 0, fontSize: 11, lineHeight: '18px' }}>{t.outbox.source[d.source] ?? d.source}</Tag>
                    </Flex>
                    {/* 点主题打开全文，审阅、修改都在里面 */}
                    <Typography.Text strong ellipsis className="outbox-subject" onClick={() => compose({ draftId: d.id })}>
                      {d.subject || t.outbox.noSubject}
                    </Typography.Text>
                    <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>
                      {noteOf(d)}
                    </Typography.Text>
                    {d.error && (
                      <Typography.Text type={d.status === 'sent' ? 'warning' : 'danger'} style={{ fontSize: 12 }}>
                        {d.error}
                      </Typography.Text>
                    )}
                  </div>
                ),
              },
              ...(showStatus
                ? [
                    {
                      title: t.outbox.colStatus,
                      width: 100,
                      render: (_: unknown, d: DraftSummary) =>
                        isScheduled(d) ? (
                          <Tag color="purple" icon={<ClockCircleOutlined />}>
                            {t.outbox.scheduled}
                          </Tag>
                        ) : (
                          <Tag color={STATUS_COLOR[d.status]}>{t.outbox.status[d.status] ?? d.status}</Tag>
                        ),
                    },
                  ]
                : []),
              {
                title: t.outbox.colTime,
                width: 110,
                responsive: ['md'],
                render: (_, d) => {
                  const at = d.sentAt ?? d.sendAt ?? d.updatedAt;
                  if (isScheduled(d))
                    return (
                      <Tooltip title={fullDate(d.sendAt!)}>
                        <Typography.Text style={{ whiteSpace: 'nowrap' }}>{formatSendAt(d.sendAt!)}</Typography.Text>
                      </Tooltip>
                    );
                  return (
                    <Tooltip title={fullDate(at)}>
                      <Typography.Text type="secondary">{fromNow(at)}</Typography.Text>
                    </Tooltip>
                  );
                },
              },
              {
                title: '',
                // 表格是固定列宽：要放下英文「Review」「Reject」两个带图标的按钮（大尺寸组件也够）
                width: current.key === 'pending' ? 264 : 130,
                render: (_, d) => (
                  <Flex gap={8} justify="flex-end" align="center" style={{ whiteSpace: 'nowrap' }}>
                    {d.status === 'pending' && (
                      <>
                        <Button type="primary" icon={<EyeOutlined />} onClick={() => compose({ draftId: d.id })}>
                          {t.outbox.review}
                        </Button>
                        <Popconfirm
                          title={t.outbox.rejectTitle}
                          description={t.outbox.rejectDesc}
                          okText={t.outbox.reject}
                          okButtonProps={{ danger: true }}
                          onConfirm={() => run(d.id, '/reject', 'POST', t.outbox.rejected)}
                        >
                          <Button danger icon={<CloseOutlined />} loading={busy === `${d.id}/reject`}>
                            {t.outbox.reject}
                          </Button>
                        </Popconfirm>
                      </>
                    )}
                    {d.status === 'queued' && (
                      <Button
                        size="small"
                        icon={<RollbackOutlined />}
                        loading={busy === `${d.id}/cancel`}
                        onClick={() => run(d.id, '/cancel', 'POST', t.outbox.cancelled)}
                      >
                        {isScheduled(d) ? t.outbox.cancelSchedule : t.outbox.undo}
                      </Button>
                    )}
                    {d.status !== 'pending' && d.status !== 'queued' && d.status !== 'sending' && (
                      <Tooltip title={d.status === 'sent' ? t.outbox.view : t.common.edit}>
                        <Button
                          size="small"
                          type="text"
                          icon={d.status === 'sent' ? <EyeOutlined /> : <EditOutlined />}
                          onClick={() => compose({ draftId: d.id })}
                        />
                      </Tooltip>
                    )}
                    {d.status !== 'pending' && d.status !== 'queued' && d.status !== 'sending' && (
                      <Popconfirm
                        title={d.status === 'sent' ? t.outbox.deleteSentTitle : t.outbox.deleteDraftTitle}
                        description={d.status === 'sent' ? t.outbox.deleteSentDesc : undefined}
                        okText={t.common.delete}
                        okButtonProps={{ danger: true }}
                        onConfirm={() => run(d.id, '', 'DELETE', t.common.deleted)}
                      >
                        <Button size="small" type="text" danger icon={<DeleteOutlined />} loading={busy === `${d.id}`} />
                      </Popconfirm>
                    )}
                  </Flex>
                ),
              },
            ]}
          />
        )}
      </TableFill>
    </div>
  );
}
