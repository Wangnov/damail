import { eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { clearSession, issueSession, readSession, requireSession, revokeSessions, type AppEnv } from '../auth/index.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { audit, requestIp } from '../lib/audit.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { isLocale, normalizeLocale, rememberUserLocale, t, type Locale } from '../i18n/index.js';

const credentials = z.object({
  username: z.string().trim().min(1).max(64),
  password: z
    .string()
    .min(8, { error: () => t().common.auth.passwordMin })
    .max(200),
  // 初始化时网页带上当前界面语言
  locale: z.string().optional(),
});

// 登录只校验非空，密码强度只在创建时检查
const loginCredentials = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

const accountUpdate = z.object({
  currentPassword: z
    .string()
    .min(1, { error: () => t().common.auth.currentPasswordRequired })
    .max(200),
  username: z
    .string()
    .trim()
    .min(1, { error: () => t().common.auth.usernameRequired })
    .max(64)
    .optional(),
  newPassword: z
    .string()
    .min(8, { error: () => t().common.auth.newPasswordMin })
    .max(200)
    .optional(),
});

const publicUser = (u: { id: number; username: string; locale: string }) => ({ id: u.id, username: u.username, locale: u.locale });

/**
 * 密码尝试限流（单实例，内存计数）：
 * - 按 IP 每 10 分钟 10 次失败；IP 取 X-Real-IP / X-Forwarded-For 最后一跳，客户端自己填的前几跳不算
 * - 按账号每 10 分钟 30 次失败，换 IP 也绕不过。只给真实存在的账号计数（user:<id>），
 *   条目数不超过账号数，计数表再满也不会被挤掉；不存在的用户名单独计数（name:<用户名>）
 * - 检查和计数在同一个同步调用里完成，紧挨着密码校验，并发猜密码也会被计入
 */
const WINDOW_MS = 10 * 60_000;
const LIMITS = { ip: 10, account: 30 };
const MAX_KEYS = 10_000;
const failures = new Map<string, { count: number; until: number }>();

function attemptKeys(c: Context, account: { userId: number } | { username: string | undefined }) {
  const keys = [`ip:${requestIp(c)}`];
  if ('userId' in account) keys.push(`user:${account.userId}`);
  else if (account.username) keys.push(`name:${account.username.toLowerCase()}`);
  return keys;
}
const limitOf = (key: string) => (key.startsWith('ip:') ? LIMITS.ip : LIMITS.account);

/**
 * 开始一次密码校验：没超限就先把计数加上并返回 true，超限返回 false。
 * 整个函数是同步的，检查和计数之间不会插进别的请求；调用方在这之后立刻校验密码。
 */
function tryBeginAttempt(keys: string[]) {
  const now = Date.now();
  const blocked = keys.some((k) => {
    const f = failures.get(k);
    return Boolean(f && f.until > now && f.count >= limitOf(k));
  });
  if (blocked) return false;
  if (failures.size >= MAX_KEYS) {
    for (const [k, v] of failures) if (v.until <= now) failures.delete(k);
    // 清完还是太多（大量不同 IP / 用户名在试）：丢掉最早的 IP / 用户名条目，真实账号的计数不动
    for (const k of failures.keys()) {
      if (failures.size < MAX_KEYS) break;
      if (!k.startsWith('user:')) failures.delete(k);
    }
  }
  for (const k of keys) {
    const f = failures.get(k);
    if (f && f.until > now) f.count += 1;
    else failures.set(k, { count: 1, until: now + WINDOW_MS });
  }
  return true;
}
function attemptSucceeded(keys: string[]) {
  for (const k of keys) failures.delete(k);
}

export const authRoutes = new Hono<AppEnv>()
  .get('/status', async (c) => {
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
    const uid = await readSession(c);
    const user = uid ? await db.query.users.findFirst({ where: eq(users.id, uid) }) : null;
    return c.json({ needsSetup: count === 0, user: user ? publicUser(user) : null });
  })
  .post('/setup', async (c) => {
    const body = credentials.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    // 已经初始化过就直接拒绝，不白算哈希；哈希比较慢，放在锁外面算
    if (await db.$count(users)) return c.json({ error: t().common.auth.alreadySetup }, 409);
    const passwordHash = await hashPassword(body.data.password);
    const created = await db.transaction(async (tx) => {
      // 事务级咨询锁让并发的初始化请求排队：否则两个请求都看到 0 个用户，会各建一个管理员
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('damail:setup'))`);
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(users);
      if (count > 0) return null;
      const [u] = await tx
        .insert(users)
        .values({ username: body.data.username, passwordHash, locale: normalizeLocale(body.data.locale) ?? 'zh-CN' })
        .returning();
      return u;
    });
    if (!created) return c.json({ error: t().common.auth.alreadySetup }, 409);
    await issueSession(c, created);
    await rememberUserLocale(created.id, created.locale as Locale);
    audit(`user:${created.id}`, 'auth.setup', { detail: { username: created.username } });
    return c.json(publicUser(created));
  })
  .post('/login', async (c) => {
    const body = loginCredentials.safeParse(await c.req.json().catch(() => ({})));
    const attempted = body.success ? body.data.username.slice(0, 100) : undefined;
    const user = body.success ? await db.query.users.findFirst({ where: eq(users.username, body.data.username) }) : null;
    const keys = attemptKeys(c, user ? { userId: user.id } : { username: attempted });
    if (!tryBeginAttempt(keys)) {
      audit('anonymous', 'auth.login_blocked', { detail: { username: attempted } });
      return c.json({ error: t().common.auth.tooManyAttempts }, 429);
    }
    if (!user || !body.success || !(await verifyPassword(body.data.password, user.passwordHash))) {
      audit('anonymous', 'auth.login_failed', { detail: { username: attempted } });
      return c.json({ error: t().common.auth.wrongCredentials }, 401);
    }
    attemptSucceeded(keys);
    // 校验期间密码被改了：校验过的是旧密码，不签发
    if (!(await issueSession(c, user))) return c.json({ error: t().common.auth.wrongCredentials }, 401);
    audit(`user:${user.id}`, 'auth.login');
    return c.json(publicUser(user));
  })
  // 修改用户名 / 密码，都要验证当前密码；改密码后其他设备的登录失效，当前设备重新签发会话
  .put('/account', requireSession(), async (c) => {
    const body = accountUpdate.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    const { currentPassword, username, newPassword } = body.data;
    const user = await db.query.users.findFirst({ where: eq(users.id, c.var.auth.userId) });
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    // 检查和计数紧挨着密码校验，中间没有 await，并发请求不能一起越过限额
    const keys = attemptKeys(c, { userId: user.id });
    if (!tryBeginAttempt(keys)) return c.json({ error: t().common.auth.tooManyAttempts }, 429);
    if (!(await verifyPassword(currentPassword, user.passwordHash))) return c.json({ error: t().common.auth.wrongCurrentPassword }, 400);
    attemptSucceeded(keys);
    const renamed = username !== undefined && username !== user.username;
    if (!renamed && !newPassword) return c.json(publicUser(user));
    if (renamed) {
      const taken = await db.query.users.findFirst({ where: eq(users.username, username) });
      if (taken) return c.json({ error: t().common.auth.usernameTaken }, 409);
    }
    const [updated] = await db
      .update(users)
      // 改密码时纪元也加一：其他设备的会话失效，并保证「纪元相同 = 密码哈希相同」，会话缓存只需比较纪元
      .set({ ...(renamed ? { username } : {}), ...(newPassword ? { passwordHash: await hashPassword(newPassword), sessionEpoch: sql`${users.sessionEpoch} + 1` } : {}) })
      .where(eq(users.id, user.id))
      .returning();
    if (newPassword) await issueSession(c, updated!);
    audit(`user:${user.id}`, 'user.update', { detail: { username: renamed ? username : undefined, password: Boolean(newPassword) } });
    return c.json(publicUser(updated!));
  })
  // 界面语言：跟账号走，换设备也一样；通知、报告、AI 回答也按它生成
  .put('/locale', requireSession(), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { locale?: unknown };
    if (!isLocale(body.locale)) return c.json({ error: t().common.auth.unsupportedLocale }, 400);
    const [updated] = await db.update(users).set({ locale: body.locale }).where(eq(users.id, c.var.auth.userId)).returning();
    if (!updated) return c.json({ error: 'unauthorized' }, 401);
    await rememberUserLocale(updated.id, body.locale);
    return c.json(publicUser(updated));
  })
  .post('/logout', async (c) => {
    // 和其他写请求一样要求 x-damail 头：退出会让所有设备下线，不能被同站的其他页面伪造请求触发
    if (c.req.header('x-damail') !== '1') return c.json({ error: 'missing x-damail header' }, 403);
    const uid = await readSession(c);
    if (uid) {
      await revokeSessions(uid);
      audit(`user:${uid}`, 'auth.logout');
    }
    clearSession(c);
    return c.json({ ok: true });
  });
