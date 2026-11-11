import { currentLocale, L } from '../i18n/index.js';
import { OAUTH_SCOPES, type OAuthScope } from './scopes.js';

/** 授权相关页面：服务端渲染、不加载脚本，所有动态内容都经过转义 */

export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";

export function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function layout(title: string, body: string) {
  return `<!doctype html>
<html lang="${currentLocale()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} · DaMail</title>
<style>
:root{--bg:#f5f6f8;--card:#fff;--text:#1f2329;--muted:#646a73;--line:#e4e6eb;--soft:#f7f8fa;--primary:#1677ff;--primary-soft:#e6f4ff;--danger:#d4380d;--ok-bg:#f6ffed;--ok-text:#389e0d;--blue-bg:#e6f4ff;--blue-text:#0958d9;--red-bg:#fff1f0;--red-text:#cf1322}
@media (prefers-color-scheme: dark){:root{--bg:#141414;--card:#1f1f1f;--text:#e6e6e6;--muted:#a6a6a6;--line:#303030;--soft:#262626;--primary:#4096ff;--primary-soft:#111d2c;--danger:#ff7a45;--ok-bg:#162312;--ok-text:#73d13d;--blue-bg:#111d2c;--blue-text:#69b1ff;--red-bg:#2a1215;--red-text:#ff7875}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:640px;margin:40px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px 24px 0}
.card>:last-child{margin-bottom:24px}
h1{font-size:20px;margin:0 0 16px}
p{margin:0 0 12px}
.muted{color:var(--muted)}
.small{font-size:12px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
label{display:block}
input[type=text],input[type=password]{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;font:inherit;margin:4px 0 12px}
input[type=checkbox],input[type=radio]{accent-color:var(--primary);width:16px;height:16px;flex:none}
.app{display:flex;gap:12px;align-items:center;margin-bottom:16px}
.app-icon{width:44px;height:44px;border-radius:10px;background:var(--primary-soft);color:var(--primary);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:600;flex:none}
.app-name{font-size:16px;font-weight:600}
.who{display:flex;justify-content:space-between;align-items:center;gap:12px;background:var(--soft);border-radius:8px;padding:8px 12px;margin:0 0 20px}
.section{margin:0 0 20px}
.section-title{display:flex;justify-content:space-between;align-items:baseline;font-weight:600;margin-bottom:8px}
.section-title .muted{font-weight:400;font-size:12px}
.options{border:1px solid var(--line);border-radius:8px;overflow:hidden}
.opt{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;cursor:pointer}
.opt+.opt{border-top:1px solid var(--line)}
.opt input{margin-top:3px}
.opt-body{flex:1;min-width:0}
.opt-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.opt-desc{display:block;color:var(--muted);font-size:13px;margin-top:2px}
.tag{font-size:12px;line-height:18px;padding:0 6px;border-radius:4px;white-space:nowrap}
.tag-read{background:var(--ok-bg);color:var(--ok-text)}
.tag-write{background:var(--blue-bg);color:var(--blue-text)}
.tag-send{background:var(--red-bg);color:var(--red-text)}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--muted)}
.seg{display:inline-flex;gap:2px;padding:2px;background:var(--soft);border:1px solid var(--line);border-radius:8px}
.seg label{display:flex;align-items:center;gap:6px;padding:3px 12px;border-radius:6px;font-size:13px;font-weight:400;color:var(--muted);cursor:pointer;white-space:nowrap}
.scope-note{background:var(--soft);border-radius:8px;padding:10px 12px;color:var(--muted);font-size:13px}
.mb-section{counter-reset:sel}
.mb-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-height:316px;overflow:auto;padding:1px}
.mb{display:flex;gap:10px;align-items:center;min-width:0;min-height:56px;border:1px solid var(--line);border-radius:8px;padding:8px 12px;cursor:pointer}
.mb input:checked{counter-increment:sel}
.mb-text{flex:1;min-width:0}
.mb-name,.mb-email{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mb-email{color:var(--muted);font-size:12px}
.mb-foot{display:flex;justify-content:space-between;gap:12px;margin-top:8px;font-size:12px;color:var(--muted)}
.sel-count::before{content:counter(sel)}
.need-pick{display:none;color:var(--danger)}
.mb-section .section-title{align-items:center}
/* 支持 :has 的浏览器：全部 / 指定做成切换按钮，选「指定」才显示邮箱卡片；不支持时退化为普通单选框并全部显示 */
@supports selector(:has(*)){
.seg label{position:relative}
.seg input{position:absolute;opacity:0;pointer-events:none}
.seg label:has(input:checked){background:var(--card);color:var(--text);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.seg label:has(input:focus-visible){outline:2px solid var(--primary);outline-offset:1px}
.picker{display:none}
.mb-section:has(input[value=selected]:checked) .picker{display:block}
.mb-section:has(input[value=selected]:checked) .scope-note{display:none}
.mb-section:not(:has(.mb input:checked)) .need-pick{display:inline}
.mb:has(input:checked){border-color:var(--primary);background:var(--primary-soft)}
}
.empty{margin-top:8px}
details{margin:0 0 16px}
summary{cursor:pointer}
details .mono{margin-top:6px}
.email{word-break:break-all}
.actions{display:flex;gap:12px;justify-content:flex-end;align-items:center;position:sticky;bottom:0;background:var(--card);border-top:1px solid var(--line);margin:0 -24px;padding:14px 24px;border-radius:0 0 12px 12px}
.actions .muted{margin-right:auto;font-size:12px}
/* 主按钮在 DOM 里排第一，回车默认提交它；视觉上放在最右 */
.actions button.primary{order:2}
.actions button{flex:none;white-space:nowrap}
.card>.actions:last-child,.card>form:last-child{margin-bottom:0}
button{font:inherit;padding:8px 18px;border-radius:6px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
button.primary{background:var(--primary);border-color:var(--primary);color:#fff}
button.link{border:none;padding:0;color:var(--primary);background:none}
.error{color:var(--danger);background:var(--red-bg);border-radius:6px;padding:8px 12px}
.row{display:flex;justify-content:space-between;gap:12px;align-items:center}
@media (max-width:560px){.mb-grid{grid-template-columns:1fr}}
@media (max-width:480px){main{margin:16px auto}.card{padding:20px 16px 0}.actions{margin:0 -16px;padding:12px 16px}}
</style>
</head>
<body><main><div class="card">${body}</div></main></body>
</html>`;
}

