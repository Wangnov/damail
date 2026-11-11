import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, type Account } from '../db/schema.js';
import { accountCredentials } from '../services/oauth.js';
import { fetchVia, proxyUrlById } from '../services/proxy.js';
import { L } from '../i18n/index.js';

const BASE = 'https://graph.microsoft.com/v1.0';
// 邮件移动文件夹后 ID 不变，本地记录可以原地改写
const IMMUTABLE = 'IdType="ImmutableId"';
const MAX_RETRIES = 3;
const BATCH_SIZE = 20;

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

type GraphRequest = { method?: string; json?: unknown; body?: string; contentType?: string; prefer?: string[]; timeoutMs?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadAccount(account: Account | number) {
  if (typeof account !== 'number') return account;
  const row = await db.query.accounts.findFirst({ where: eq(accounts.id, account) });
  if (!row) throw new Error(L('账户不存在', 'Account not found'));
  return row;
}

/** 调 Graph 接口；限流（429/503/504）按 Retry-After 等待后重试，其他错误抛 GraphError */
export async function graphFetch(acc: Account | number, pathOrUrl: string, req: GraphRequest = {}) {
  const account = await loadAccount(acc);
  const proxy = await proxyUrlById(account.proxyId);
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${BASE}${pathOrUrl}`;
  for (let attempt = 0; ; attempt++) {
    const { accessToken } = await accountCredentials(account);
    if (!accessToken) throw new GraphError(L('该账户不是 OAuth 授权，不能使用 Graph API', 'This account is not OAuth-authorized and cannot use the Graph API'), 400);
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}`, prefer: [IMMUTABLE, ...(req.prefer ?? [])].join(', ') };
    let body = req.body;
    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      headers['content-type'] = 'application/json';
    } else if (req.contentType) headers['content-type'] = req.contentType;
    const res = await fetchVia(proxy, url, { method: req.method ?? 'GET', headers, body, signal: AbortSignal.timeout(req.timeoutMs ?? 60_000) });
    if ([429, 503, 504].includes(res.status) && attempt < MAX_RETRIES) {
      await res.arrayBuffer().catch(() => {});
      await sleep(Math.min(Number(res.headers.get('retry-after')) || 2 ** attempt * 5, 60) * 1000);
      continue;
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      throw new GraphError(data.error?.message || L(`Graph 请求失败（${res.status}）`, `Graph request failed (${res.status})`), res.status, data.error?.code);
    }
    return res;
  }
}

export async function graphJson<T>(account: Account | number, pathOrUrl: string, req?: GraphRequest): Promise<T> {
  const res = await graphFetch(account, pathOrUrl, req);
  if (res.status === 202 || res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type BatchItem = { method: string; url: string; body?: unknown };
export type BatchResult = { ok: boolean; status: number; body: unknown; error?: string };

/** JSON 批量请求，每次最多 20 个；单个请求被限流时等待后重试，结果和请求一一对应 */
export async function graphBatch(account: Account | number, items: BatchItem[]): Promise<BatchResult[]> {
  const acc = await loadAccount(account);
  const results: BatchResult[] = new Array(items.length);
  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    let todo = items.slice(start, start + BATCH_SIZE).map((item, i) => ({ item, index: start + i }));
    for (let attempt = 0; todo.length; attempt++) {
      const data = await graphJson<{ responses: Array<{ id: string; status: number; headers?: Record<string, string>; body?: unknown }> }>(acc, '/$batch', {
        method: 'POST',
        json: {
          requests: todo.map(({ item, index }) => ({
            id: String(index),
            method: item.method,
            url: item.url,
            headers: { prefer: IMMUTABLE, ...(item.body !== undefined ? { 'content-type': 'application/json' } : {}) },
            ...(item.body !== undefined ? { body: item.body } : {}),
          })),
        },
      });
      let wait = 0;
      const retry: typeof todo = [];
      for (const r of data.responses) {
        const entry = todo.find((t) => String(t.index) === r.id)!;
        if (r.status === 429 && attempt < MAX_RETRIES) {
          wait = Math.max(wait, Number(r.headers?.['Retry-After'] ?? r.headers?.['retry-after']) || 5);
          retry.push(entry);
          continue;
        }
        const error = (r.body as { error?: { message?: string } } | undefined)?.error?.message;
        results[entry.index] = { ok: r.status < 300, status: r.status, body: r.body, error: r.status < 300 ? undefined : error || L(`请求失败（${r.status}）`, `Request failed (${r.status})`) };
      }
      todo = retry;
      if (todo.length) await sleep(Math.min(wait, 60) * 1000);
    }
  }
  return results;
}

export function describeGraphError(err: unknown): string {
  if (err instanceof GraphError) {
    if (err.code === 'MailboxNotEnabledForRESTAPI') return L('这个账号的邮箱不支持 Graph API', "This account's mailbox does not support the Graph API");
    if (err.status === 401) return L('微软授权已失效：请在邮箱管理里重新授权', 'Microsoft authorization has expired: re-authorize it under Mailboxes');
    if (err.status === 403) return L('没有访问邮箱的权限：请重新授权并同意读写邮件、发送邮件的权限', 'No permission to access the mailbox: authorize again and accept the read/write and send mail permissions');
    return L(`微软 Graph 接口出错：${err.message}`, `Microsoft Graph error: ${err.message}`);
  }
  const e = err as Error & { code?: string; cause?: { code?: string } };
  const code = e?.code ?? e?.cause?.code;
  if (e?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT')
    return L('连接微软服务器超时：网络无法访问，可以在邮箱设置里选择代理', 'Timed out connecting to Microsoft: the network is unreachable. You can choose a proxy in the mailbox settings');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return L('无法解析微软服务器地址，请检查网络', 'Could not resolve the Microsoft server address; check the network');
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return L('连接微软服务器失败，请检查网络或代理', 'Could not connect to Microsoft; check the network or proxy');
  return e?.message || String(err);
}
