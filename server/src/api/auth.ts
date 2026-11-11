import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { clearSession, issueSession, readSession, requireSession, type AppEnv } from '../auth/index.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
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

// 简单的登录失败限流：每个 IP 每 10 分钟最多 10 次失败
const failures = new Map<string, { count: number; until: number }>();
function clientIp(headers: Headers) {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || 'local';
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
    const created = await db.transaction(async (tx) => {
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(users);
      if (count > 0) return null;
      const [u] = await tx
        .insert(users)
        .values({ username: body.data.username, passwordHash: await hashPassword(body.data.password), locale: normalizeLocale(body.data.locale) ?? 'zh-CN' })
        .returning();
      return u;
    });
    if (!created) return c.json({ error: t().common.auth.alreadySetup }, 409);
    issueSession(c, created);
    await rememberUserLocale(created.id, created.locale as Locale);
    audit(`user:${created.id}`, 'auth.setup', { detail: { username: created.username } });
    return c.json(publicUser(created));
  })
  .post('/login', async (c) => {
    const ip = clientIp(c.req.raw.headers);
    const f = failures.get(ip);
    const body = loginCredentials.safeParse(await c.req.json().catch(() => ({})));
    const attempted = body.success ? body.data.username.slice(0, 100) : undefined;
    if (f && f.count >= 10 && f.until > Date.now()) {
      audit('anonymous', 'auth.login_blocked', { detail: { username: attempted } });
      return c.json({ error: t().common.auth.tooManyAttempts }, 429);
    }
    const user = body.success ? await db.query.users.findFirst({ where: eq(users.username, body.data.username) }) : null;
    if (!user || !body.success || !(await verifyPassword(body.data.password, user.passwordHash))) {
      const next = f && f.until > Date.now() ? f.count + 1 : 1;
      failures.set(ip, { count: next, until: Date.now() + 10 * 60_000 });
      audit('anonymous', 'auth.login_failed', { detail: { username: attempted } });
      return c.json({ error: t().common.auth.wrongCredentials }, 401);
    }
    failures.delete(ip);
    issueSession(c, user);
    audit(`user:${user.id}`, 'auth.login');
    return c.json(publicUser(user));
  })
  // 修改用户名 / 密码，都要验证当前密码；改密码后其他设备的登录失效，当前设备重新签发会话
  .put('/account', requireSession(), async (c) => {
    const ip = clientIp(c.req.raw.headers);
    const f = failures.get(ip);
    if (f && f.count >= 10 && f.until > Date.now()) return c.json({ error: t().common.auth.tooManyAttempts }, 429);
    const body = accountUpdate.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    const { currentPassword, username, newPassword } = body.data;
    const user = await db.query.users.findFirst({ where: eq(users.id, c.var.auth.userId) });
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      const next = f && f.until > Date.now() ? f.count + 1 : 1;
      failures.set(ip, { count: next, until: Date.now() + 10 * 60_000 });
      return c.json({ error: t().common.auth.wrongCurrentPassword }, 400);
    }
    failures.delete(ip);
    const renamed = username !== undefined && username !== user.username;
    if (!renamed && !newPassword) return c.json(publicUser(user));
    if (renamed) {
      const taken = await db.query.users.findFirst({ where: eq(users.username, username) });
      if (taken) return c.json({ error: t().common.auth.usernameTaken }, 409);
    }
    const [updated] = await db
      .update(users)
      .set({ ...(renamed ? { username } : {}), ...(newPassword ? { passwordHash: await hashPassword(newPassword) } : {}) })
      .where(eq(users.id, user.id))
      .returning();
    if (newPassword) issueSession(c, updated!);
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
    const uid = await readSession(c);
    if (uid) audit(`user:${uid}`, 'auth.logout');
    clearSession(c);
    return c.json({ ok: true });
  });
