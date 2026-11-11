import dns, { type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { L } from '../i18n/context.js';

/**
 * 访问用户或邮件提供的地址（通知 Webhook、退订链接）：
 * - 在建立连接时检查解析出的 IP，内网、本机、链路本地等地址一律拒绝，DNS 重绑定也绕不过去
 * - 每次新建连接，不跟随跳转，限制总时长和响应大小
 */

export class OutboundError extends Error {
  constructor(
    message: string,
    // blocked 指向内网；timeout 超时；unconfirmed 请求已发出但没等到响应，对方可能已经处理；network 连接失败
    readonly code: 'bad_url' | 'blocked' | 'timeout' | 'unconfirmed' | 'network',
  ) {
    super(message);
  }
}

const blockList = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  // 198.18.0.0/15 不拦：Clash、Surge 等代理的 fake-ip 模式会把所有域名解析到这一段
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blockList.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blockList.addSubnet(addr, prefix, 'ipv6');

/** 是否是不允许访问的地址（内网、本机、保留段）；IPv4 映射的 IPv6 按 IPv4 判断 */
export function isPrivateAddress(ip: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return blockList.check(mapped[1]!, 'ipv4');
  // URL 会把 ::ffff:127.0.0.1 规范成 ::ffff:7f00:1
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
    return blockList.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
  }
  const family = net.isIP(ip);
  if (!family) return true;
  return blockList.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** 解析域名后检查每个地址，有一个是内网就拒绝 */
function guardedLookup(hostname: string, options: dns.LookupOptions, cb: LookupCallback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, []);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || !list.length) return cb(new OutboundError(L(`${hostname} 指向内网或保留地址，已拒绝访问`, `${hostname} points to a private or reserved address; access denied`), 'blocked'), []);
    if (options.all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}

export type SafeRequest = {
  url: string | URL;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  // 响应体最多读这么多，多出来的丢掉
  maxBytes?: number;
  // 只允许 https
  httpsOnly?: boolean;
  // 管理员明确允许访问内网时才设为 true
  allowPrivate?: boolean;
};

export type SafeResponse = { status: number; headers: http.IncomingHttpHeaders; text: string };

export function parseOutboundUrl(input: string | URL, opts: { httpsOnly?: boolean; allowPrivate?: boolean } = {}) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OutboundError(L('地址格式不正确', 'Invalid URL'), 'bad_url');
  }
  if (url.protocol !== 'https:' && (opts.httpsOnly || url.protocol !== 'http:')) throw new OutboundError(L(`不支持的地址：${url.protocol}`, `Unsupported URL: ${url.protocol}`), 'bad_url');
  // IP 字面量不会经过 DNS 解析，要在这里单独检查
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!opts.allowPrivate && net.isIP(host) && isPrivateAddress(host)) throw new OutboundError(L(`${host} 是内网或保留地址，已拒绝访问`, `${host} is a private or reserved address; access denied`), 'blocked');
  return url;
}

export function safeRequest(req: SafeRequest): Promise<SafeResponse> {
  const url = parseOutboundUrl(req.url, req);
  const timeoutMs = req.timeoutMs ?? 15_000;
  const maxBytes = req.maxBytes ?? 64 * 1024;
  const body = req.body === undefined ? undefined : Buffer.from(req.body);
  const mod = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    let sent = false;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const request = mod.request(
      url,
      {
        method: req.method ?? (body ? 'POST' : 'GET'),
        headers: { 'user-agent': 'DaMail', ...req.headers, ...(body ? { 'content-length': String(body.length) } : {}) },
        // 每次新建连接，检查过的地址就是实际连接的地址
        agent: false,
        ...(req.allowPrivate ? {} : { lookup: guardedLookup as unknown as typeof dns.lookup }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = () => done(() => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('data', (chunk: Buffer) => {
          if (size >= maxBytes) return;
          chunks.push(chunk.subarray(0, maxBytes - size));
          size += chunk.length;
          // 读够了就断开，不再接收
          if (size >= maxBytes) {
            finish();
            res.destroy();
          }
        });
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', (err) => done(() => reject(new OutboundError(err.message, 'network'))));
      },
    );
    const timer = setTimeout(() => {
      request.destroy();
      done(() =>
        reject(
          sent
            ? new OutboundError(L(`对方 ${Math.round(timeoutMs / 1000)} 秒内没有响应，请求可能已经生效`, `No response within ${Math.round(timeoutMs / 1000)} seconds; the request may have taken effect`), 'unconfirmed')
            : new OutboundError(L(`连接超时（${Math.round(timeoutMs / 1000)} 秒）`, `Connection timed out (${Math.round(timeoutMs / 1000)} seconds)`), 'timeout'),
        ),
      );
    }, timeoutMs);
    request.on('finish', () => (sent = true));
    request.on('error', (err) => done(() => reject(err instanceof OutboundError ? err : new OutboundError(err.message, 'network'))));
    request.end(body);
  });
}
