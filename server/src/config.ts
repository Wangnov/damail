import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { L } from './i18n/context.js';

const env = process.env;

const dataDir = path.resolve(env.DATA_DIR ?? './data');
mkdirSync(dataDir, { recursive: true });

// 主密钥：用于加密邮箱凭证、签发会话。未配置时自动生成并持久化到数据目录。
function loadMasterKey(): Buffer {
  if (env.MASTER_KEY) {
    const key = Buffer.from(env.MASTER_KEY, env.MASTER_KEY.length === 64 ? 'hex' : 'base64');
    if (key.length !== 32) throw new Error(L('MASTER_KEY 必须是 32 字节（64 位 hex 或 base64）', 'MASTER_KEY must be 32 bytes (64 hex characters or base64)'));
    return key;
  }
  const file = path.join(dataDir, 'master.key');
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  const key = randomBytes(32);
  writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  console.warn(`[config] 未设置 MASTER_KEY，已生成并保存到 ${file}，请妥善备份`);
  return key;
}

const list = (v: string | undefined) =>
  (v ?? '')
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
const stripSlash = (u: string) => u.replace(/\/+$/, '');

const publicUrl = stripSlash(env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8787}`);

export type StaticOAuthClient = { client_id: string; client_name?: string; redirect_uris: string[] };

function parseStaticClients(raw: string | undefined): StaticOAuthClient[] {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(L('MCP_OAUTH_STATIC_CLIENTS 必须是 JSON 数组', 'MCP_OAUTH_STATIC_CLIENTS must be a JSON array'));
  return parsed.map((c, i) => {
    const o = c as Partial<StaticOAuthClient>;
    if (typeof o.client_id !== 'string' || !o.client_id || !Array.isArray(o.redirect_uris) || !o.redirect_uris.length)
      throw new Error(L(`MCP_OAUTH_STATIC_CLIENTS[${i}] 需要 client_id 和 redirect_uris`, `MCP_OAUTH_STATIC_CLIENTS[${i}] needs client_id and redirect_uris`));
    return { client_id: o.client_id, client_name: o.client_name, redirect_uris: o.redirect_uris.map(String) };
  });
}

/**
 * MCP OAuth：DaMail 同时充当授权服务器（issuer）和受保护资源（/mcp）。
 * 默认关闭；开启后 API Key 和网页登录态照常可用。
 */
const mcpOAuth = {
  enabled: env.MCP_OAUTH_ENABLED === 'true',
  issuer: stripSlash(env.MCP_OAUTH_ISSUER ?? publicUrl),
  // MCP 资源的 canonical URI，也是令牌的 audience
  resource: stripSlash(env.MCP_OAUTH_RESOURCE ?? `${publicUrl}/mcp`),
  // 允许的 Client ID Metadata Document URL（精确匹配，不支持通配）
  cimdClients: list(env.MCP_OAUTH_CIMD_CLIENTS),
  // 允许的回调地址（精确匹配）：CIMD 文档里的 redirect_uris 也必须在此名单内
  redirectUris: list(env.MCP_OAUTH_REDIRECT_URIS),
  // 每个 CIMD 客户端各自允许的回调地址（网页设置里按客户端配置）；没有条目的客户端使用 redirectUris
  cimdRedirects: {} as Record<string, string[]>,
  // 预注册的公共客户端（PKCE，无密钥），JSON 数组
  staticClients: parseStaticClients(env.MCP_OAUTH_STATIC_CLIENTS),
  // 以上可在网页「开放接口 → OAuth 设置」修改：保存过之后以网页设置为准（见 oauth/settings.ts）
  source: 'env' as 'env' | 'web',
  codeTtlSec: Number(env.MCP_OAUTH_CODE_TTL_SEC ?? 300),
  accessTokenTtlSec: Number(env.MCP_OAUTH_ACCESS_TOKEN_TTL_SEC ?? 900),
  refreshTokenTtlSec: Number(env.MCP_OAUTH_REFRESH_TOKEN_TTL_SEC ?? 30 * 86400),
  grantTtlSec: Number(env.MCP_OAUTH_GRANT_TTL_SEC ?? 365 * 86400),
  // 每个 OAuth 授权每小时最多直接发送多少封（mail:send），0 表示不允许直接发送
  sendLimitPerHour: Number(env.MCP_OAUTH_SEND_LIMIT_PER_HOUR ?? 10),
  // /oauth/authorize、/oauth/token、/oauth/revoke 每个 IP 每分钟的请求上限
  rateLimitPerMin: Number(env.MCP_OAUTH_RATE_LIMIT_PER_MIN ?? 60),
  // 工具调用权限不足时：http 返回 403 + WWW-Authenticate（MCP 规范）；tool 返回带 _meta["mcp/www_authenticate"] 的工具错误（OpenAI 文档）
  scopeChallenge: (env.MCP_OAUTH_SCOPE_CHALLENGE === 'tool' ? 'tool' : 'http') as 'http' | 'tool',
  // 抓取 CIMD 文档和客户端 JWKS 时经由「代理设置」里的哪个代理（填代理 id）；不填则直连
  fetchProxyId: env.MCP_OAUTH_FETCH_PROXY_ID ? Number(env.MCP_OAUTH_FETCH_PROXY_ID) : undefined,
  // 经代理抓取的超时（毫秒）；直连时沿用 oidc-provider 的 2.5 秒
  fetchTimeoutMs: Number(env.MCP_OAUTH_FETCH_TIMEOUT_MS ?? 8000),
};

function isLocalUrl(u: string) {
  const host = new URL(u).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

/** issuer / resource 的基本要求（启用时检查；网页上开启时也会调用） */
export function assertMcpOAuthBase(o: { issuer: string; resource: string }) {
  for (const [name, value] of [
    ['MCP_OAUTH_ISSUER', o.issuer],
    ['MCP_OAUTH_RESOURCE', o.resource],
  ] as const) {
    const u = new URL(value);
    if (u.search || u.hash) throw new Error(L(`${name} 不能包含查询参数或 #`, `${name} must not contain query parameters or #`));
    if (u.protocol !== 'https:' && !isLocalUrl(value))
      throw new Error(L(`${name} 在非本机环境必须使用 HTTPS（检查 PUBLIC_URL）`, `${name} must use HTTPS outside localhost (check PUBLIC_URL)`));
  }
  if (new URL(o.issuer).pathname !== '/')
    throw new Error(
      L(
        'MCP_OAUTH_ISSUER 目前只支持不带路径的地址（与 PUBLIC_URL 同源）',
        'MCP_OAUTH_ISSUER currently only supports a URL without a path (same origin as PUBLIC_URL)',
      ),
    );
  if (new URL(o.resource).origin !== new URL(o.issuer).origin)
    throw new Error(
      L(
        'MCP_OAUTH_RESOURCE 必须与 MCP_OAUTH_ISSUER 同源（DaMail 自带授权服务器）',
        'MCP_OAUTH_RESOURCE must be on the same origin as MCP_OAUTH_ISSUER (DaMail runs its own authorization server)',
      ),
    );
}

