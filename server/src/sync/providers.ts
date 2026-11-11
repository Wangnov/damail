import { L } from '../i18n/index.js';
export type ProviderPreset = {
  id: string;
  name: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  /** 登录用户名是否就是完整邮箱地址 */
  usernameIsEmail: boolean;
  secretLabel: string;
  help: string;
  /** Gmail 会自动把通过 SMTP 发出的邮件存入"已发送"，P1 发信时不需要 APPEND */
  autoSavesSent?: boolean;
  /** 服务商已停用密码登录，只能 OAuth2 授权 */
  requiresOAuth?: boolean;
  domains: string[];
};

export const providers: ProviderPreset[] = [
  {
    id: 'qq',
    get name() {
      return L('QQ 邮箱', 'QQ Mail');
    },
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
    usernameIsEmail: true,
    get secretLabel() {
      return L('授权码', 'Authorization code');
    },
    get help() {
      return L('QQ 邮箱 → 设置 → 账号 → 开启 IMAP/SMTP 服务，按提示生成授权码（不是 QQ 密码）。', 'QQ Mail → Settings → Account → turn on the IMAP/SMTP service and generate an authorization code as prompted (not your QQ password).');
    },
    domains: ['qq.com', 'foxmail.com', 'vip.qq.com'],
  },
  {
    id: '163',
    get name() {
      return L('网易 163 邮箱', 'NetEase 163 Mail');
    },
    imap: { host: 'imap.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.163.com', port: 465, secure: true },
    usernameIsEmail: true,
    get secretLabel() {
      return L('授权码', 'Authorization code');
    },
    get help() {
      return L('163 邮箱 → 设置 → POP3/SMTP/IMAP → 开启 IMAP 服务并新增授权密码。', '163 Mail → Settings → POP3/SMTP/IMAP → turn on IMAP and add an authorization password.');
    },
    domains: ['163.com'],
  },
  {
    id: '126',
    get name() {
      return L('网易 126 邮箱', 'NetEase 126 Mail');
    },
    imap: { host: 'imap.126.com', port: 993, secure: true },
    smtp: { host: 'smtp.126.com', port: 465, secure: true },
    usernameIsEmail: true,
    get secretLabel() {
      return L('授权码', 'Authorization code');
    },
    get help() {
      return L('126 邮箱 → 设置 → POP3/SMTP/IMAP → 开启 IMAP 服务并新增授权密码。', '126 Mail → Settings → POP3/SMTP/IMAP → turn on IMAP and add an authorization password.');
    },
    domains: ['126.com'],
  },
  {
    id: 'gmail',
    name: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    usernameIsEmail: true,
    get secretLabel() {
      return L('应用专用密码', 'App password');
    },
    get help() {
      return L('Google 账号需先开启两步验证，然后在 myaccount.google.com/apppasswords 生成 16 位应用专用密码；也可以改用 OAuth2 授权。服务器需能访问 Google。', 'Turn on 2-Step Verification for your Google account first, then generate a 16-character app password at myaccount.google.com/apppasswords. You can also use OAuth2 instead. The server must be able to reach Google.');
    },
    autoSavesSent: true,
    domains: ['gmail.com', 'googlemail.com'],
  },
  {
    id: 'icloud',
    get name() {
      return L('iCloud 邮件', 'iCloud Mail');
    },
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    usernameIsEmail: true,
    get secretLabel() {
      return L('App 专用密码', 'App-specific password');
    },
    get help() {
      return L('在 account.apple.com → 登录与安全 → App 专用密码 中生成。', 'Generate one at account.apple.com → Sign-In and Security → App-Specific Passwords.');
    },
    domains: ['icloud.com', 'me.com', 'mac.com'],
  },
  {
    id: 'outlook',
    name: 'Outlook / Hotmail',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    usernameIsEmail: true,
    get secretLabel() {
      return L('密码', 'Password');
    },
    get help() {
      return L('微软已停用 IMAP 密码登录，请在「OAuth2 授权」里用 Microsoft 账号登录（需要先配置 Microsoft 应用）。', 'Microsoft has turned off IMAP password sign-in. Use "OAuth2" to sign in with your Microsoft account (set up a Microsoft app first).');
    },
    requiresOAuth: true,
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
  },
  {
    id: 'exmail',
    get name() {
      return L('腾讯企业邮', 'Tencent Exmail');
    },
    imap: { host: 'imap.exmail.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.exmail.qq.com', port: 465, secure: true },
    usernameIsEmail: true,
    get secretLabel() {
      return L('密码', 'Password');
    },
    get help() {
      return L('若开启了安全登录，需要在企业邮 → 设置 → 账户 → 客户端专用密码 中生成。', 'If secure login is on, generate a client-specific password under Exmail → Settings → Account → Client-specific password.');
    },
    domains: [],
  },
  {
    id: 'yeah',
    get name() {
      return L('网易 yeah.net', 'NetEase yeah.net');
    },
    imap: { host: 'imap.yeah.net', port: 993, secure: true },
    smtp: { host: 'smtp.yeah.net', port: 465, secure: true },
    usernameIsEmail: true,
    get secretLabel() {
      return L('授权码', 'Authorization code');
    },
    get help() {
      return L('yeah.net 邮箱 → 设置 → POP3/SMTP/IMAP → 开启 IMAP 服务并新增授权密码。', 'yeah.net Mail → Settings → POP3/SMTP/IMAP → turn on IMAP and add an authorization password.');
    },
    domains: ['yeah.net'],
  },
  {
    id: 'aliyun-personal',
    get name() {
      return L('阿里个人邮箱', 'Alibaba Mail (personal)');
    },
    imap: { host: 'imap.aliyun.com', port: 993, secure: true },
    smtp: { host: 'smtp.aliyun.com', port: 465, secure: true },
    usernameIsEmail: true,
    get secretLabel() {
      return L('密码', 'Password');
    },
    get help() {
      return L('网页版 → 设置 → 账户 → POP3/SMTP 及 IMAP/SMTP 中开启 IMAP；如开启了三方客户端安全密码，需填写该密码。', 'In web mail, go to Settings → Account → POP3/SMTP and IMAP/SMTP and turn on IMAP. If a third-party client password is set, enter that password.');
    },
    domains: ['aliyun.com'],
  },
  {
    id: 'aliyun',
    get name() {
      return L('阿里企业邮', 'Alibaba Mail (business)');
    },
    imap: { host: 'imap.qiye.aliyun.com', port: 993, secure: true },
    smtp: { host: 'smtp.qiye.aliyun.com', port: 465, secure: true },
    usernameIsEmail: true,
    get secretLabel() {
      return L('密码', 'Password');
    },
    get help() {
      return L('如开启了三方客户端安全密码，请在 设置 → 账户与安全 中生成后使用。', 'If a third-party client password is enabled, generate one under Settings → Account & Security and use it.');
    },
    domains: [],
  },
  {
    id: 'qiye163',
    get name() {
      return L('网易企业邮', 'NetEase Enterprise Mail');
    },
    imap: { host: 'imap.qiye.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.qiye.163.com', port: 465, secure: true },
    usernameIsEmail: true,
    get secretLabel() {
      return L('密码', 'Password');
    },
    get help() {
      return L('如开启了客户端授权码，请在网页版 设置 → 客户端设置 中生成。', 'If client authorization codes are enabled, generate one in web mail under Settings → Client settings.');
    },
    domains: [],
  },
  {
    id: 'custom',
    get name() {
      return L('其他 IMAP', 'Other IMAP');
    },
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    usernameIsEmail: true,
    get secretLabel() {
      return L('密码', 'Password');
    },
    get help() {
      return L('填写服务商提供的 IMAP / SMTP 地址。', 'Enter the IMAP / SMTP servers from your provider.');
    },
    domains: [],
  },
];

export function getProvider(id: string): ProviderPreset {
  return providers.find((p) => p.id === id) ?? providers[providers.length - 1]!;
}
