/**
 * 检查新版本：读 GitHub 上最新的正式 Release（releases/latest 不含预发布和草稿），缓存在内存里。
 *
 * - 由服务端去查、所有用户共用结果：GitHub 匿名接口每个 IP 每小时只能调 60 次，访问者的浏览器也不用连 GitHub
 * - 成功后 6 小时内不再查，失败 30 分钟后重试；带 ETag 条件请求，没变化时返回 304，不占次数
 * - 只在有人打开网页时才查（没人用就不发请求）；UPDATE_CHECK=false 整个关掉
 * - 版本比较在前端做：前端知道自己构建时的版本标签（__APP_RELEASE__）
 */
import { config } from '../config.js';
import { L } from '../i18n/index.js';
import { fetchVia, proxyUrlById } from './proxy.js';

export type LatestRelease = { tag: string; name: string; url: string; publishedAt: string | null; body: string };
export type UpdateStatus = { enabled: boolean; repo: string; latest: LatestRelease | null; checkedAt: string | null; error: string | null };

const OK_TTL_MS = 6 * 3600_000;
const ERROR_TTL_MS = 30 * 60_000;
// 手动「检查更新」的最短间隔
const REFRESH_MIN_MS = 60_000;
const TIMEOUT_MS = 10_000;

type Fetcher = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

const defaultFetcher: Fetcher = async (url, init) => fetchVia(await proxyUrlById(config.updates.proxyId), url, init);

let fetcher = defaultFetcher;
let now = () => Date.now();
let state = { latest: null as LatestRelease | null, checkedAt: 0, error: null as string | null, etag: null as string | null };
let inflight: Promise<void> | null = null;

async function check() {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'DaMail-update-check',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (state.etag && !state.error) headers['If-None-Match'] = state.etag;
  try {
    const res = await fetcher(`https://api.github.com/repos/${config.updates.repo}/releases/latest`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 304) {
      state = { ...state, checkedAt: now(), error: null };
    } else if (res.status === 404) {
      // 还没有正式版本（或仓库不公开）
      state = { latest: null, checkedAt: now(), error: null, etag: null };
    } else if (res.status === 200) {
      const r = (await res.json()) as { tag_name?: string; name?: string | null; html_url?: string; published_at?: string | null; body?: string | null };
      if (!r.tag_name || !r.html_url) throw new Error('unexpected response');
      state = {
        latest: { tag: r.tag_name, name: r.name || r.tag_name, url: r.html_url, publishedAt: r.published_at ?? null, body: r.body ?? '' },
        checkedAt: now(),
        error: null,
        etag: res.headers.get('etag'),
      };
    } else {
      const limited = (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0';
      throw new Error(
        limited ? L('GitHub 接口调用次数已用完，稍后会自动重试', 'GitHub API rate limit reached; will retry later') : `GitHub HTTP ${res.status}`,
      );
    }
  } catch (err) {
    const e = err as Error;
    const message = e.name === 'TimeoutError' || e.name === 'AbortError' ? L('连接 GitHub 超时', 'Timed out connecting to GitHub') : e.message || String(err);
    // 查失败时保留上次的结果
    state = { ...state, checkedAt: now(), error: message };
    console.warn(`[updates] ${message}`);
  }
}

export async function updateStatus({ refresh = false } = {}): Promise<UpdateStatus> {
  const { enabled, repo } = config.updates;
  if (!enabled) return { enabled, repo, latest: null, checkedAt: null, error: null };
  const age = now() - state.checkedAt;
  const stale = !state.checkedAt || age >= (state.error ? ERROR_TTL_MS : OK_TTL_MS) || (refresh && age >= REFRESH_MIN_MS);
  if (stale) {
    inflight ??= check().finally(() => (inflight = null));
    await inflight;
  }
  return { enabled, repo, latest: state.latest, checkedAt: state.checkedAt ? new Date(state.checkedAt).toISOString() : null, error: state.error };
}

/** 测试用：替换请求和时钟，清空缓存 */
export const updatesTesting = {
  setFetcher: (f: Fetcher | null) => (fetcher = f ?? defaultFetcher),
  setNow: (f: (() => number) | null) => (now = f ?? (() => Date.now())),
  reset: () => {
    state = { latest: null, checkedAt: 0, error: null, etag: null };
    inflight = null;
  },
};
