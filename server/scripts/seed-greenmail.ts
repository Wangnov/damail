/**
 * 向本地 GreenMail 投递一批测试邮件（中文编码、HTML 内嵌图、附件、回复会话、远程图片）。
 * 用法：pnpm --filter server exec tsx scripts/seed-greenmail.ts [收件人，默认 alice@local.test]
 */
import nodemailer from 'nodemailer';

const to = process.argv[2] ?? 'alice@local.test';
const transport = nodemailer.createTransport({ host: '127.0.0.1', port: 3025, secure: false, tls: { rejectUnauthorized: false } });

// 1x1 红色 PNG
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

const rootId = `<order-${Date.now()}@shop.example>`;

const mails: nodemailer.SendMailOptions[] = [
  {
    from: '"亚马逊卖家中心" <seller-notification@amazon.example>',
    subject: '【重要】您的账户健康状况需要关注',
    text: '您好，\n\n您的店铺订单缺陷率已超过 1%，请在 7 天内提交行动计划。\n\n亚马逊卖家支持',
    messageId: `<health-${Date.now()}@amazon.example>`,
  },
  {
    from: '"供应商 王经理" <wang@supplier.example>',
    subject: '10 月对账单及发票',
    html: '<p>您好，附件是 10 月对账单，请查收。</p><p><img src="cid:logo@supplier"> 深圳某某供应链</p><p><img src="https://tracker.example/pixel.gif?id=123" width="1" height="1"></p>',
    attachments: [
      { filename: 'logo.png', content: png, cid: 'logo@supplier' },
      { filename: '10月对账单.csv', content: '日期,金额\n2026-10-01,1200.00\n2026-10-15,860.50\n' },
    ],
    messageId: `<bill-${Date.now()}@supplier.example>`,
  },
  {
    from: '"Bob" <bob@local.test>',
    subject: 'Order #1024 shipping question',
    text: 'Hi, when will order #1024 ship?',
    messageId: rootId,
  },
  {
    from: '"Bob" <bob@local.test>',
    subject: 'Re: Order #1024 shipping question',
    text: 'Following up — any update?\n\n> Hi, when will order #1024 ship?',
    messageId: `<order-followup-${Date.now()}@shop.example>`,
    inReplyTo: rootId,
    references: [rootId],
  },
  {
    from: '"GBK 测试" <gbk@legacy.example>',
    subject: '旧系统 GBK 编码邮件：验证码 834920',
    text: '您的验证码是 834920，5 分钟内有效。',
    textEncoding: 'base64',
    headers: { 'X-Test': 'gbk' },
    encoding: 'gbk',
  } as nodemailer.SendMailOptions,
];

for (const mail of mails) {
  const info = await transport.sendMail({ to, ...mail });
  console.log('sent', mail.subject, info.messageId);
}
