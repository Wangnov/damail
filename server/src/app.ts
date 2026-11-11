import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { ZodError } from 'zod';
import { adminRoutes } from './api/admin.js';
import { authRoutes } from './api/auth.js';
import { automationAdminRoutes, channelListRoutes, rulesRoutes } from './api/automation.js';
import { labelAdminRoutes } from './api/labels.js';
import { analyticsRoutes, reportsAdminRoutes, reportsRoutes } from './api/reports.js';
import { assistantRoutes } from './api/assistant.js';
import { oauthAdminRoutes, oauthRoutes } from './api/oauth.js';
import { v1Routes } from './api/v1.js';
import { config } from './config.js';
import { localeMiddleware, t } from './i18n/index.js';
import { auditRequests } from './lib/audit.js';
import { mcpRoutes } from './mcp/server.js';
import { mcpOAuthAdminRoutes } from './api/mcp-oauth-admin.js';
import { auditAdminRoutes } from './api/audit-admin.js';
import { updateRoutes } from './api/updates.js';
import { oauthRoutes as mcpOAuthRoutes } from './oauth/routes.js';
import { ActionError } from './services/actions.js';
import { describeImapError } from './sync/imap.js';

/** 组装 HTTP 应用（不启动同步、发件等后台任务，测试可以直接使用） */
export function createApp() {
  const app = new Hono();

  app.use('*', localeMiddleware);
  app.use('/api/*', logger());
  app.use('*', secureHeaders({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: undefined }));

  // 审计：开放接口每次调用都记录，网页后台记录写操作（规则见 lib/audit.ts）
  app.use('/api/*', auditRequests('api'));
  app.use('/mcp', auditRequests('mcp'));
  app.use('/oauth/*', auditRequests('oauth'));

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.route('/api/auth', authRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/api/admin', automationAdminRoutes);
  app.route('/api/admin', labelAdminRoutes);
  app.route('/api/admin', reportsAdminRoutes);
  app.route('/api/admin', assistantRoutes);
  app.route('/api/admin', oauthAdminRoutes);
  app.route('/api/oauth', oauthRoutes);
  app.route('/api/v1/reports', reportsRoutes);
  app.route('/api/v1/analytics', analyticsRoutes);
  app.route('/api/v1/rules', rulesRoutes);
  app.route('/api/v1/channels', channelListRoutes);
  app.route('/api/v1', v1Routes);
  app.route('/mcp', mcpRoutes);
  // MCP OAuth：受保护资源 / 授权服务器元数据、协议端点和登录同意页（未启用时全部 404）
  app.route('/', mcpOAuthRoutes);
  app.route('/api/admin', mcpOAuthAdminRoutes);
  app.route('/api/admin', auditAdminRoutes);
  app.route('/api/admin', updateRoutes);

  app.onError((err, c) => {
    if (err instanceof ActionError) return c.json({ error: err.message }, err.status);
    if (err instanceof ZodError) return c.json({ error: err.issues[0]?.message ?? t().common.invalidParams }, 400);
    // IMAP 写操作失败（服务器拒绝、断线等）
    if ((err as { responseText?: string }).responseText || (err as { code?: string }).code?.startsWith?.('E'))
      return c.json({ error: t().common.mailServerFailed(describeImapError(err)) }, 502);
    console.error('[http]', err);
    return c.json({ error: err.message || 'internal error' }, 500);
  });

  // 生产环境由后端直接托管前端静态文件（SPA 回退到 index.html）
  if (config.webDist && existsSync(config.webDist)) {
    const root = path.relative(process.cwd(), config.webDist);
    const indexHtml = readFileSync(path.join(config.webDist, 'index.html'), 'utf8');
    app.use('/*', serveStatic({ root }));
    app.get('*', (c) => c.html(indexHtml));
  }
  // 开发时前端由 Vite 提供：OAuth 回调等直接打到后端的页面跳转转给前端
  else if (!config.webDist) {
    app.get('*', (c) => {
      const url = new URL(c.req.url);
      if (/^\/(api|mcp|oauth|\.well-known)(\/|$)/.test(url.pathname)) return c.notFound();
      return c.redirect(`${config.devWebUrl}${url.pathname}${url.search}`);
    });
  }
  return app;
}
