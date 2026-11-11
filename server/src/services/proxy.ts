import net from 'node:net';
import tls from 'node:tls';
import { asc, eq, sql } from 'drizzle-orm';
import { SocksClient } from 'socks';
import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import { db } from '../db/index.js';
import { accounts, proxies, type Proxy } from '../db/schema.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { L } from '../i18n/index.js';

export const PROXY_PROTOCOLS = ['http', 'https', 'socks5', 'socks4'] as const;

export const proxyInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: () => L('请填写名称', 'Enter a name') })
    .max(100),
  protocol: z.enum(PROXY_PROTOCOLS),
  host: z
    .string()
    .trim()
    .min(1, { error: () => L('请填写代理地址', 'Enter the proxy host') })
    .max(255)
    .regex(/^[\w.:-]+$/, { error: () => L('代理地址格式不对', 'Invalid proxy host') }),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().trim().max(255).nullish(),
  // 编辑时不填表示保留原来的密码
  password: z.string().max(500).optional(),
});

export type ProxyInput = z.infer<typeof proxyInput>;

export function publicProxy(p: Proxy) {
  const { passwordEnc, ...rest } = p;
  return { ...rest, hasPassword: Boolean(passwordEnc) };
}

export async function listProxies() {
  const rows = await db
    .select({ proxy: proxies, accountCount: sql<number>`(SELECT count(*) FROM accounts a WHERE a.proxy_id = "proxies"."id")::int` })
    .from(proxies)
    .orderBy(asc(proxies.id));
  return rows.map((r) => ({ ...publicProxy(r.proxy), accountCount: r.accountCount }));
}

export function proxyValues(data: ProxyInput, prev?: Proxy) {
  const username = data.username || null;
  return {
    name: data.name,
    protocol: data.protocol,
    host: data.host,
    port: data.port,
    username,
    // 去掉用户名就一并清掉密码
    passwordEnc: !username ? null : data.password ? encryptSecret(data.password) : (prev?.passwordEnc ?? null),
  };
}

/** 生成 imapflow / nodemailer 都认的代理地址，用户名密码放在 userinfo 里 */
export function proxyUrl(p: Pick<Proxy, 'protocol' | 'host' | 'port' | 'username' | 'passwordEnc'>) {
  const host = net.isIPv6(p.host) ? `[${p.host}]` : p.host;
  const auth = p.username ? `${encodeURIComponent(p.username)}:${p.passwordEnc ? encodeURIComponent(decryptSecret(p.passwordEnc)) : ''}@` : '';
  return `${p.protocol}://${auth}${host}:${p.port}`;
}

/** 账户或 OAuth 应用选的代理；没选或代理已被删除时返回 undefined，表示直连 */
export async function proxyUrlById(id: number | null | undefined) {
  if (!id) return undefined;
  const row = await db.query.proxies.findFirst({ where: eq(proxies.id, id) });
  return row ? proxyUrl(row) : undefined;
}

export async function accountsUsingProxy(id: number) {
  const rows = await db.select({ id: accounts.id, enabled: accounts.enabled }).from(accounts).where(eq(accounts.proxyId, id));
  return rows;
}

