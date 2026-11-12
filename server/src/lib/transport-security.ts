/**
 * 非隐式 TLS 的 SMTP / IMAP 连接是否允许不加密：只有连本机（例如本地的 Mailpit、同机 Postfix）才允许。
 * 其他情况必须 STARTTLS 成功后才能登录，否则中间人去掉 STARTTLS 能力就能拿到明文密码。
 */
export function allowsPlaintext(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}
