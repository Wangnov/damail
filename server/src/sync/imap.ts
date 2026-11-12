import { ImapFlow } from 'imapflow';
import { L } from '../i18n/index.js';
import { allowsPlaintext } from '../lib/transport-security.js';

export type ImapParams = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password?: string;
  /** OAuth2 账户用 XOAUTH2 登录 */
  accessToken?: string;
  /** 代理地址，如 socks5://user:pass@host:1080 */
  proxy?: string;
};

export function createImapClient(p: ImapParams): ImapFlow {
  return new ImapFlow({
    host: p.host,
    port: p.port,
    secure: p.secure,
    // 非隐式 TLS 时强制 STARTTLS：服务器不支持（或被中间人去掉）就不登录，避免密码明文传输
    ...(!p.secure && !allowsPlaintext(p.host, p.proxy) ? { doSTARTTLS: true } : {}),
    auth: p.accessToken ? { user: p.username, accessToken: p.accessToken } : { user: p.username, pass: p.password ?? '' },
    ...(p.proxy ? { proxy: p.proxy } : {}),
    // 网易系邮箱要求客户端发送 IMAP ID，否则会报 "Unsafe Login"
    clientInfo: { name: 'DaMail', version: '0.1.0', vendor: 'DaMail' },
    logger: false,
    // 定期重启 IDLE，顺便探测静默断开的连接（部分国内服务商约 30 分钟断开空闲连接）
    maxIdleTime: 4 * 60 * 1000,
    // 默认空闲 15 秒才进入 IDLE，这段时间内服务器的新邮件通知会被延后，改为 1 秒
    autoIdleDelay: 1000,
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
  });
}

type ImapError = Error & { code?: string; responseText?: string; authenticationFailed?: boolean };

export function describeImapError(err: unknown): string {
  const e = err as ImapError;
  const text = `${e?.responseText ?? ''} ${e?.message ?? ''}`;
  if (/unsafe login/i.test(text)) return L('服务商拦截了不安全登录：请确认已开启 IMAP，并使用授权码登录', 'The provider blocked an insecure sign-in: make sure IMAP is enabled and sign in with an authorization code');
  // 微软：令牌有效，但这个账号的邮箱没法通过 IMAP 打开
  if (/authenticated but not connected/i.test(text))
    return L('微软已通过授权，但打不开这个账号的邮箱：请先登录 outlook.live.com 确认邮箱能正常使用，并在设置 → 邮件 → 转发和 IMAP 里允许 IMAP', "Microsoft authorized the sign-in but this account's mailbox cannot be opened: sign in at outlook.live.com to check the mailbox works, and allow IMAP under Settings → Mail → Forwarding and IMAP");
  // XOAUTH2 令牌被拒（过期、被撤销或范围不对）
  if (/AUTHENTICATE failed/i.test(text)) return L('OAuth 授权被拒绝：请在邮箱管理里重新授权', 'OAuth authorization was rejected: re-authorize it under Mailboxes');
  if (e?.authenticationFailed || /AUTHENTICATIONFAILED|LOGIN failed|authentication failed|invalid credentials/i.test(text))
    return L('认证失败：请检查用户名，并确认使用的是授权码 / 应用专用密码，而不是网页登录密码', 'Authentication failed: check the username and make sure you are using an authorization code / app password, not your web sign-in password');
  if (e?.code === 'ENOTFOUND') return L('无法解析服务器地址，请检查 IMAP 主机名', 'Could not resolve the server address; check the IMAP host name');
  if (e?.code === 'ECONNREFUSED') return L('服务器拒绝连接，请检查端口与 SSL 设置', 'The server refused the connection; check the port and SSL settings');
  if (e?.code === 'ETIMEDOUT' || e?.code === 'CONNECT_TIMEOUT' || e?.code === 'GREETING_TIMEOUT')
    return L('连接超时：服务器无法访问（网络、防火墙或地区限制）', 'Connection timed out: the server is unreachable (network, firewall or regional restrictions)');
  if (/certificate|self.signed|TLS|SSL/i.test(text)) return L(`TLS 握手失败：${e?.message}`, `TLS handshake failed: ${e?.message}`);
  return e?.responseText || e?.message || String(err);
}

export async function testImapConnection(p: ImapParams) {
  const client = createImapClient(p);
  try {
    await client.connect();
    const list = await client.list();
    const caps = [...client.capabilities.keys()];
    return {
      ok: true as const,
      folders: list.map((f) => ({ path: f.path, specialUse: f.specialUse ?? null })),
      idle: caps.includes('IDLE'),
      condstore: caps.includes('CONDSTORE'),
    };
  } catch (err) {
    return { ok: false as const, error: describeImapError(err) };
  } finally {
    await client.logout().catch(() => client.close());
  }
}
