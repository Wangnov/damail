import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

// 发件人图标：按发件域名从 Twenty 图标服务取品牌图标，缓存在数据目录；浏览器只访问我们自己的接口
const SERVICE = 'https://twenty-icons.com';
const SIZE = 128;
const MAX_BYTES = 256 * 1024;
const CACHE_TTL = 30 * 24 * 3600_000;
// 查不到的域名一天内不再请求
const MISSING_TTL = 24 * 3600_000;
const CACHE_DIR = path.join(config.dataDir, 'sender-icons');

// 只接受位图；SVG 能带脚本，直接打开接口地址时会在我们的域名下执行
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon']);

// 个人邮箱的域名：用这些地址发信的是个人，显示服务商的图标会误导，用名字首字母
const PERSONAL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'qq.com',
  'vip.qq.com',
  'foxmail.com',
  '163.com',
  '126.com',
  'yeah.net',
  'vip.163.com',
  'vip.126.com',
  '188.com',
  'sina.com',
  'sina.cn',
  'sohu.com',
  '139.com',
  '189.cn',
  'aliyun.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'yahoo.com',
  'ymail.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.de',
  'mail.ru',
  'yandex.ru',
  'zoho.com',
]);

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** 能查图标的域名：合法主机名、不是个人邮箱 */
export function iconDomain(raw: string) {
  const d = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!HOSTNAME.test(d) || PERSONAL_DOMAINS.has(d)) return null;
  return d;
}

/** 先查品牌主域名再查完整域名：mail.github.com → github.com；co.uk 这类二级后缀多保留一段 */
function candidates(domain: string) {
  const labels = domain.split('.');
  if (labels.length <= 2) return [domain];
  const secondLevel = ['ac', 'co', 'com', 'edu', 'gov', 'net', 'org'].includes(labels.at(-2)!) && labels.at(-1)!.length === 2;
  const brand = labels.slice(secondLevel ? -3 : -2).join('.');
  return brand === domain ? [domain] : [brand, domain];
}

const fileOf = (domain: string, ext: string) => path.join(CACHE_DIR, `${createHash('sha256').update(domain).digest('hex').slice(0, 32)}.${ext}`);

async function fresh(file: string, ttl: number) {
  try {
    return Date.now() - (await stat(file)).mtimeMs < ttl;
  } catch {
    return false;
  }
}

async function fetchIcon(domain: string): Promise<{ type: string; body: Buffer } | null> {
  let url = `${SERVICE}/${domain}/${SIZE}`;
  // 只跟随到图标服务自己域名下的跳转
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'DaMail sender icon' } });
    if (res.status >= 300 && res.status < 400) {
      const next = new URL(res.headers.get('location') ?? '', url);
      if (next.protocol !== 'https:' || !(next.hostname === 'twenty-icons.com' || next.hostname.endsWith('.twenty-icons.com'))) return null;
      url = next.href;
      continue;
    }
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new Error(`图标服务返回 ${res.status}`);
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!TYPES.has(type)) return null;
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return null;
    const body = Buffer.from(await res.arrayBuffer());
    return body.length && body.length <= MAX_BYTES ? { type, body } : null;
  }
  return null;
}

const inflight = new Map<string, Promise<{ type: string; body: Buffer } | null>>();

async function load(domain: string) {
  const img = fileOf(domain, 'img');
  const meta = fileOf(domain, 'type');
  const miss = fileOf(domain, 'miss');
  if (await fresh(img, CACHE_TTL)) {
    try {
      const [body, type] = await Promise.all([readFile(img), readFile(meta, 'utf8')]);
      if (TYPES.has(type)) return { type, body };
    } catch {
      // 缓存坏了就重新取
    }
  }
  if (await fresh(miss, MISSING_TTL)) return null;

  await mkdir(CACHE_DIR, { recursive: true });
  let failed: unknown = null;
  for (const d of candidates(domain)) {
    try {
      const icon = await fetchIcon(d);
      if (!icon) continue;
      // 按原始发件域名缓存，下次同域名的邮件直接命中
      await Promise.all([writeFile(img, icon.body), writeFile(meta, icon.type), rm(miss, { force: true })]);
      return icon;
    } catch (err) {
      failed ??= err;
    }
  }
  // 网络出错不记为「没有图标」，下次还会再试
  if (failed) throw failed;
  await writeFile(miss, '');
  return null;
}

/** 返回发件域名的图标；没有图标返回 null，取图失败抛错 */
export function senderIcon(domain: string) {
  let p = inflight.get(domain);
  if (!p) {
    p = load(domain).finally(() => inflight.delete(domain));
    inflight.set(domain, p);
  }
  return p;
}