export function errorPage(title: string, message: string) {
  return layout(
    title,
    `<h1>${esc(title)}</h1><p>${esc(message)}</p><p class="muted">${L('可以关闭此页面，回到发起授权的应用重新连接。', 'You can close this page and reconnect from the app that started the authorization.')}</p>`,
  );
}

export type ClientInfo = { clientId: string; clientName?: string | null };

/** client_id 是 URL（CIMD）时显示它的域名，帮助用户确认请求来自哪里 */
function clientHost(clientId: string) {
  try {
    const u = new URL(clientId);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.host : null;
  } catch {
    return null;
  }
}

function clientLine(client: ClientInfo) {
  const name = client.clientName || L('未命名应用', 'Unnamed app');
  const host = clientHost(client.clientId);
  return `<div class="app">
<div class="app-icon" aria-hidden="true">${esc([...name][0]?.toUpperCase() ?? '?')}</div>
<div><div class="app-name">${esc(name)}</div><div class="muted small">${L('请求访问你的 DaMail', 'is requesting access to your DaMail')}${host ? ` · ${L('来自', 'from')} ${esc(host)}` : ''}</div></div>
</div>`;
}

export function loginPage(opts: { uid: string; csrf: string; client: ClientInfo; error?: string; username?: string }) {
  return layout(
    L('登录 DaMail', 'Sign in to DaMail'),
    `<h1>${L('登录 DaMail', 'Sign in to DaMail')}</h1>
${clientLine(opts.client)}
${opts.error ? `<p class="error">${esc(opts.error)}</p>` : ''}
<form method="post" action="/oauth/interaction/${esc(opts.uid)}/login">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<label>${L('用户名', 'Username')}<input type="text" name="username" autocomplete="username" required value="${esc(opts.username ?? '')}"></label>
<label>${L('密码', 'Password')}<input type="password" name="password" autocomplete="current-password" required></label>
<p class="muted small">${L('登录后还需要你确认授权哪些权限，登录本身不会授予访问权限。', 'After signing in you choose which permissions to grant. Signing in alone grants no access.')}</p>
<div class="actions">
<button type="submit" class="primary">${L('登录', 'Sign in')}</button>
<button type="submit" formaction="/oauth/interaction/${esc(opts.uid)}/abort" formnovalidate>${L('取消', 'Cancel')}</button>
</div>
</form>`,
  );
}

const SCOPE_TAG = (): Record<OAuthScope, [string, string]> => ({
  'mail:read': ['tag-read', L('只读', 'Read-only')],
  'mail:organize': ['tag-write', L('可修改', 'Can modify')],
  'mail:draft': ['tag-write', L('可修改', 'Can modify')],
  'mail:send': ['tag-send', L('可发信', 'Can send')],
});