/** 通过代理建立到 host:port 的 TCP 隧道 */
export async function openTunnel(url: string, host: string, port: number, timeoutMs = 20_000): Promise<net.Socket> {
  const u = new URL(url);
  const protocol = u.protocol.replace(/:$/, '');
  const proxyHost = u.hostname.replace(/^\[|\]$/g, '');
  const proxyPort = Number(u.port);
  const username = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);

  if (protocol === 'socks5' || protocol === 'socks4') {
    const { socket } = await SocksClient.createConnection({
      proxy: { host: proxyHost, port: proxyPort, type: protocol === 'socks4' ? 4 : 5, ...(username ? { userId: username, password } : {}) },
      command: 'connect',
      destination: { host, port },
      timeout: timeoutMs,
    });
    return socket;
  }

  return new Promise<net.Socket>((resolve, reject) => {
    const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
    const socket =
      protocol === 'https'
        ? tls.connect({ host: proxyHost, port: proxyPort, ...(net.isIP(proxyHost) ? {} : { servername: proxyHost }) })
        : net.connect({ host: proxyHost, port: proxyPort });
    const timer = setTimeout(() => fail(new Error(L('连接代理超时', 'Proxy connection timed out'))), timeoutMs);
    let buf = Buffer.alloc(0);
    const fail = (err: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > 16 * 1024) fail(new Error(L('代理返回的响应头过长', 'Proxy response headers are too long')));
        return;
      }
      socket.off('data', onData);
      clearTimeout(timer);
      const status = buf.subarray(0, buf.indexOf('\r\n')).toString('latin1');
      const code = Number(status.split(' ')[1]);
      if (code !== 200) {
        socket.destroy();
        return reject(
          new Error(
            code === 407
              ? L('代理认证失败（407），请检查用户名和密码', 'Proxy authentication failed (407); check the username and password')
              : L(`代理拒绝连接：${status}`, `Proxy refused the connection: ${status}`),
          ),
        );
      }
      const rest = buf.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };
    socket.once(protocol === 'https' ? 'secureConnect' : 'connect', () => {
      const headers = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
      if (username) headers.push(`Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
      socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', onData);
    socket.once('error', fail);
  });
}

// 同一个代理复用一个连接池；改了代理地址或密码会生成新的 key
const agents = new Map<string, Agent>();

export function proxyAgent(url: string) {
  let agent = agents.get(url);
  if (!agent) {
    agent = new Agent({
      connect: (opts, callback) => {
        const port = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80);
        openTunnel(url, opts.hostname, port).then(
          (socket) => {
            if (opts.protocol !== 'https:') return callback(null, socket);
            const secure = tls.connect({ socket, servername: opts.servername || opts.hostname, ALPNProtocols: ['http/1.1'] });
            secure.once('secureConnect', () => callback(null, secure));
            secure.once('error', (err) => callback(err, null));
          },
          (err: Error) => callback(err, null),
        );
      },
    });
    agents.set(url, agent);
  }
  return agent;
}

/** 有代理时经代理请求，否则直接用全局 fetch */
export async function fetchVia(
  proxy: string | undefined,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: URLSearchParams | string; signal?: AbortSignal },
) {
  if (!proxy) return fetch(url, init);
  return undiciFetch(url, { ...init, dispatcher: proxyAgent(proxy) });
}

/** 测试代理：经代理连到目标地址，返回用时 */
export async function testProxy(url: string, target: string) {
  const m = /^([\w.-]+):(\d{1,5})$/.exec(target.trim());
  if (!m) return { ok: false as const, error: L('目标地址格式应为 主机:端口，例如 imap.gmail.com:993', 'Target must be host:port, e.g. imap.gmail.com:993') };
  const started = Date.now();
  try {
    const socket = await openTunnel(url, m[1]!, Number(m[2]));
    socket.destroy();
    return { ok: true as const, ms: Date.now() - started };
  } catch (err) {
    return { ok: false as const, error: describeProxyError(err) };
  }
}

export function describeProxyError(err: unknown) {
  const e = err as Error & { code?: string };
  // socks 库的错误没有 code，只能看信息
  const text = `${e?.code ?? ''} ${e?.message ?? ''}`;
  if (/ECONNREFUSED/.test(text)) return L('代理拒绝连接，请检查代理地址和端口', 'The proxy refused the connection; check the proxy host and port');
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return L('无法解析代理地址', 'Could not resolve the proxy host');
  if (e?.code === 'ETIMEDOUT' || /timed? ?out|超时/i.test(e?.message ?? ''))
    return L('连接超时：代理或目标地址无法访问', 'Connection timed out: the proxy or target is unreachable');
  if (/authentication|auth/i.test(e?.message ?? ''))
    return L('代理认证失败，请检查用户名和密码', 'Proxy authentication failed; check the username and password');
  return e?.message || String(err);
}
