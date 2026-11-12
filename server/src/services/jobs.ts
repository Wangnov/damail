import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { jobs } from '../db/schema.js';
import { L } from '../i18n/index.js';

type Handler = (payload: Record<string, unknown>, ctx: { attempt: number; lastAttempt: boolean }) => Promise<Record<string, unknown> | void>;

const handlers = new Map<string, { run: Handler; maxAttempts: number }>();
const TICK_MS = 1000;
const CONCURRENCY = 4;
const KEEP_DAYS = 14;

export function registerJob(type: string, run: Handler, maxAttempts = 3) {
  handlers.set(type, { run, maxAttempts });
}

export async function enqueue(type: string, payload: Record<string, unknown>, delayMs = 0) {
  await db.insert(jobs).values({ type, payload, runAt: new Date(Date.now() + delayMs) });
  wake();
}

/** 可重试的错误（网络、限流），其余错误直接失败 */
export class RetryableError extends Error {}

/** 暂时没有处理能力（例如 AI 排队已满）：稍后重新排队，不消耗重试次数 */
export class DeferredError extends RetryableError {
  readonly delayMs: number = 30_000;
}

let timer: NodeJS.Timeout | null = null;
let running = 0;
let woken = false;

function wake() {
  woken = true;
  if (timer) void tick();
}

async function runOne(job: typeof jobs.$inferSelect) {
  const handler = handlers.get(job.type);
  try {
    if (!handler) throw new Error(L(`未知任务类型 ${job.type}`, `Unknown job type ${job.type}`));
    const result = await handler.run(job.payload, { attempt: job.attempts, lastAttempt: job.attempts >= handler.maxAttempts });
    await db
      .update(jobs)
      .set({ status: 'done', result: result ?? null, error: null, finishedAt: new Date() })
      .where(eq(jobs.id, job.id));
  } catch (err) {
    const message = (err as Error).message || String(err);
    if (err instanceof DeferredError) {
      // 推迟后重新排队，领取时加上的那次尝试退回去；加一点随机，避免同时堆回来
      await db
        .update(jobs)
        .set({ status: 'queued', error: message, attempts: sql`${jobs.attempts} - 1`, runAt: new Date(Date.now() + err.delayMs + Math.random() * 10_000) })
        .where(eq(jobs.id, job.id));
      return;
    }
    const retry = err instanceof RetryableError && job.attempts < (handler?.maxAttempts ?? 1);
    await db
      .update(jobs)
      .set(
        retry
          ? { status: 'queued', error: message, runAt: new Date(Date.now() + 30_000 * 2 ** (job.attempts - 1)) }
          : { status: 'failed', error: message, finishedAt: new Date() },
      )
      .where(eq(jobs.id, job.id));
    if (!retry) console.warn(`[jobs] ${job.type}#${job.id} 失败：${message}`);
  }
}

async function tick() {
  woken = false;
  const slots = CONCURRENCY - running;
  if (slots <= 0) return;
  const due = await db
    .update(jobs)
    .set({ status: 'running', attempts: sql`${jobs.attempts} + 1` })
    .where(sql`${jobs.id} IN (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now() ORDER BY run_at, id LIMIT ${slots} FOR UPDATE SKIP LOCKED)`)
    .returning()
    .catch((err) => (console.warn('[jobs] 领取任务失败', err), []));
  for (const job of due) {
    running++;
    void runOne(job).finally(() => {
      running--;
      if (woken || due.length === slots) void tick();
    });
  }
}

export async function startJobs() {
  // 上次退出时还在运行的任务重新排队（任务本身是幂等的）
  await db.update(jobs).set({ status: 'queued' }).where(eq(jobs.status, 'running'));
  await db.delete(jobs).where(and(sql`${jobs.status} IN ('done', 'failed')`, lt(jobs.createdAt, new Date(Date.now() - KEEP_DAYS * 86400_000))));
  timer = setInterval(() => void tick(), TICK_MS);
}

export function stopJobs() {
  if (timer) clearInterval(timer);
  timer = null;
}
