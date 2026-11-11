import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { requireAuth, requireScope, requireSession, type AppEnv } from '../auth/index.js';
import { ActionError } from '../services/actions.js';
import { ANALYTICS_RANGES, getAnalytics, type AnalyticsRange } from '../services/analytics.js';
import { deleteReport, generateReport, getReport, getReportSettings, listReports, saveReportSettings } from '../services/reports.js';
import { L } from '../i18n/index.js';

const kindParam = z.enum(['daily', 'weekly']).optional();

/** 报告和看板汇总了所有邮箱，只限制到部分账户的 API Key 不能查看 */
const allAccounts = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (c.var.auth.scope.accountIds)
      throw new ActionError(
        L(
          '这里包含所有邮箱的统计，限定账户的 API Key 不能查看',
          'This includes stats for all mailboxes, so API keys limited to specific accounts cannot view it',
        ),
        403,
      );
    await next();
  });

export const analyticsRoutes = new Hono<AppEnv>()
  .use(requireAuth())
  .use(requireScope('read'))
  .use(allAccounts())
  .get('/', async (c) => {
    const days = Number(c.req.query('days') ?? 30);
    if (!ANALYTICS_RANGES.includes(days as AnalyticsRange))
      throw new ActionError(L(`days 只能是 ${ANALYTICS_RANGES.join(' / ')}`, `days must be ${ANALYTICS_RANGES.join(' / ')}`));
    return c.json(await getAnalytics(days as AnalyticsRange));
  });

export const reportsRoutes = new Hono<AppEnv>()
  .use(requireAuth())
  .use(requireScope('read'))
  .use(allAccounts())
  .get('/', async (c) => c.json(await listReports(kindParam.parse(c.req.query('kind') || undefined), Number(c.req.query('limit') ?? 60))))
  .get('/:id', async (c) => {
    const r = await getReport(Number(c.req.param('id')));
    if (!r) return c.json({ error: 'not found' }, 404);
    return c.json(r);
  });

const generateInput = z.object({
  kind: z.enum(['daily', 'weekly']),
  // 周期内任意一天（YYYY-MM-DD），不填表示上一个完整周期
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const reportsAdminRoutes = new Hono<AppEnv>()
  .use(requireSession())
  .get('/reports/settings', async (c) => c.json(await getReportSettings()))
  .put('/reports/settings', async (c) => c.json(await saveReportSettings(await c.req.json())))
  .post('/reports/generate', async (c) => {
    const { kind, date } = generateInput.parse(await c.req.json());
    try {
      // 按本地时区解析日期，取当天中午避免夏令时边界
      return c.json(await generateReport(kind, date ? new Date(`${date}T12:00:00`) : undefined));
    } catch (err) {
      throw new ActionError((err as Error).message);
    }
  })
  .delete('/reports/:id', async (c) => {
    await deleteReport(Number(c.req.param('id')));
    return c.json({ ok: true });
  });
