import { Hono, type Context } from 'hono';
import { readSession, requireSession, type AppEnv } from '../auth/index.js';
import { audit } from '../lib/audit.js';
import { OAUTH_PROVIDERS, completeOAuth, getOAuthConfig, oauthAuthorizeUrl, saveOAuthConfig, type OAuthProvider } from '../services/oauth.js';
import { syncEngine } from '../sync/engine.js';
import { L } from '../i18n/index.js';

// 授权结果页（相对地址：前后端同域部署时回到当前站点；开发时后端会把页面请求转给 Vite）
const back = (provider: OAuthProvider, params: Record<string, string>) => `/oauth/result?${new URLSearchParams({ provider, ...params })}`;

const providerOf = (c: Context<AppEnv>) => {
  const p = c.req.param('provider') as OAuthProvider;
  return OAUTH_PROVIDERS.includes(p) ? p : null;
};

/** 管理端：OAuth 应用配置 */
export const oauthAdminRoutes = new Hono<AppEnv>()
  .use(requireSession())
  .get('/oauth/:provider', async (c) => {
    const p = providerOf(c);
    return p ? c.json(await getOAuthConfig(p)) : c.notFound();
  })
  .put('/oauth/:provider', async (c) => {
    const p = providerOf(c);
    return p ? c.json(await saveOAuthConfig(p, await c.req.json())) : c.notFound();
  });

/** 浏览器跳转的授权入口和回调（GET 导航，靠会话 cookie 和 state 绑定同一个用户） */
export const oauthRoutes = new Hono<AppEnv>()
  .get('/:provider/start', requireSession(), async (c) => {
    const p = providerOf(c);
    if (!p) return c.notFound();
    const accountId = Number(c.req.query('account')) || undefined;
    try {
      return c.redirect(await oauthAuthorizeUrl(p, c.var.auth.userId, accountId));
    } catch (err) {
      return c.redirect(back(p, { oauth_error: (err as Error).message }));
    }
  })
  .get('/:provider/callback', async (c) => {
    const p = providerOf(c);
    if (!p) return c.notFound();
    const uid = await readSession(c);
    if (!uid)
      return c.redirect(
        back(p, { oauth_error: L('登录已过期，请重新登录 DaMail 后再授权', 'Your session has expired. Sign in to DaMail again and then authorize') }),
      );
    const error = c.req.query('error');
    if (error) return c.redirect(back(p, { oauth_error: c.req.query('error_description')?.split('\n')[0] || error }));
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) return c.redirect(back(p, { oauth_error: L('回调缺少参数', 'The callback is missing parameters') }));
    try {
      const account = await completeOAuth(p, uid, state, code);
      audit(`user:${uid}`, 'account.oauth', { accountId: account.id, detail: { provider: p } });
      if (account.enabled) await syncEngine.restartAccount(account.id);
      return c.redirect(back(p, { oauth: 'ok', email: account.email }));
    } catch (err) {
      return c.redirect(back(p, { oauth_error: (err as Error).message }));
    }
  });
