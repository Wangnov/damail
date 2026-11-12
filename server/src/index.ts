import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { config } from './config.js';
import { pool, runMigrations } from './db/index.js';
import { loadSystemLocale } from './i18n/index.js';
import { purgeAuditLogs } from './lib/audit.js';
import { purgeExpiredOAuthPayloads } from './oauth/adapter.js';
import { loadMcpOAuthSettings } from './oauth/settings.js';
import { startFollowUps, stopFollowUps } from './services/followups.js';
import { startJobs, stopJobs } from './services/jobs.js';
import { backfillListInfo } from './services/subscriptions.js';
import { collectRawGarbage } from './services/raw-gc.js';
import { syncBuiltins } from './services/catalog.js';
import './services/notify.js';
import './services/pipeline.js';
import { startReports, stopReports } from './services/reports.js';
import { startOutbox, stopOutbox } from './services/send.js';
import { syncEngine } from './sync/engine.js';
import { closeImapWriters } from './sync/imap-writer.js';

const app = createApp();

await runMigrations();
console.log('[db] 迁移完成');
await loadSystemLocale();
// 系统内置的分类和提示词：以代码为准写进数据库，之后从数据库读
await syncBuiltins();
// 网页上保存过的 MCP OAuth 设置优先于环境变量，必须在开始接收请求前加载
await loadMcpOAuthSettings();

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[http] DaMail 已启动: http://localhost:${info.port}  (MCP: ${config.publicUrl}/mcp)`);
});

await syncEngine.start();
await startOutbox();
await startJobs();
startReports();
startFollowUps();
void backfillListInfo();
// 过期的授权码 / 令牌本来就不会被接受，这里只回收空间
// OAuth 可在网页上随时开启，过期记录的清理一直跑（没有记录时只是一条空 DELETE）
const oauthPurge = setInterval(() => void purgeExpiredOAuthPayloads().catch(() => {}), 3600_000);
// 审计日志按网页上设置的保留天数清理（默认 180 天），启动时先跑一次
const runAuditPurge = () =>
  void purgeAuditLogs()
    .then((n) => n && console.log(`[audit] 清理了 ${n} 条过期审计日志`))
    .catch((err) => console.warn('[audit] 清理失败', err));
runAuditPurge();
const auditPurge = setInterval(runAuditPurge, 6 * 3600_000);
// 原始邮件文件不会随邮件删除（相同内容共用文件），每天扫一遍删掉没有引用的；启动 10 分钟后先跑一次
const runRawGc = () =>
  void collectRawGarbage()
    .then((r) => (r.files || r.accounts) && console.log(`[raw] 清理了 ${r.files} 个原始邮件文件（${(r.bytes / 1024 / 1024).toFixed(1)} MB），${r.accounts} 个已删除邮箱的目录`))
    .catch((err) => console.warn('[raw] 清理失败', err));
const rawGcFirst = setTimeout(runRawGc, 10 * 60_000);
const rawGc = setInterval(runRawGc, 24 * 3600_000);

async function shutdown(signal: string) {
  console.log(`[app] 收到 ${signal}，正在关闭…`);
  server.close();
  clearInterval(oauthPurge);
  clearInterval(auditPurge);
  clearTimeout(rawGcFirst);
  clearInterval(rawGc);
  stopOutbox();
  stopJobs();
  stopReports();
  stopFollowUps();
  await syncEngine.stopAll();
  await closeImapWriters();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