/** 客户端 client_id URL、回调地址：必须是不带 # 的 HTTPS 地址（本机除外），不支持通配符 */
export function assertClientUrl(u: string, what = L('OAuth 客户端地址', 'OAuth client URL')) {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new Error(L(`${what}格式不正确：${u}`, `Invalid ${what}: ${u}`));
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalUrl(u)))
    throw new Error(L(`${what}必须是 HTTPS：${u}`, `${what} must use HTTPS: ${u}`));
  if (url.hash || u.includes('*')) throw new Error(L(`${what}不能包含 # 或通配符：${u}`, `${what} must not contain # or wildcards: ${u}`));
}

if (mcpOAuth.enabled) {
  assertMcpOAuthBase(mcpOAuth);
  for (const u of mcpOAuth.cimdClients) assertClientUrl(u);
  for (const u of mcpOAuth.redirectUris) assertClientUrl(u, L('回调地址', 'Redirect URI'));
  if (mcpOAuth.fetchProxyId !== undefined && !(Number.isInteger(mcpOAuth.fetchProxyId) && mcpOAuth.fetchProxyId > 0))
    throw new Error(L('MCP_OAUTH_FETCH_PROXY_ID 必须是代理的数字 id', 'MCP_OAUTH_FETCH_PROXY_ID must be the numeric id of a proxy'));
  if (!(mcpOAuth.fetchTimeoutMs >= 1000 && mcpOAuth.fetchTimeoutMs <= 30_000))
    throw new Error(L('MCP_OAUTH_FETCH_TIMEOUT_MS 应在 1000 到 30000 之间', 'MCP_OAUTH_FETCH_TIMEOUT_MS must be between 1000 and 30000'));
}

/** 检查新版本：定期读 GitHub 上最新的 Release，在网页上提示「有新版本」 */
const updates = {
  enabled: env.UPDATE_CHECK !== 'false',
  // owner/repo
  repo: env.UPDATE_REPO ?? 'gopkg-dev/damail',
  // 服务器直连不了 api.github.com 时经「代理设置」里的哪个代理（填代理 id）
  proxyId: env.UPDATE_CHECK_PROXY_ID ? Number(env.UPDATE_CHECK_PROXY_ID) : undefined,
};
if (!/^[\w.-]+\/[\w.-]+$/.test(updates.repo)) throw new Error(L('UPDATE_REPO 应写成 owner/repo', 'UPDATE_REPO must look like owner/repo'));

export const config = {
  mcpOAuth,
  updates,
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: env.DATABASE_URL ?? 'postgres://damail:damail@127.0.0.1:55434/damail',
  dataDir,
  rawDir: path.join(dataDir, 'raw'),
  uploadDir: path.join(dataDir, 'uploads'),
  masterKey: loadMasterKey(),
  cookieSecure: env.COOKIE_SECURE === 'true',
  publicUrl,
  syncEnabled: env.SYNC_ENABLED !== 'false',
  // 默认轮询间隔（每个邮箱可以单独设置）：非 INBOX 文件夹按此轮询；INBOX 走 IDLE，同时按此间隔兜底
  pollIntervalMs: Number(env.POLL_INTERVAL_SEC ?? 300) * 1000,
  // 后台同步超过此大小的邮件只抓取预览；读取详情或下载时按需补齐原件
  maxMessageBytes: Number(env.MAX_MESSAGE_MB ?? 30) * 1024 * 1024,
  // 点击发送后延迟 N 秒才真正发出，期间可以撤销
  sendDelaySec: Number(env.SEND_DELAY_SEC ?? 10),
  // 通知渠道默认不能推送到内网地址（防止借 Webhook 探测内网），自建的内网服务需要显式打开
  allowPrivateWebhooks: env.ALLOW_PRIVATE_WEBHOOKS === 'true',
  maxAttachmentBytes: Number(env.MAX_ATTACHMENT_MB ?? 25) * 1024 * 1024,
  webDist: env.WEB_DIST ? path.resolve(env.WEB_DIST) : undefined,
  // 开发时没有 webDist，页面请求转给 Vite
  devWebUrl: (env.DEV_WEB_URL ?? 'http://localhost:5180').replace(/\/+$/, ''),
};

/** 邮箱的轮询间隔：邮箱单独设置过就用它，否则用默认值 */
export const pollIntervalMsOf = (account: { pollIntervalSec: number | null }) =>
  account.pollIntervalSec ? account.pollIntervalSec * 1000 : config.pollIntervalMs;
