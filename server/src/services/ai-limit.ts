/**
 * 按渠道限制同时进行的 AI 请求：
 * - 渠道设置了并发上限时，超出的请求排队等候；
 * - 渠道返回 429（限流）后，整个渠道暂停一段时间（优先按 Retry-After），暂停期间的请求等暂停结束再发，
 *   连续限流时暂停时间翻倍，成功一次后恢复。
 * 只在本进程内生效。
 */
import { L } from '../i18n/index.js';
import { DeferredError, RetryableError } from './jobs.js';

/** 被限流（HTTP 429）：retryAfterMs 是服务商要求等待的时间（如果给了） */
export class RateLimitError extends RetryableError {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** 解析 Retry-After：秒数或 HTTP 日期 */
export function parseRetryAfter(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

const MIN_PAUSE = 5_000;
const MAX_PAUSE = 120_000;

type Gate = {
  active: number;
  waiters: Array<() => void>;
  pauseUntil: number;
  backoff: number;
  // 最近一次被限流的时间、服务启动以来被限流的次数（界面上显示）
  limitedAt: number | null;
  limitedCount: number;
};
const gates = new Map<string, Gate>();

const gateOf = (key: string) => {
  let g = gates.get(key);
  if (!g) gates.set(key, (g = { active: 0, waiters: [], pauseUntil: 0, backoff: 0, limitedAt: null, limitedCount: 0 }));
  return g;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal!.reason);
    }
    signal?.addEventListener('abort', abort, { once: true });
  });

type Channel = { channelId: string | null; concurrency?: number | null };

// 渠道没设并发上限时的默认值：不能无限制，否则一个泄露的令牌就能同时发出大量计费请求
export const DEFAULT_AI_CONCURRENCY = 10;
// 每个渠道最多排队这么多请求，再多直接拒绝，避免等待中的请求占满内存
const MAX_WAITERS = 200;

// 后台任务推迟后再试（不消耗重试次数）；网页助手直接把原因显示给用户
export class AiQueueFullError extends DeferredError {}

/** 占一个请求名额，返回释放函数；渠道暂停中会一直等到暂停结束 */
export async function acquireAiSlot(c: Channel, signal?: AbortSignal): Promise<() => void> {
  const g = gateOf(c.channelId ?? '');
  const limit = c.concurrency && c.concurrency > 0 ? c.concurrency : DEFAULT_AI_CONCURRENCY;
  while (g.active >= limit) {
    if (g.waiters.length >= MAX_WAITERS) throw new AiQueueFullError(L('AI 请求排队太多，请稍后再试', 'Too many AI requests are queued; try again later'));
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        g.waiters = g.waiters.filter((w) => w !== wake);
        reject(signal!.reason);
      };
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      g.waiters.push(wake);
    });
  }
  g.active++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    g.active--;
    g.waiters.shift()?.();
  };
  try {
    while (Date.now() < g.pauseUntil) await sleep(g.pauseUntil - Date.now(), signal);
  } catch (err) {
    release();
    throw err;
  }
  return release;
}

/** 渠道被限流：暂停这个渠道 */
export function noteRateLimited(channelId: string | null, retryAfterMs?: number) {
  const g = gateOf(channelId ?? '');
  g.backoff = Math.min(MAX_PAUSE, Math.max(MIN_PAUSE, g.backoff * 2));
  const wait = Math.min(MAX_PAUSE, retryAfterMs ?? g.backoff);
  g.pauseUntil = Math.max(g.pauseUntil, Date.now() + wait);
  g.limitedAt = Date.now();
  g.limitedCount++;
}

/** 请求成功：限流的退避时间清零 */
export function noteAiSuccess(channelId: string | null) {
  const g = gates.get(channelId ?? '');
  if (g) g.backoff = 0;
}

export type AiChannelStatus = {
  // 正在进行、排队等候的请求数
  active: number;
  waiting: number;
  // 限流暂停到什么时候（已经结束时为 null）
  pausedUntil: string | null;
  limitedAt: string | null;
  limitedCount: number;
};

/** 各渠道当前的状态（只有发过请求的渠道才有），按渠道 id */
export function aiChannelStatus(): Record<string, AiChannelStatus> {
  const now = Date.now();
  return Object.fromEntries(
    [...gates].map(([id, g]) => [
      id,
      {
        active: g.active,
        waiting: g.waiters.length,
        pausedUntil: g.pauseUntil > now ? new Date(g.pauseUntil).toISOString() : null,
        limitedAt: g.limitedAt ? new Date(g.limitedAt).toISOString() : null,
        limitedCount: g.limitedCount,
      },
    ]),
  );
}

/** 测试用 */
export function aiGateState(channelId: string | null) {
  const g = gates.get(channelId ?? '');
  return g ? { active: g.active, waiting: g.waiters.length, pausedMs: Math.max(0, g.pauseUntil - Date.now()) } : null;
}
export function resetAiGates() {
  gates.clear();
}
