import { AsyncLocalStorage } from 'node:async_hooks';
import { lt } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import type { AppEnv, AuthContext } from '../auth/index.js';
import { db } from '../db/index.js';
import { auditLogs } from '../db/schema.js';

export type AuditSource = 'web' | 'api' | 'mcp' | 'oauth' | 'system';
type Info = { accountId?: number; target?: string; detail?: Record<string, unknown> };
type Entry = { actor: string; action: string } & Info;

/**
 * 一个请求的审计上下文：请求内调用的 audit() 先暂存，请求结束时补上状态码、耗时、IP 后统一写入；
 * 请求内没有任何业务记录时，由中间件按规则补一条通用记录（见 auditRequests）。
 */
type RequestAudit = {
  source: AuditSource;
  ip: string;
  userAgent?: string;
  entries: Entry[];
  // 请求已结束：之后才调用 audit() 的（请求里启动的定时器、后台任务会继承上下文）直接写入
  done?: boolean;
  // 网页上的高频小操作（标记已读、星标）不记录通用请求
  skip?: boolean;
  // MCP 工具调用：工具名、参数和结果
  tool?: { name: string; args: unknown; error?: string; status?: number };
  // MCP 请求里的 tools/call（工具没注册、参数校验失败时工具层不会执行，由中间件补记）
  rpcCall?: { name: string; args: unknown };
};

const store = new AsyncLocalStorage<RequestAudit>();

/** 记录写操作（发信、审批、移动等），失败不影响主流程 */
export function audit(actor: string, action: string, info: Info = {}) {
  const ctx = store.getStore();
  if (ctx && !ctx.done) {
    ctx.entries.push({ actor, action, ...info });
    return;
  }
  write([{ actor, action, ...info, source: ctx ? ctx.source : 'system', ip: ctx?.ip, userAgent: ctx?.userAgent }]);
}

/** 当前请求不记录通用请求日志（已有业务记录的不受影响） */
export function skipRequestAudit() {
  const ctx = store.getStore();
  if (ctx) ctx.skip = true;
}

/** MCP 工具包装层调用：记下本次调用的工具、参数和结果 */
export function auditToolCall(name: string, args: unknown, result?: { error?: string; status?: number }) {
  const ctx = store.getStore();
  if (ctx) ctx.tool = { name, args, ...result };
}

type Row = typeof auditLogs.$inferInsert;

function write(rows: Row[]) {
  if (!rows.length) return;
  void db
    .insert(auditLogs)
    .values(rows)
    .catch((err) => console.warn('[audit] 写入失败', err));
}

// ---- 脱敏 ----

// 密码、密钥、令牌一律不记；邮件正文、对话内容只记长度
const SECRET = /pass|secret|token|apikey|api_key|authorization|credential|cookie|private|^key$|^code$|verifier/i;
const CONTENT = /^(html|text|body|content|htmlbody|textbody|messages|prompt|system)$/i;

