import { eq } from 'drizzle-orm';
import { fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import { assertClientUrl, assertMcpOAuthBase, config } from '../config.js';
import { db } from '../db/index.js';
import { proxies, settings } from '../db/schema.js';
import { parseOutboundUrl, safeRequest } from '../lib/safe-fetch.js';
import { proxyAgent, proxyUrlById } from '../services/proxy.js';
import { setOAuthProvider } from './provider.js';
import { L } from '../i18n/index.js';

/**
 * MCP OAuth 的网页设置（存在 settings 表 key = mcp_oauth）。
 *
 * 常改的几项放到网页上：开关、允许的客户端（每个客户端各自的回调地址）、抓取用的代理、直接发信上限、权限不足的提示方式。
 * issuer / resource / 有效期 / 限流仍由环境变量决定。网页上从没保存过时，沿用环境变量（与旧部署兼容）。
 * 保存后立即覆盖到 config.mcpOAuth，并重建 oidc-provider（客户端名单和 CIMD 缓存随之更新），不需要重启。
 */

const SETTINGS_KEY = 'mcp_oauth';
const STATIC_ID = /^[\w.-]{3,100}$/;

const clientSchema = z.object({
  type: z.enum(['cimd', 'static']),
  clientId: z.string().trim().min(1).max(500),
  name: z.string().trim().max(100).nullish(),
  redirectUris: z.array(z.string().trim().min(1).max(500)).min(1, { error: () => L('每个客户端至少要有一个回调地址', 'Each client needs at least one redirect URI') }).max(10),
});

const settingsSchema = z.object({
  enabled: z.boolean(),
  clients: z.array(clientSchema).max(20),
  fetchProxyId: z.number().int().positive().nullable(),
  sendLimitPerHour: z.number().int().min(0).max(1000),
  scopeChallenge: z.enum(['http', 'tool']),
});

export type McpOAuthClient = z.infer<typeof clientSchema>;
export type McpOAuthSettings = z.infer<typeof settingsSchema>;

/** 校验并规范化；不合法时抛出给用户看的错误 */
async function normalize(input: unknown): Promise<McpOAuthSettings> {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? L('设置格式不正确', 'Invalid settings'));
  const s = parsed.data;
  const seen = new Set<string>();
  const clients = s.clients.map((c) => {
    if (c.type === 'cimd') assertClientUrl(c.clientId, 'Client ID');
    else if (!STATIC_ID.test(c.clientId)) throw new Error(L(`预注册客户端的 Client ID 只能包含字母、数字、. _ -（3 到 100 个字符）：${c.clientId}`, `Pre-registered client IDs may only contain letters, digits, . _ - (3 to 100 characters): ${c.clientId}`));
    if (seen.has(c.clientId)) throw new Error(L(`客户端重复：${c.clientId}`, `Duplicate client: ${c.clientId}`));
    seen.add(c.clientId);
    const redirectUris = [...new Set(c.redirectUris)];
    for (const u of redirectUris) assertClientUrl(u, L('回调地址', 'Redirect URI'));
    return { type: c.type, clientId: c.clientId, name: c.name || null, redirectUris };
  });
  if (s.fetchProxyId !== null) {
    const row = await db.query.proxies.findFirst({ where: eq(proxies.id, s.fetchProxyId), columns: { id: true } });
    if (!row) throw new Error(L('所选代理不存在', 'The selected proxy does not exist'));
  }
  if (s.enabled) assertMcpOAuthBase(config.mcpOAuth);
  return { ...s, clients };
}

// 网页上保存过的设置（含 CIMD 客户端读取到的名称，仅用于网页展示）
let stored: McpOAuthSettings | null = null;

/** 把设置覆盖到运行中的 config.mcpOAuth，并让 oidc-provider 在下一个请求时按新配置重建 */
function apply(s: McpOAuthSettings) {
  const o = config.mcpOAuth;
  const cimd = s.clients.filter((c) => c.type === 'cimd');
  o.enabled = s.enabled;
  o.cimdClients = cimd.map((c) => c.clientId);
  o.cimdRedirects = Object.fromEntries(cimd.map((c) => [c.clientId, c.redirectUris]));
  o.redirectUris = [...new Set(cimd.flatMap((c) => c.redirectUris))];
  o.staticClients = s.clients
    .filter((c) => c.type === 'static')
    .map((c) => ({ client_id: c.clientId, client_name: c.name ?? undefined, redirect_uris: c.redirectUris }));
  o.fetchProxyId = s.fetchProxyId ?? undefined;
  o.sendLimitPerHour = s.sendLimitPerHour;
  o.scopeChallenge = s.scopeChallenge;
  o.source = 'web';
  stored = s;
  setOAuthProvider(undefined);
}

