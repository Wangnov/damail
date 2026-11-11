type Field = { label: string; placeholder?: string; extra?: string };
type TypeText = { label: string; desc: string; steps: string[]; fields: Record<string, Field> };
type Types = Record<'bark' | 'wecom' | 'dingtalk' | 'feishu' | 'telegram' | 'webhook', TypeText>;

// 步骤里 **文字** 加粗、`文字` 显示为代码
const zhTypes: Types = {
  bark: {
    label: 'Bark',
    desc: 'iPhone 系统推送',
    steps: ['在 iPhone 上安装 Bark App', '首页复制推送地址，形如 https://api.day.app/XXXX/', '把其中的 XXXX 填到下面的 Key'],
    fields: {
      key: { label: 'Key', placeholder: '推送地址里 api.day.app/ 后面那段' },
      server: { label: '服务器', placeholder: 'https://api.day.app', extra: '自建 Bark 服务时才需要修改' },
    },
  },
  wecom: {
    label: '企业微信',
    desc: '推送到企业微信群',
    steps: ['打开要接收通知的群聊，点右上角「…」', '选择「消息推送」（或「群机器人」）→ 添加机器人', '复制机器人的 Webhook 地址'],
    fields: { webhook: { label: 'Webhook 地址', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…' } },
  },
  dingtalk: {
    label: '钉钉',
    desc: '推送到钉钉群',
    steps: [
      '群设置 → 机器人 → 添加机器人 → 自定义（通过 Webhook 接入）',
      '安全设置二选一：**自定义关键词**填 DaMail，或者选**加签**并复制 SEC 开头的密钥',
      '完成后复制 Webhook 地址',
    ],
    fields: {
      webhook: { label: 'Webhook 地址', placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=…' },
      secret: { label: '加签密钥', placeholder: 'SEC…', extra: '安全设置用的是「自定义关键词」时留空' },
    },
  },
  feishu: {
    label: '飞书',
    desc: '推送到飞书群',
    steps: ['群设置 → 群机器人 → 添加机器人 → 自定义机器人', '复制 Webhook 地址', '如果开启了「签名校验」，同时复制密钥'],
    fields: {
      webhook: { label: 'Webhook 地址', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…' },
      secret: { label: '签名密钥', extra: '没开启签名校验时留空' },
    },
  },
  telegram: {
    label: 'Telegram',
    desc: 'Telegram 机器人推送',
    steps: ['找 @BotFather 发送 /newbot 创建机器人，复制 Token', '给你的机器人发一条消息', '打开 api.telegram.org/bot<Token>/getUpdates，找到 chat.id'],
    fields: {
      botToken: { label: 'Bot Token', placeholder: '123456:ABC-DEF…' },
      chatId: { label: 'Chat ID', placeholder: '个人是数字，群组以 - 开头' },
      apiBase: { label: 'API 地址', placeholder: 'https://api.telegram.org', extra: '服务器无法直连 Telegram 时可以填反向代理' },
    },
  },
  webhook: {
    label: 'Webhook',
    desc: '推送到你自己的服务',
    steps: [
      '请求体：`{ event, title, body, url, data, timestamp }`',
      '请求头 `x-damail-event` 是事件名',
      '填了密钥时带 `x-damail-signature: sha256=HMAC(密钥, 原始请求体)`',
    ],
    fields: {
      url: { label: 'URL', placeholder: 'https://example.com/hooks/damail' },
      secret: { label: '签名密钥', extra: '用来校验请求来自 DaMail，可以留空' },
    },
  },
};

const enTypes: Types = {
  bark: {
    label: 'Bark',
    desc: 'iPhone push notifications',
    steps: [
      'Install the Bark app on your iPhone',
      'Copy the push URL from its home screen, like https://api.day.app/XXXX/',
      'Enter the XXXX part as the Key below',
    ],
    fields: {
      key: { label: 'Key', placeholder: 'The part after api.day.app/ in the push URL' },
      server: { label: 'Server', placeholder: 'https://api.day.app', extra: 'Only change this for a self-hosted Bark server' },
    },
  },
  wecom: {
    label: 'WeCom',
    desc: 'Post to a WeCom group',
    steps: ['Open the group chat and tap "…" in the top right', 'Choose "Message push" (or "Group robot") → Add robot', "Copy the robot's webhook URL"],
    fields: { webhook: { label: 'Webhook URL', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…' } },
  },
  dingtalk: {
    label: 'DingTalk',
    desc: 'Post to a DingTalk group',
    steps: [
      'Group settings → Robots → Add robot → Custom (via webhook)',
      'Pick one security option: **Custom keywords** with DaMail, or **Signature** and copy the secret starting with SEC',
      'Copy the webhook URL when done',
    ],
    fields: {
      webhook: { label: 'Webhook URL', placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=…' },
      secret: { label: 'Signing secret', placeholder: 'SEC…', extra: 'Leave blank if you chose "Custom keywords"' },
    },
  },
  feishu: {
    label: 'Feishu / Lark',
    desc: 'Post to a Feishu group',
    steps: ['Group settings → Bots → Add bot → Custom bot', 'Copy the webhook URL', 'If "Signature verification" is on, copy the secret too'],
    fields: {
      webhook: { label: 'Webhook URL', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…' },
      secret: { label: 'Signing secret', extra: 'Leave blank if signature verification is off' },
    },
  },
  telegram: {
    label: 'Telegram',
    desc: 'Telegram bot messages',
    steps: [
      'Message @BotFather with /newbot to create a bot and copy the token',
      'Send your bot a message',
      'Open api.telegram.org/bot<Token>/getUpdates and find chat.id',
    ],
    fields: {
      botToken: { label: 'Bot token', placeholder: '123456:ABC-DEF…' },
      chatId: { label: 'Chat ID', placeholder: 'A number for people; groups start with -' },
      apiBase: { label: 'API base URL', placeholder: 'https://api.telegram.org', extra: "Use a reverse proxy if the server can't reach Telegram directly" },
    },
  },
  webhook: {
    label: 'Webhook',
    desc: 'Post to your own service',
    steps: [
      'Request body: `{ event, title, body, url, data, timestamp }`',
      'The `x-damail-event` header carries the event name',
      'With a secret set, requests include `x-damail-signature: sha256=HMAC(secret, raw body)`',
    ],
    fields: {
      url: { label: 'URL', placeholder: 'https://example.com/hooks/damail' },
      secret: { label: 'Signing secret', extra: 'Lets you verify requests come from DaMail. Optional' },
    },
  },
};

const zh = {
  types: zhTypes,
  groups: { received: '收信', sending: '发信', reports: '日报周报', system: '系统', other: '其他' },
  delivery: { queued: '排队中', running: '发送中', done: '成功', failed: '失败' },
  testSent: '测试消息已发出，请检查是否收到',
  sendFailed: '发送失败',
  title: '通知渠道',
  desc: '订阅事件后自动推送；也可以在收信规则里用「推送通知」动作指定渠道。',
  add: '添加渠道',
  name: '名称',
  events: '订阅事件',
  rulesOnly: '仅规则触发',
  enabled: '启用',
  history: '推送记录',
  deleteTitle: '删除这个渠道？引用它的规则动作将失效',
  addTitle: '添加通知渠道',
  editTitle: '编辑通知渠道',
  sendTest: '发送测试',
  type: '渠道类型',
  connection: '连接信息',
  nameRequired: '请填写名称',
  namePlaceholder: (label: string) => `例如：我的${label}`,
  masked: '显示为遮盖值时表示保持不变',
  extraSep: '；',
  fieldRequired: (label: string) => `请填写${label}`,
  pushEvents: '推送事件',
  pushEventsExtra: '都不勾选时，只有收信规则的「推送通知」动作会用到这个渠道。同一封邮件对一个渠道只推送一次。',
  recommended: '推荐',
  all: '全选',
  clear: '清空',
  historyTitle: (name: string) => `推送记录：${name}`,
  content: '内容',
  status: '状态',
};

const en: typeof zh = {
  types: enTypes,
  groups: { received: 'Incoming', sending: 'Outgoing', reports: 'Reports', system: 'System', other: 'Other' },
  delivery: { queued: 'Queued', running: 'Sending', done: 'Sent', failed: 'Failed' },
  testSent: 'Test message sent. Check whether it arrived',
  sendFailed: 'Send failed',
  title: 'Notification channels',
  desc: 'Subscribed events are pushed automatically. Inbox rules can also target a channel with the "Send notification" action.',
  add: 'Add channel',
  name: 'Name',
  events: 'Events',
  rulesOnly: 'Rules only',
  enabled: 'Enabled',
  history: 'Delivery history',
  deleteTitle: 'Delete this channel? Rule actions using it will stop working',
  addTitle: 'Add notification channel',
  editTitle: 'Edit notification channel',
  sendTest: 'Send test',
  type: 'Channel type',
  connection: 'Connection',
  nameRequired: 'Enter a name',
  namePlaceholder: (label: string) => `e.g. My ${label}`,
  masked: 'A masked value means it stays unchanged',
  extraSep: '. ',
  fieldRequired: (label: string) => `Enter the ${label}`,
  pushEvents: 'Events',
  pushEventsExtra:
    'With none selected, this channel is only used by the "Send notification" action in inbox rules. Each email is pushed to a channel at most once.',
  recommended: 'Recommended',
  all: 'All',
  clear: 'Clear',
  historyTitle: (name: string) => `Delivery history: ${name}`,
  content: 'Content',
  status: 'Status',
};

export default { zh, en };