export function consentPage(opts: {
  uid: string;
  csrf: string;
  client: ClientInfo;
  username: string;
  scopes: OAuthScope[];
  mailboxes: { id: number; name: string; email: string }[];
  error?: string;
  /** 提交出错重新显示时，保留用户刚才的选择 */
  keep?: { scopes: string[]; mailboxes: 'all' | 'selected'; accounts: number[] };
}) {
  const order = Object.keys(OAUTH_SCOPES);
  const scopeItems = [...opts.scopes]
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((s) => {
      const def = OAUTH_SCOPES[s];
      const [tagClass, tagText] = SCOPE_TAG()[s];
      const checked = !opts.keep || opts.keep.scopes.includes(s) ? ' checked' : '';
      return `<label class="opt"><input type="checkbox" name="scope" value="${esc(s)}"${checked}><span class="opt-body"><span class="opt-head"><b>${esc(def.label)}</b><span class="tag ${tagClass}">${tagText}</span><span class="code">${esc(s)}</span></span><span class="opt-desc">${esc(def.description)}</span></span></label>`;
    })
    .join('');
  // 名称和地址相同（或没起名）时只显示地址
  const picked = new Set(opts.keep?.accounts ?? []);
  const boxes = opts.mailboxes
    .map((m) => {
      const name = m.name?.trim();
      const text =
        !name || name === m.email
          ? `<span class="mb-name">${esc(m.email)}</span>`
          : `<span class="mb-name">${esc(name)}</span><span class="mb-email">${esc(m.email)}</span>`;
      return `<label class="mb" title="${esc(m.email)}"><input type="checkbox" name="account" value="${m.id}"${picked.has(m.id) ? ' checked' : ''}><span class="mb-text">${text}</span></label>`;
    })
    .join('');
  const count = opts.mailboxes.length;
  const selected = opts.keep?.mailboxes === 'selected';
  return layout(
    L('授权确认', 'Authorize access'),
    `<h1>${L('授权确认', 'Authorize access')}</h1>
${clientLine(opts.client)}
<form method="post" action="/oauth/interaction/${esc(opts.uid)}/switch" class="who">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<span>${L(`以 <b>${esc(opts.username)}</b> 的身份授权`, `Authorizing as <b>${esc(opts.username)}</b>`)}</span>
<button type="submit" class="link">${L('切换账号', 'Switch account')}</button>
</form>
${opts.error ? `<p class="error">${esc(opts.error)}</p>` : ''}
<form method="post" action="/oauth/interaction/${esc(opts.uid)}/confirm">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<div class="section">
<div class="section-title"><span>${L('请求的权限', 'Requested permissions')}</span><span class="muted">${L('可取消勾选不想授予的', 'Uncheck any you do not want to grant')}</span></div>
<div class="options">${scopeItems}</div>
</div>
<div class="section mb-section">
<div class="section-title"><span>${L('可访问的邮箱', 'Mailbox access')}</span>
<span class="seg">
<label><input type="radio" name="mailboxes" value="all"${selected ? '' : ' checked'}>${L('全部邮箱', 'All mailboxes')}</label>
<label><input type="radio" name="mailboxes" value="selected"${selected ? ' checked' : ''}>${L('指定邮箱', 'Selected mailboxes')}</label>
</span></div>
<div class="scope-note">${count ? L(`可以访问全部 ${count} 个邮箱，以后新添加的邮箱也包括在内。`, `Can access all ${count} mailboxes, including ones added later.`) : L('还没有添加邮箱。授权后新添加的邮箱也包括在内。', 'No mailboxes yet. Mailboxes added after authorizing are included.')}</div>
<div class="picker">${
      count
        ? `<div class="mb-grid">${boxes}</div>
<div class="mb-foot"><span>${L(`已选 <span class="sel-count"></span> / ${count} 个，以后新添加的邮箱不会自动包含`, `<span class="sel-count"></span> / ${count} selected. Mailboxes added later are not included automatically`)}</span><span class="need-pick">${L('请至少勾选一个邮箱', 'Select at least one mailbox')}</span></div>`
        : `<div class="scope-note">${L('还没有添加邮箱。', 'No mailboxes yet.')}</div>`
    }</div>
</div>
<details class="small muted"><summary>${L('应用详情', 'App details')}</summary><div class="mono">client_id: ${esc(opts.client.clientId)}</div></details>
<div class="actions">
<span class="muted">${L('可随时在「OAuth 授权」里撤销', 'You can revoke this anytime under OAuth authorizations')}</span>
<button type="submit" class="primary">${L('允许', 'Allow')}</button>
<button type="submit" formaction="/oauth/interaction/${esc(opts.uid)}/abort" formnovalidate>${L('拒绝', 'Deny')}</button>
</div>
</form>`,
  );
}
