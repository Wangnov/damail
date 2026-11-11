import { CheckOutlined, StopOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { App, Button, Tag, Tooltip } from 'antd';
import { api, type UnsubscribeMethod, type UnsubscribeResult } from '../api';
import { fullDate } from '../lib/format';
import { t } from '../i18n';

/** 退订方式的名字和说明，按当前界面语言取；正文里找到的链接单独说明 */
export const unsubscribeMethod = (m: UnsubscribeMethod, fromBody?: boolean) => (m === 'link' && fromBody ? t.unsubscribe.bodyLink : t.unsubscribe.methods[m]);

type Target = { messageId: number; method: UnsubscribeMethod; url?: string; fromBody?: boolean; sender: string };

const hostOf = (url?: string) => {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return '';
  }
};

/** 确认后退订：一键退订和退订邮件由服务端处理，退订网页在点击时直接打开（避免被拦截弹窗） */
export function useUnsubscribe() {
  const { modal, message } = App.useApp();
  const qc = useQueryClient();

  const run = async (target: Target) => {
    try {
      const res = await api<UnsubscribeResult>(`/api/v1/messages/${target.messageId}/unsubscribe`, { method: 'POST' });
      if (res.status === 'unconfirmed') message.warning(res.message);
      else if (target.method !== 'link') message.success(res.message);
      await Promise.all(['thread', 'subscriptions', 'drafts'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      return true;
    } catch (e) {
      message.error((e as Error).message);
      return false;
    }
  };

  return (target: Target) =>
    new Promise<boolean>((resolve) => {
      modal.confirm({
        title: t.unsubscribe.confirmTitle(target.sender),
        icon: <StopOutlined />,
        // 打开网页前显示域名，方便确认不是可疑网址
        content: (
          <>
            {unsubscribeMethod(target.method, target.fromBody).hint + t.unsubscribe.period}
            {target.method === 'link' && hostOf(target.url) && (
              <div style={{ marginTop: 6, color: 'var(--ant-color-text-tertiary)', wordBreak: 'break-all' }}>{t.unsubscribe.willOpen(hostOf(target.url))}</div>
            )}
          </>
        ),
        okText: target.method === 'link' ? t.unsubscribe.openPage : t.unsubscribe.unsubscribe,
        okButtonProps: { danger: target.method !== 'link' },
        onOk: async () => {
          if (target.method === 'link' && target.url) window.open(target.url, '_blank', 'noopener,noreferrer');
          resolve(await run(target));
        },
        onCancel: () => resolve(false),
      });
    });
}

const UNSUBSCRIBED_COLOR: Record<string, string> = { unconfirmed: 'warning' };

export function UnsubscribedTag({ at, status }: { at: string; status: string }) {
  const s = t.unsubscribe.status[status] ?? t.unsubscribe.status.done!;
  return (
    <Tooltip title={`${fullDate(at)}${s.hint ? `${t.unsubscribe.hintSep}${s.hint}` : ''}`}>
      <Tag
        color={UNSUBSCRIBED_COLOR[status]}
        icon={<CheckOutlined />}
        style={{ marginInlineEnd: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'middle' }}
      >
        {s.text}
      </Tag>
    </Tooltip>
  );
}

/** 邮件详情里的退订按钮；已经退订过就显示标签 */
export function UnsubscribeButton({ target, unsubscribed }: { target: Target; unsubscribed: { status: string; at: string } | null }) {
  const unsubscribe = useUnsubscribe();
  if (unsubscribed && unsubscribed.status !== 'failed') return <UnsubscribedTag {...unsubscribed} />;
  return (
    <Tooltip title={unsubscribeMethod(target.method, target.fromBody).hint}>
      <Button
        size="small"
        type="text"
        icon={<StopOutlined />}
        style={{ fontSize: 12 }}
        onClick={(e) => {
          e.stopPropagation();
          void unsubscribe(target);
        }}
      >
        {t.unsubscribe.unsubscribe}
      </Button>
    </Tooltip>
  );
}
