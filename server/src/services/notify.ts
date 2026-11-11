import { createHmac } from 'node:crypto';
import { and, arrayContains, eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { channels, type Channel, type Draft } from '../db/schema.js';
import { L } from '../i18n/index.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { OutboundError, safeRequest, type SafeResponse } from '../lib/safe-fetch.js';
import { enqueue, registerJob, RetryableError } from './jobs.js';

const EVENT_LABELS = () => ({
  'message.received': L('收到新邮件（所有收件箱新邮件）', 'New mail (all inbox messages)'),
  'message.important': L('AI 判定为高优先级的新邮件', 'New mail marked high priority by AI'),
  'message.verification': L('收到验证码', 'Verification code received'),
  'draft.pending': L('Agent 提交了待审批的邮件', 'An agent submitted mail for approval'),
  'draft.sent': L('邮件已发送', 'Mail sent'),
  'draft.failed': L('邮件发送失败', 'Mail failed to send'),
  'followup.due': L('跟进提醒到期，发出的邮件还没有回复', 'Follow-up due: no reply to a sent message yet'),
  'account.error': L('邮箱账户连接异常', 'Mailbox connection problem'),
  'report.daily': L('每日邮件日报', 'Daily mail report'),
  'report.weekly': L('每周邮件周报', 'Weekly mail report'),
});

/** 事件名 → 当前语言的说明 */
export const eventLabels = (): Record<EventName, string> => EVENT_LABELS();
export const EVENT_NAMES = Object.keys(EVENT_LABELS()) as EventName[];

export type EventName = keyof ReturnType<typeof EVENT_LABELS>;

const url = z.url({ error: () => L('地址格式不正确', 'Invalid URL') });

export const channelConfigs = {
  bark: z.object({
    server: url.default('https://api.day.app'),
    key: z
      .string()
      .trim()
      .min(1, { error: () => L('请填写 Bark Key', 'Enter the Bark key') }),
  }),
  wecom: z.object({
    webhook: url.refine((u) => u.includes('qyapi.weixin.qq.com'), {
      error: () => L('请填写企业微信群机器人的 Webhook 地址', 'Enter the WeCom group bot webhook URL'),
    }),
  }),
  dingtalk: z.object({
    webhook: url.refine((u) => u.includes('oapi.dingtalk.com/robot/send'), {
      error: () => L('请填写钉钉群机器人的 Webhook 地址', 'Enter the DingTalk group bot webhook URL'),
    }),
    // 安全设置选了「加签」时的 SEC 开头密钥
    secret: z.string().trim().optional(),
  }),
  feishu: z.object({ webhook: url, secret: z.string().trim().optional() }),
  telegram: z.object({
    botToken: z
      .string()
      .trim()
      .min(1, { error: () => L('请填写 Bot Token', 'Enter the bot token') }),
    chatId: z
      .string()
      .trim()
      .min(1, { error: () => L('请填写 Chat ID', 'Enter the chat ID') }),
    // 服务器无法直连 Telegram 时可以填反向代理地址
    apiBase: url.default('https://api.telegram.org'),
  }),
  webhook: z.object({ url, secret: z.string().trim().optional() }),
};

export type ChannelType = keyof typeof channelConfigs;
export const CHANNEL_TYPES = Object.keys(channelConfigs) as ChannelType[];

export type Notice = {
  event: string;
  title: string;
  body: string;
  url?: string;
  // 可一键复制的内容（验证码）
  copy?: string;
  data?: Record<string, unknown>;
};

export function parseChannelConfig(type: string, input: unknown) {
  const schema = channelConfigs[type as ChannelType];
  if (!schema) throw new Error(L(`不支持的渠道类型 ${type}`, `Unsupported channel type ${type}`));
  // 表单里清空的可选字段会以空串提交，按未填写处理以便使用默认值
  const cleaned = Object.fromEntries(Object.entries((input ?? {}) as Record<string, unknown>).filter(([, v]) => v !== '' && v != null));
  return schema.parse(cleaned);
}

export function encryptChannelConfig(cfg: object) {
  return encryptSecret(JSON.stringify(cfg));
}

export function readChannelConfig(ch: Channel): Record<string, string> {
  return JSON.parse(decryptSecret(ch.configEnc));
}

/** 返回给前端时隐藏密钥，只保留前后几位 */
export function maskedConfig(ch: Channel) {
  const cfg = readChannelConfig(ch);
  const mask = (v: string) => (v.length > 12 ? `${v.slice(0, 4)}…${v.slice(-4)}` : '••••');
  const secretKeys = new Set(['key', 'secret', 'botToken', 'webhook', 'url']);
  return Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, secretKeys.has(k) && v ? mask(String(v)) : v]));
}