/** 启动时调用：网页上保存过设置就用它覆盖环境变量 */
export async function loadMcpOAuthSettings() {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, SETTINGS_KEY) });
  if (!row) return;
  try {
    apply(await normalize(row.value));
  } catch (err) {
    // 存的设置已不合法（如代理被删、PUBLIC_URL 改成了 http）：关闭 OAuth，等管理员在网页上修正
    console.error('[oauth] 网页设置无效，已停用 MCP OAuth：', (err as Error).message);
    config.mcpOAuth.enabled = false;
    config.mcpOAuth.source = 'web';
    setOAuthProvider(undefined);
  }
}

/** 当前生效的可编辑设置（来自网页或环境变量） */
export function currentSettings(): McpOAuthSettings & { source: 'env' | 'web' } {
  const o = config.mcpOAuth;
  if (stored && o.source === 'web') return { ...stored, enabled: o.enabled, source: 'web' };
  return {
    source: o.source,
    enabled: o.enabled,
    clients: [
      ...o.cimdClients.map((id) => ({ type: 'cimd' as const, clientId: id, name: null, redirectUris: o.cimdRedirects[id] ?? o.redirectUris })),
      ...o.staticClients.map((c) => ({ type: 'static' as const, clientId: c.client_id, name: c.client_name ?? null, redirectUris: c.redirect_uris })),
    ],
    fetchProxyId: o.fetchProxyId ?? null,
    sendLimitPerHour: o.sendLimitPerHour,
    scopeChallenge: o.scopeChallenge,
  };
}

export async function saveMcpOAuthSettings(input: unknown) {
  const s = await normalize(input);
  await db
    .insert(settings)
    .values({ key: SETTINGS_KEY, value: s })
    .onConflictDoUpdate({ target: settings.key, set: { value: s, updatedAt: new Date() } });
  apply(s);
  return currentSettings();
}

export type InspectResult = {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  authMethod: string | null;
  jwksUri: string | null;
  problems: string[];
};

/**
 * 读取一个 CIMD client_id URL 指向的元数据文档，给网页上「添加客户端」用：列出名称和回调地址，标出不能使用的原因。
 * 只允许 HTTPS、不跟随跳转、最多 5 KB；直连时拒绝内网地址，选了代理时经代理请求。
 */
export async function inspectClient(clientId: string, proxyId: number | null): Promise<InspectResult> {
  assertClientUrl(clientId, 'Client ID');
  const url = parseOutboundUrl(clientId, { httpsOnly: !clientId.startsWith('http://') });
  const timeoutMs = config.mcpOAuth.fetchTimeoutMs;
  let status: number;
  let text: string;
  if (proxyId) {
    const proxy = await proxyUrlById(proxyId);
    if (!proxy) throw new Error(L('所选代理不存在', 'The selected proxy does not exist'));
    const res = await undiciFetch(url.href, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: proxyAgent(proxy),
    }).catch((err: Error) => {
      throw new Error(L(`经代理读取失败：${(err.cause as Error | undefined)?.message ?? err.message}`, `Fetch through proxy failed: ${(err.cause as Error | undefined)?.message ?? err.message}`));
    });
    status = res.status;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024) throw new Error(L('文档超过 5 KB', 'The document exceeds 5 KB'));
    text = buf.toString('utf8');
  } else {
    const res = await safeRequest({ url, headers: { accept: 'application/json' }, timeoutMs, maxBytes: 5 * 1024 + 1, httpsOnly: url.protocol === 'https:' });
    status = res.status;
    if (Buffer.byteLength(res.text) > 5 * 1024) throw new Error(L('文档超过 5 KB', 'The document exceeds 5 KB'));
    text = res.text;
  }
  if (status !== 200) throw new Error(L(`读取失败：HTTP ${status}`, `Fetch failed: HTTP ${status}`));
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(L('返回的不是 JSON', 'The response is not JSON'));
  }
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const authMethod = typeof doc.token_endpoint_auth_method === 'string' ? doc.token_endpoint_auth_method : null;
  const problems: string[] = [];
  if (doc.client_id !== clientId) problems.push(L('文档里的 client_id 与地址不一致', 'The client_id in the document does not match its URL'));
  if (authMethod && !['none', 'private_key_jwt'].includes(authMethod)) problems.push(L(`不支持的客户端认证方式：${authMethod}`, `Unsupported client authentication method: ${authMethod}`));
  if ('client_secret' in doc) problems.push(L('文档里包含 client_secret', 'The document contains client_secret'));
  const redirectUris = strings(doc.redirect_uris);
  if (!redirectUris.length) problems.push(L('文档里没有 redirect_uris', 'The document has no redirect_uris'));
  const jwksUri = typeof doc.jwks_uri === 'string' ? doc.jwks_uri : null;
  if (jwksUri && new URL(jwksUri).origin !== url.origin) problems.push(L('jwks_uri 与 client_id 不同源，经代理时无法抓取', 'jwks_uri is not on the same origin as client_id, so it cannot be fetched through the proxy'));
  return {
    clientId,
    clientName: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 100) : null,
    redirectUris,
    authMethod,
    jwksUri,
    problems,
  };
}
