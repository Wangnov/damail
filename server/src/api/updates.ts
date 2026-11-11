import { Hono } from 'hono';
import { requireSession, type AppEnv } from '../auth/index.js';
import { updateStatus } from '../services/updates.js';

/** 网页上的「有新版本」提示：GitHub 上最新的正式版本（服务端缓存），?refresh=1 立即重新检查（最短间隔 1 分钟） */
export const updateRoutes = new Hono<AppEnv>().use('/updates', requireSession()).get('/updates', async (c) => {
  return c.json(await updateStatus({ refresh: c.req.query('refresh') === '1' }));
});