async function post(target: string, body: unknown, headers: Record<string, string> = {}) {
  let res: SafeResponse;
  try {
    res = await safeRequest({
      url: target,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      allowPrivate: config.allowPrivateWebhooks,
    });
  } catch (err) {
    if (err instanceof OutboundError && err.code === 'blocked')
      throw new Error(
        L(
          `${err.message}。确实要推送到内网服务时，设置环境变量 ALLOW_PRIVATE_WEBHOOKS=true`,
          `${err.message}. To push to a private network service, set ALLOW_PRIVATE_WEBHOOKS=true`,
        ),
      );
    // 请求已经发出但没等到响应时不重试，免得重复推送
    if (err instanceof OutboundError && (err.code === 'bad_url' || err.code === 'unconfirmed')) throw err;
    throw new RetryableError(L(`无法连接：${(err as Error).message}`, `Connection failed: ${(err as Error).message}`));
  }
  const text = res.text;
  // 不跟随跳转：Webhook 地址应该直接可用
  if (res.status >= 300 && res.status < 400)
    throw new Error(L(`HTTP ${res.status}：地址发生了跳转，请填写最终地址`, `HTTP ${res.status}: the URL redirects; enter the final URL`));
  if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}：${text.slice(0, 200)}`);
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function plain(n: Notice) {
  return [n.title, n.body, n.url].filter(Boolean).join('\n');
}

export async function sendToChannel(ch: Channel, n: Notice) {
  const cfg = readChannelConfig(ch);
  switch (ch.type as ChannelType) {
    case 'bark': {
      const r = await post(`${cfg.server!.replace(/\/+$/, '')}/push`, {
        device_key: cfg.key,
        title: n.title,
        body: n.body,
        url: n.url,
        group: 'DaMail',
        ...(n.copy ? { copy: n.copy, autoCopy: '1' } : {}),
      });
      if (r.code !== 200) throw new Error(L(`Bark 返回错误：${r.message ?? JSON.stringify(r)}`, `Bark error: ${r.message ?? JSON.stringify(r)}`));
      return;
    }
    case 'wecom': {
      const content = [`**${n.title}**`, n.body, ...(n.url ? [L(`[打开 DaMail](${n.url})`, `[Open DaMail](${n.url})`)] : [])].join('\n');
      const r = await post(cfg.webhook!, { msgtype: 'markdown', markdown: { content } });
      if (r.errcode !== 0) throw new Error(L(`企业微信返回错误：${r.errmsg ?? JSON.stringify(r)}`, `WeCom error: ${r.errmsg ?? JSON.stringify(r)}`));
      return;
    }
    case 'dingtalk': {
      // 正文末尾固定带 DaMail，机器人安全设置用「自定义关键词」时填 DaMail 即可
      const text = [
        `### ${n.title}`,
        n.body.replace(/\n/g, '  \n'),
        n.url ? L(`[打开 DaMail](${n.url})`, `[Open DaMail](${n.url})`) : L('> 来自 DaMail', '> From DaMail'),
      ].join('\n\n');
      let target = cfg.webhook!;
      if (cfg.secret) {
        // 钉钉加签：以 secret 为密钥对 "timestamp\nsecret" 做 HMAC-SHA256，时间戳是毫秒
        const timestamp = Date.now().toString();
        const sign = createHmac('sha256', cfg.secret).update(`${timestamp}\n${cfg.secret}`).digest('base64');
        target += `${target.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
      }
      const r = await post(target, { msgtype: 'markdown', markdown: { title: n.title, text } });
      if (r.errcode !== 0) throw new Error(L(`钉钉返回错误：${r.errmsg ?? JSON.stringify(r)}`, `DingTalk error: ${r.errmsg ?? JSON.stringify(r)}`));
      return;
    }
    case 'feishu': {
      const body: Record<string, unknown> = { msg_type: 'text', content: { text: plain(n) } };
      if (cfg.secret) {
        // 飞书签名校验：以 "timestamp\nsecret" 为密钥对空串做 HMAC-SHA256
        const timestamp = Math.floor(Date.now() / 1000).toString();
        body.timestamp = timestamp;
        body.sign = createHmac('sha256', `${timestamp}\n${cfg.secret}`).update('').digest('base64');
      }
      const r = await post(cfg.webhook!, body);
      if ((r.code ?? r.StatusCode) !== 0) throw new Error(L(`飞书返回错误：${r.msg ?? JSON.stringify(r)}`, `Feishu error: ${r.msg ?? JSON.stringify(r)}`));
      return;
    }
    case 'telegram': {
      const r = await post(`${cfg.apiBase!.replace(/\/+$/, '')}/bot${cfg.botToken}/sendMessage`, {
        chat_id: cfg.chatId,
        text: plain(n),
        disable_web_page_preview: true,
      });
      if (r.ok !== true)
        throw new Error(L(`Telegram 返回错误：${r.description ?? JSON.stringify(r)}`, `Telegram error: ${r.description ?? JSON.stringify(r)}`));
      return;
    }
    case 'webhook': {
      const payload = JSON.stringify({ ...n, timestamp: new Date().toISOString() });
      // 请求头只能是 ASCII
      const headers: Record<string, string> = { 'x-damail-event': encodeURIComponent(n.event) };
      // 接收方用同一个 secret 对原始请求体做 HMAC-SHA256 校验来源
      if (cfg.secret) headers['x-damail-signature'] = `sha256=${createHmac('sha256', cfg.secret).update(payload).digest('hex')}`;
      await post(cfg.url!, payload, headers);
      return;
    }
    default:
      throw new Error(L(`不支持的渠道类型 ${ch.type}`, `Unsupported channel type ${ch.type}`));
  }
}

registerJob(
  'notify',
  async (payload) => {
    const ch = await db.query.channels.findFirst({ where: eq(channels.id, Number(payload.channelId)) });
    if (!ch) throw new Error(L('渠道已删除', 'Channel deleted'));
    if (!ch.enabled) return { skipped: L('渠道已停用', 'Channel disabled') };
    await sendToChannel(ch, payload.notice as Notice);
    return { channel: ch.name };
  },
  4,
);

export async function notifyChannel(channelId: number, notice: Notice) {
  await enqueue('notify', { channelId, notice });
}

/** 发布全局事件：投递给订阅了该事件的所有渠道 */
export async function emitEvent(event: EventName, notice: Omit<Notice, 'event'>) {
  const list = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.enabled, true), arrayContains(channels.events, [event])));
  for (const ch of list) await notifyChannel(ch.id, { ...notice, event });
}

export function appUrl(path: string) {
  return `${config.publicUrl.replace(/\/+$/, '')}${path}`;
}

const DRAFT_TITLE = () => ({
  'draft.pending': L('待审批', 'Awaiting approval'),
  'draft.sent': L('已发送', 'Sent'),
  'draft.failed': L('发送失败', 'Failed to send'),
});

/** 草稿状态变化的通知：不包含正文，只带收件人和主题 */
export function emitDraftEvent(event: keyof ReturnType<typeof DRAFT_TITLE>, d: Draft) {
  const to = d.to.map((a) => a.name || a.address).join(L('、', ', ')) || L('(无收件人)', '(no recipients)');
  const lines = [L(`收件人：${to}`, `To: ${to}`)];
  if (event === 'draft.pending' && d.note) lines.push(L(`说明：${d.note}`, `Note: ${d.note}`));
  if (event === 'draft.failed' && d.error) lines.push(L(`原因：${d.error}`, `Reason: ${d.error}`));
  void emitEvent(event, {
    title: `${DRAFT_TITLE()[event]}${L('：', ': ')}${d.subject || L('(无主题)', '(no subject)')}`,
    body: lines.join('\n'),
    url: appUrl('/outbox'),
    data: { draftId: d.id, accountId: d.accountId, status: d.status, source: d.source, subject: d.subject, to: d.to },
  }).catch((err) => console.error('[notify]', err));
}
