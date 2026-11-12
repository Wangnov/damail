/**
 * 非隐式 TLS 的 SMTP / IMAP 连接是否允许不加密：只有不经代理、直接连回环 IP（127.0.0.0/8、::1）才允许，
 * 例如本地的 Mailpit、同机 Postfix。
 * - 只认 IP 字面量：localhost 之类的主机名由 DNS 解析，可能被解析到远程地址
 * - 经代理时目标地址由代理解析，127.0.0.1 指的是代理那一端，中间的链路也不可信
 * 其他情况必须 STARTTLS 成功后才能登录，否则中间人去掉 STARTTLS 能力就能拿到明文密码。
 */
export function allowsPlaintext(host: string, proxy?: string | null): boolean {
  if (proxy) return false;
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === '::1' || /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}