export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…（共 ${value.length} 字）` : value;
  if (depth >= 4) return '…';
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((v) => sanitize(v, depth + 1));
    return value.length > 20 ? [...items, `…（共 ${value.length} 项）`] : items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      if (SECRET.test(k)) out[k] = v === undefined || v === null || v === '' ? v : '[已隐藏]';
      else if (CONTENT.test(k) && v !== null && v !== undefined)
        out[k] = typeof v === 'string' ? `[${v.length} 字]` : Array.isArray(v) ? `[${v.length} 项]` : '[已省略]';
      else out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

// ---- 请求中间件 ----

/** 预读 MCP 请求里的 tools/call（读的是副本，不影响 SDK 读取请求体） */
async function toolCallOf(req: Request) {
  if (!(req.headers.get('content-type') ?? '').includes('json')) return undefined;
  try {
    const msg = (await req.clone().json()) as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
    if (msg?.method !== 'tools/call' || typeof msg.params?.name !== 'string') return undefined;
    return { name: msg.params.name.slice(0, 100), args: msg.params.arguments };
  } catch {
    return undefined;
  }
}

/** MCP 响应里的错误文字：JSON-RPC error 或工具返回的 isError 内容 */
async function rpcErrorOf(res: Response) {
  try {
    const body = (await res.clone().json()) as { error?: { message?: string }; result?: { isError?: boolean; content?: { text?: string }[] } };
    const text = body.error?.message ?? (body.result?.isError ? body.result.content?.[0]?.text : undefined);
    return text?.slice(0, 300);
  } catch {
    return undefined;
  }
}

/**
 * 客户端 IP：优先反向代理写入的 X-Real-IP，其次 X-Forwarded-For 的最后一跳
 * （前面的条目由客户端自己填写，可以伪造），最后是直连地址
 */
export function requestIp(c: Context) {
  const real = c.req.header('x-real-ip')?.trim();
  if (real) return real;
  const last = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
  return last || (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress || 'local';
}

function actorFor(auth: AuthContext | undefined) {
  if (!auth) return 'anonymous';
  if (auth.actor) return auth.actor;
  if (auth.kind === 'apiKey') return `key:${auth.apiKeyId}`;
  if (auth.kind === 'oauth') return `oauth:${auth.oauth?.authorizationId}`;
  return `user:${auth.userId}`;
}

async function readJson(c: Context) {
  if (!(c.req.header('content-type') ?? '').includes('application/json')) return undefined;
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

async function errorOf(res: Response) {
  if (res.status < 400 || !(res.headers.get('content-type') ?? '').includes('json')) return undefined;
  try {
    const body = (await res.clone().json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 审计中间件，挂在 /api/*、/mcp、/oauth/* 上：
 * - 开放接口（API Key、OAuth 令牌）：每个请求都记录，包括只读请求；MCP 按工具调用记录
 * - 网页后台（登录会话）：只记录写操作
 * - 带了 Authorization 头但认证失败（401）的请求也记录，便于发现泄露或失效的密钥
 * 请求里已有业务记录（rule.create、messages.archive 等）时不再补通用记录，只给业务记录补上下文
 */
export function auditRequests(source: AuditSource): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = Date.now();
    const ctx: RequestAudit = { source, ip: requestIp(c), userAgent: c.req.header('user-agent')?.slice(0, 300), entries: [] };
    if (source === 'mcp' && c.req.method === 'POST') ctx.rpcCall = await toolCallOf(c.req.raw);
    try {
      await store.run(ctx, next);
    } finally {
      ctx.done = true;
    }

    const status = c.res.status;
    const auth = c.get('auth') as AuthContext | undefined;
    const open = auth?.kind === 'apiKey' || auth?.kind === 'oauth';
    // /api/* 下没有带 Authorization 头的请求来自网页（登录会话、登录页）
    const finalSource: AuditSource = source === 'api' && !open && c.req.header('authorization') === undefined ? 'web' : source;
    ctx.source = finalSource;
    const base = { source: finalSource, ip: ctx.ip, userAgent: ctx.userAgent, durationMs: Date.now() - started };
    const actor = actorFor(auth);
    const tool = ctx.tool;

    // 业务记录：补上状态码和上下文；MCP 工具里产生的记录带上工具名
    if (ctx.entries.length) {
      write(
        ctx.entries.map((e) => ({
          ...e,
          ...base,
          status: tool?.status ?? status,
          detail: tool ? { ...e.detail, tool: tool.name } : e.detail,
        })),
      );
      return;
    }

    if (tool) {
      write([
        {
          actor,
          action: 'mcp.call',
          target: tool.name,
          ...base,
          status: tool.status ?? status,
          detail: { args: sanitize(tool.args), ...(tool.error ? { error: tool.error.slice(0, 300) } : {}) },
        },
      ]);
      return;
    }

    const method = c.req.method;
    const authFailed = status === 401 && c.req.header('authorization') !== undefined;
    if (authFailed) {
      write([{ actor: 'anonymous', action: 'auth.token_invalid', target: c.req.path, ...base, status, detail: { method } }]);
      return;
    }
    if (source === 'mcp' && ctx.rpcCall && status < 400) {
      write([
        {
          actor,
          action: 'mcp.call',
          target: ctx.rpcCall.name,
          ...base,
          status: 400,
          detail: { args: sanitize(ctx.rpcCall.args), error: (await rpcErrorOf(c.res)) ?? '工具没有执行' },
        },
      ]);
      return;
    }
    if (source === 'mcp') {
      // MCP 的 initialize、tools/list 等协议消息不记录；HTTP 层因权限不足拒绝的工具调用要记
      if (status === 403 && open) write([{ actor, action: 'mcp.denied', ...base, status, detail: { error: await errorOf(c.res) } }]);
      return;
    }
    if (source === 'oauth' || ctx.skip || !auth) return;
    if (!open && (method === 'GET' || method === 'HEAD' || method === 'OPTIONS')) return;

    const body = method === 'GET' || method === 'HEAD' ? undefined : await readJson(c);
    const query = c.req.queries();
    const error = await errorOf(c.res);
    const detail: Record<string, unknown> = {};
    if (Object.keys(query).length) detail.query = sanitize(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, v.length > 1 ? v : v[0]])));
    if (body !== undefined) detail.body = sanitize(body);
    else if ((c.req.header('content-type') ?? '').includes('multipart/form-data')) detail.body = '[文件上传]';
    if (error) detail.error = error;
    write([
      {
        actor,
        action: `${method} ${routePath(c) || c.req.path}`,
        target: c.req.path,
        ...base,
        status,
        detail: Object.keys(detail).length ? detail : undefined,
      },
    ]);
  };
}

// ---- 保留期限 ----

export const AUDIT_SETTINGS_KEY = 'audit';
export const DEFAULT_RETENTION_DAYS = 180;

export async function auditRetentionDays() {
  const row = await db.query.settings.findFirst({ where: (s, { eq }) => eq(s.key, AUDIT_SETTINGS_KEY) });
  const days = (row?.value as { retentionDays?: unknown } | undefined)?.retentionDays;
  return typeof days === 'number' && days >= 0 ? days : DEFAULT_RETENTION_DAYS;
}

/** 删除超过保留天数的审计日志；0 表示永久保留 */
export async function purgeAuditLogs() {
  const days = await auditRetentionDays();
  if (!days) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const removed = await db.delete(auditLogs).where(lt(auditLogs.createdAt, cutoff)).returning({ id: auditLogs.id });
  return removed.length;
}
