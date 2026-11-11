import { BellOutlined, CheckOutlined, CloseOutlined, DownOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { App, Button, DatePicker, Dropdown, Modal, Tag, Tooltip, Typography, type MenuProps } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { api, type FollowUpBrief, type MessageDetail, type WaitingInfo } from '../api';
import { formatSendAt } from '../lib/format';
import { t } from '../i18n';

/** 写信时的「几天没回复提醒我」 */
// label 是 getter，按当前界面语言取
const days = (value: number) => ({
  value,
  get label() {
    return t.followUp.days[value]!;
  },
});
export const FOLLOW_UP_DAYS = [days(1), days(3), days(7), days(14)];

const PRESETS = [
  { key: '1', at: () => dayjs().add(1, 'day') },
  { key: '3', at: () => dayjs().add(3, 'day') },
  { key: '7', at: () => dayjs().add(7, 'day') },
];

export function waitLabel(hours: number) {
  if (hours < 24) return t.followUp.hours(Math.max(1, Math.round(hours)));
  return t.followUp.daysCount(Math.round(hours / 24));
}

/** 会话列表里等回复的说明：等谁、等了多久、对方平时多久回 */
export function WaitingLine({ waiting }: { waiting: WaitingInfo }) {
  const hours = (Date.now() - new Date(waiting.sentAt).getTime()) / 3600_000;
  const who = waiting.to.name || waiting.to.address || t.followUp.them;
  const fu = waiting.followUp;
  return (
    <span className="waiting-line">
      <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, minWidth: 0 }}>
        {t.followUp.waitingFor(who, waitLabel(hours))}
        {waiting.baselineHours !== null && t.followUp.usually(waitLabel(waiting.baselineHours))}
      </Typography.Text>
      {fu?.status === 'due' && (
        <Tag color="error" icon={<BellOutlined />} style={{ marginInlineEnd: 0, fontSize: 11 }}>
          {t.followUp.due}
        </Tag>
      )}
      {fu?.status === 'open' && fu.dueAt && (
        <Tag icon={<BellOutlined />} style={{ marginInlineEnd: 0, fontSize: 11 }}>
          {t.followUp.remindAt(formatSendAt(fu.dueAt))}
        </Tag>
      )}
    </span>
  );
}

/** 是不是自己发出的邮件（只有这些能设跟进提醒） */
export function isOwnMessage(m: MessageDetail) {
  return m.folderSpecialUse === '\\Sent' || (!!m.from.address && m.from.address.toLowerCase() === m.accountEmail.toLowerCase());
}

/** 邮件详情里的跟进提醒：设提醒、改时间、完成、不用再等 */
export function FollowUpControl({ message }: { message: MessageDetail }) {
  const { message: toast } = App.useApp();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [customAt, setCustomAt] = useState<Dayjs | null>(null);
  const fu: FollowUpBrief | null = message.followUp ?? null;
  const active = fu?.status === 'open' || fu?.status === 'due';

  const call = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      await Promise.all(['thread', 'threads', 'stats'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const url = `/api/v1/messages/${message.id}/follow-up`;
  const remind = (at: Dayjs) => call(() => api(url, { method: 'PUT', body: { dueAt: at.toISOString() } }), t.followUp.willRemind(formatSendAt(at.toDate())));
  const finish = () => call(() => api(url, { method: 'PUT', body: { done: true } }), t.followUp.markedDone);
  const clear = () => call(() => api(url, { method: 'DELETE' }), active ? t.followUp.cancelled : t.followUp.undone);

  const items: MenuProps['items'] = [
    { key: 'title', type: 'group', label: active ? t.followUp.changeTo : t.followUp.remindMe },
    ...PRESETS.map((p) => ({ key: p.key, label: t.followUp.presets[p.key] })),
    { key: 'custom', label: t.followUp.pickDateTime },
    { type: 'divider' },
    active ? { key: 'clear', label: t.followUp.cancel, icon: <CloseOutlined /> } : { key: 'done', label: t.followUp.noNeed, icon: <CheckOutlined /> },
  ];
  const onClick: MenuProps['onClick'] = ({ key, domEvent }) => {
    domEvent.stopPropagation();
    if (key === 'custom') {
      setCustomAt(dayjs().add(1, 'day').hour(9).minute(0).second(0));
      return setPickOpen(true);
    }
    if (key === 'clear') return void clear();
    if (key === 'done') return void finish();
    const p = PRESETS.find((x) => x.key === key);
    if (p) void remind(p.at());
  };

  let trigger;
  if (fu?.status === 'replied') {
    trigger = (
      <Tag color="success" icon={<CheckOutlined />} style={{ marginInlineEnd: 0 }}>
        {t.followUp.replied}
      </Tag>
    );
  } else if (fu?.status === 'done') {
    trigger = (
      <Tooltip title={t.followUp.doneTip}>
        <Button size="small" type="text" loading={busy} onClick={() => void clear()}>
          {t.followUp.markedDone}
        </Button>
      </Tooltip>
    );
  } else {
    trigger = (
      <Dropdown trigger={['click']} menu={{ items, onClick }} disabled={busy}>
        <Button
          size="small"
          type={fu?.status === 'due' ? 'primary' : 'default'}
          danger={fu?.status === 'due'}
          icon={<BellOutlined />}
          loading={busy}
          onClick={(e) => e.stopPropagation()}
        >
          {fu?.status === 'due' ? t.followUp.due : fu?.status === 'open' && fu.dueAt ? t.followUp.remindAt(formatSendAt(fu.dueAt)) : t.followUp.followUp}
          <DownOutlined style={{ fontSize: 10 }} />
        </Button>
      </Dropdown>
    );
  }

  return (
    <span onClick={(e) => e.stopPropagation()}>
      {trigger}
      {fu?.status === 'due' && (
        <Button size="small" type="link" loading={busy} onClick={() => void finish()}>
          {t.followUp.markDone}
        </Button>
      )}
      <Modal
        open={pickOpen}
        title={t.followUp.remindMe}
        okText={t.followUp.setReminder}
        okButtonProps={{ disabled: !customAt || customAt.isBefore(dayjs()) }}
        onOk={() => {
          if (!customAt) return;
          setPickOpen(false);
          void remind(customAt);
        }}
        onCancel={() => setPickOpen(false)}
        destroyOnHidden
        width={360}
      >
        <DatePicker
          showTime={{ format: 'HH:mm', minuteStep: 5 }}
          format="YYYY-MM-DD HH:mm"
          value={customAt}
          onChange={setCustomAt}
          disabledDate={(d) => d.isBefore(dayjs(), 'day') || d.isAfter(dayjs().add(1, 'year'))}
          needConfirm={false}
          style={{ width: '100%' }}
        />
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
          {t.followUp.pickHint}
        </Typography.Paragraph>
      </Modal>
    </span>
  );
}
