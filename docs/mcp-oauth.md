# MCP OAuth：让 ChatGPT 等客户端通过登录授权接入 DaMail

> 状态：已在实际部署中与 ChatGPT 接通（2026-11-09，CIMD + private_key_jwt，经代理抓取客户端文档；授权 `mail:read`，ChatGPT 已成功调用读邮件工具）。

## 1. 做了什么

ChatGPT 自定义 MCP 连接器要求标准 OAuth。用户在 ChatGPT 添加 DaMail 后：

1. ChatGPT 访问 `/mcp` 得到 `401`，从 `WWW-Authenticate` 的 `resource_metadata` 找到受保护资源元数据（RFC 9728），再找到授权服务器元数据（RFC 8414 / OIDC Discovery）
2. ChatGPT 带 PKCE(S256) 和 `resource` 打开 `/oauth/authorize`
3. 用户登录自己的 DaMail（登录 ≠ 同意），在同意页看到当前账号、请求方、每个权限的含义，可以取消勾选权限、限定可访问的邮箱，然后允许或拒绝
4. 回调带 `code`、原样的 `state` 和 `iss`（RFC 9207），ChatGPT 用 `code_verifier` 换取 access token（15 分钟）和 refresh token（30 天，每次刷新轮换）
5. ChatGPT 带 token 调用 `/mcp`；每次请求都在数据库里校验有效期、audience、是否撤销和权限
6. 用户可以随时在 DaMail「开放接口 → OAuth 授权」撤销，access / refresh token 立即失效

三条认证链路互相独立：

| 链路 | 方向 | 凭证 | 说明 |
| --- | --- | --- | --- |
| 邮件服务商 OAuth（`/api/oauth/{google,microsoft}/*`） | DaMail → Gmail / Microsoft | 服务商的 refresh token（加密存储） | **未改动**，不能拿来当 ChatGPT 的凭证 |
| MCP OAuth（本次新增，`/oauth/*`） | ChatGPT → DaMail `/mcp` | DaMail 签发的 opaque token | 只能访问 `/mcp`，访问 `/api/v1` 一律 401 |
| API Key / 网页会话 | Agent / 浏览器 → DaMail | `dm_` 开头的 Key / Cookie | 行为不变 |

## 2. 角色与地址

- **受保护资源**（resource server）：`MCP_OAUTH_RESOURCE`，默认 `${PUBLIC_URL}/mcp`。令牌的 audience 绑定到它
- **授权服务器**（issuer）：`MCP_OAUTH_ISSUER`，默认 `PUBLIC_URL`，必须与资源同源、不带路径
- **客户端**：ChatGPT。只接受 `MCP_OAUTH_CIMD_CLIENTS` 精确列出的 client_id URL（CIMD）或 `MCP_OAUTH_STATIC_CLIENTS` 预注册的 client；回调地址只接受 `MCP_OAUTH_REDIRECT_URIS` 与预注册客户端里精确列出的值

| 路径 | 作用 |
| --- | --- |
| `GET /.well-known/oauth-protected-resource/mcp`（以及根路径 `/.well-known/oauth-protected-resource`） | RFC 9728 受保护资源元数据 |
| `GET /.well-known/oauth-authorization-server`、`/.well-known/openid-configuration` | 授权服务器元数据 |
| `GET /oauth/authorize` | 授权端点 |
| `POST /oauth/token` | 换 token / 刷新（只支持 `authorization_code`、`refresh_token`） |
| `POST /oauth/revoke` | RFC 7009 撤销 |
| `GET /oauth/jwks` | 授权服务器公钥（Ed25519，由 `MASTER_KEY` 派生；本服务不签发 ID Token / JWT access token） |
| `/oauth/interaction/:uid` | 登录 / 同意页（服务端渲染，无脚本，严格 CSP） |
| `GET/DELETE /api/admin/mcp-authorizations` | 网页上的授权列表与撤销（仅网页会话） |

元数据里声明的都是真实行为：`code_challenge_methods_supported: ["S256"]`、`authorization_response_iss_parameter_supported: true`、`client_id_metadata_document_supported: true`（仅在配置了 CIMD 客户端时）、`token_endpoint_auth_methods_supported: ["none", "private_key_jwt"]`、`scopes_supported` 只列 DaMail 权限和 `offline_access`。**没有** `registration_endpoint`（不支持 DCR），也不声明 introspection / userinfo / PAR / DPoP / 设备码。

## 3. 权限（scope）

| OAuth scope | 内部权限 | 能做什么 | 可见的 MCP 工具 |
| --- | --- | --- | --- |
| `mail:read` | read | 读邮件、会话、附件、草稿、统计、日报、通讯录 | `list_accounts` `list_folders` `semantic_search` `search_emails` `get_email` `get_thread` `get_attachment` `get_stats` `list_waiting` `list_subscriptions` `list_contacts` `translate_email` `get_report` `list_reports` `list_drafts` `get_draft` |
| `mail:organize` | organize | 标记、移动、跟进提醒 | `mark_emails` `move_emails` `set_follow_up` `clear_follow_up` |
| `mail:draft` | draft | 写草稿、提交网页审批、撤销 | `create_draft` `update_draft` `delete_draft` `request_send` `cancel_send` |
| `mail:send` | send | 不经网页审批直接发送**本授权创建的**草稿 | `send_draft` |

- PRM 的 `scopes_supported` 只给 `mail:read`，客户端默认只请求只读；其他权限在调用时按需提示（逐步授权）
- `mail:send` 不由 `mail:draft` 推导，必须单独请求、在同意页单独勾选（带警示）
- 未知 scope → `invalid_scope`；`openid` 被接受但忽略（不签发 ID Token）；没有任何 `mail:*` → `invalid_scope`
- 退订、收信规则、通知渠道、忽略名单等工具**不对 OAuth 开放**
- 每次工具调用在服务端检查权限。权限不足时默认 HTTP 403 + `WWW-Authenticate: Bearer error="insufficient_scope", scope="..."`；`MCP_OAUTH_SCOPE_CHALLENGE=tool` 时改为工具返回 `isError` 和 `_meta["mcp/www_authenticate"]`（两种模式下工具层都带这个兜底字段）。每个工具还声明 `_meta.securitySchemes`

### 资源归属与邮箱范围

- 每个授权绑定 **一个用户 + 同意页选定的邮箱范围**（全部或部分邮箱），按 ID 访问范围外的邮件、会话、附件、草稿都会被拒绝
- 草稿归属：OAuth 只能读写 / 提交 / 发送**本授权创建的**草稿；API Key 只能处理自己创建的草稿（原有规则）；网页会话可以处理全部草稿
- **已修复的既有缺陷**：原来 `loadOwned` 只对 API Key 做归属检查，其他凭证类型一律放行。现在改为按凭证类型匹配、未知类型默认拒绝（`server/src/services/drafts.ts` 的 `ownsDraft`）
- 直接发送：每个授权每小时最多 `MCP_OAUTH_SEND_LIMIT_PER_HOUR` 封（默认 10，`0` = 禁止），超出返回 429；OAuth 不能直接发出“待审批”状态的草稿（审批只能在网页上做）。保留原有的发送延迟撤销窗口、状态条件更新防重复入队、发送失败不自动重试（避免重复投递）

### 凭证选择规则（`server/src/auth/index.ts`）

- 只要有 `Authorization` 头，就只认它，不再看 Cookie；格式不是 `Bearer <token>` → 401
- `dm_` 开头 → API Key；其他 → 仅在 `/mcp` 且启用 MCP OAuth 时按 OAuth token 校验
- 无效、过期、已撤销、audience 不符 → 401 `invalid_token`，**不会回退到网页会话或 API Key**

## 4. 安全措施

- **实现**：授权服务器使用 [oidc-provider](https://github.com/panva/node-oidc-provider) 9.13.3（OpenID 认证过、持续维护），不自研协议。理由与备选见第 8 节
- **PKCE**：必须 S256；缺 challenge → `invalid_request`；`plain` 或其他方法 → 直接显示错误页
- **resource 绑定**（RFC 8707）：授权请求必须带 `resource` 且等于配置值；换 token / 刷新时带了就必须一致，没带则沿用授权时绑定的值（audience 不会变）
- **授权码**：5 分钟、一次性；数据库原子消费，重复或并发兑换只成功一次，并按重放撤销整个授权
- **refresh token**：每次刷新轮换；旧 token 重放 → 撤销整个授权（审计 `mcp_oauth.replay`，网页显示“检测到令牌重放”）；刷新不能扩大权限或更换 resource；其他 client 不能使用
- **存储**：令牌是高熵 opaque 值；数据库主键只存 SHA-256 摘要，payload 去掉令牌值本身；日志和审计不记录令牌
- **回调地址**：精确匹配白名单，不支持通配符；不在名单内时显示错误页，**不会跳转**到不可信地址
- **CIMD**：只抓取白名单里精确列出的 client_id URL（不会因为请求里出现某个 URL 就去抓取，防 SSRF）；oidc-provider 内置的抓取有私网地址拦截、2.5 秒超时、5 KB 上限；缓存 60 秒到 1 小时；文档里的 `client_id` 必须与 URL 一致，认证方式只能是 `none` 或 `private_key_jwt`，`redirect_uris` 至少一个在白名单内
- **经代理抓取**（`MCP_OAUTH_FETCH_PROXY_ID`）：服务器直连不了客户端时（国内服务器访问不了 chatgpt.com），CIMD 文档和客户端 JWKS 经「代理设置」里选定的代理请求。此时只允许 HTTPS 且源在 `MCP_OAUTH_CIMD_CLIENTS` 里的地址（代替直连时的私网地址拦截），不跟随重定向，超时 `MCP_OAUTH_FETCH_TIMEOUT_MS`（默认 8 秒）；代理不存在时报错，不会退回直连。客户端的 `jwks_uri` 必须与 client_id 同源
- **同意页**：CSRF（`SameSite=Strict` Cookie + 表单字段 + Origin / Sec-Fetch-Site 校验）；交互 10 分钟过期；重复提交不会再签发；每次新的授权请求都必须重新同意，不自动复用旧授权；`frame-ancestors 'none'`、无脚本、`no-referrer`
- **限流**：`/oauth/authorize|token|revoke` 每 IP 每分钟 `MCP_OAUTH_RATE_LIMIT_PER_MIN` 次；登录失败 10 次锁 10 分钟（客户端 IP 优先取反向代理写入的 `X-Real-IP`）
- **审计**：`mcp_oauth.grant` / `deny` / `revoke` / `replay`
- **HTTPS**：启用后，issuer / resource / client_id / 回调地址除本机外必须是 HTTPS，否则启动失败

## 5. 文件清单

新增：

- `server/src/oauth/provider.ts`：oidc-provider 配置、redirect_uri 白名单与 PKCE 前置校验、元数据整理
- `server/src/oauth/adapter.ts`：PostgreSQL 存储（摘要主键、原子消费、按授权撤销、过期清理）
- `server/src/oauth/routes.ts`：well-known、OAuth 端点转发、登录 / 同意 / 拒绝 / 切换账号、限流、CSRF
- `server/src/oauth/pages.ts`：登录、同意、错误页 HTML
- `server/src/oauth/resource.ts`：PRM、401 / 403 challenge、access token 校验 → 身份上下文
- `server/src/oauth/scopes.ts`：scope 定义、工具 → 权限映射
- `server/src/api/mcp-oauth-admin.ts`：网页端授权列表 / 撤销接口
- `server/src/app.ts`：从 `index.ts` 抽出的 `createApp()`（测试直接起服务）
- `server/drizzle/0017_mcp_oauth.sql`、`server/drizzle/meta/0017_snapshot.json`
- `server/src/oauth/settings.ts`：网页设置的校验、保存、加载，读取客户端元数据文档
- `server/test/helpers.ts`、`server/test/oauth.test.ts`（42 个用例）、`server/test/oauth-proxy.test.ts`（经代理抓取 CIMD，5 个）、`server/test/oauth-settings.test.ts`（网页设置，8 个）
- `web/src/pages/settings/McpOAuthPages.tsx`（「开放接口」下的 OAuth 设置、OAuth 授权两个页面）
- `docs/mcp-oauth.md`（本文）

修改：`server/src/config.ts`、`server/src/db/schema.ts`、`server/src/auth/index.ts`、`server/src/mcp/server.ts`、`server/src/services/drafts.ts`、`server/src/services/actions.ts`（`ActionError` 加 429）、`server/src/index.ts`、`server/package.json`、`server/tsconfig.json`、`server/drizzle/meta/_journal.json`、根 `package.json`（`pnpm test`）、`pnpm-lock.yaml`、`web/src/api.ts`、`web/src/pages/settings/ApiKeysPage.tsx`、`web/src/App.tsx`、`web/src/components/AppLayout.tsx`（原「API 与 MCP」拆成「开放接口」下的接入方式、API Key、OAuth 设置、OAuth 授权四个菜单）、`.env.example`、`README.md`。

## 6. 部署与 ChatGPT 配置步骤

### 6.1 迁移

迁移 `0017_mcp_oauth` **纯新增**（两张新表 + `drafts.created_by_oauth_id` 可空列），不改已有数据。注意：**DaMail 启动时会自动执行迁移**，部署新版本即会在生产库执行。部署前请先备份数据库。

### 6.2 回滚

1. 设 `MCP_OAUTH_ENABLED=false` 并重启即可停用，所有 `/oauth/*` 返回 404、`/mcp` 不再接受 OAuth 令牌，API Key 不受影响（推荐，不需要动数据库）
2. 需要回退代码时，旧版本代码可以直接运行在已迁移的库上（新表和新列被忽略）
3. 确需删除表结构（会使所有已签发的 OAuth 授权失效，OAuth 创建的草稿保留但失去归属）：

```sql
BEGIN;
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_created_by_oauth_id_mcp_authorizations_id_fk;
ALTER TABLE drafts DROP COLUMN IF EXISTS created_by_oauth_id;
DROP TABLE IF EXISTS oauth_payloads;
DROP TABLE IF EXISTS mcp_authorizations;
-- 让 drizzle 以后能重新执行 0017：删除迁移记录（created_at 即 _journal.json 里 0017 的 when）
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794054930408;
COMMIT;
```

### 6.3 设置放在哪里

常改的设置在网页「开放接口 → OAuth 设置」里，**保存后立即生效，不需要重启**：

| 网页设置 | 说明 |
| --- | --- |
| 启用 | 关闭后 `/oauth/*` 和元数据 404，已签发的令牌立即不能用；授权记录保留，重新开启后恢复 |
| 允许的客户端 | 元数据文档（CIMD，如 ChatGPT）或预注册客户端；**每个客户端各自绑定回调地址**，A 不能使用 B 的回调。添加 CIMD 客户端时服务器读取它的文档（可经代理），列出名称和声明的回调地址，按客户端页面上显示的勾选 |
| 代理选择 | 读取客户端文档和公钥走哪个代理（「代理设置」里的代理） |
| 直接发信上限 | 每个授权每小时最多直接发出几封，0 = 禁止 |
| 权限不足时 | HTTP 403（默认）或工具返回错误 |

这些设置存在 `settings` 表（key `mcp_oauth`），修改记审计日志 `mcp_oauth.settings`。网页上**从没保存过时沿用环境变量**（`MCP_OAUTH_ENABLED` / `CIMD_CLIENTS` / `REDIRECT_URIS` / `STATIC_CLIENTS` / `FETCH_PROXY_ID` / `SEND_LIMIT_PER_HOUR` / `SCOPE_CHALLENGE`），页面顶部会提示；保存一次后以网页为准，这些环境变量可以删掉。存的设置失效时（例如所选代理被删、`PUBLIC_URL` 改成了 http），启动时自动停用 OAuth 并在日志里说明，到网页上修正后保存即可。

仍由环境变量决定（基本不用改）：`PUBLIC_URL`（决定 issuer 和 MCP 地址）、`MCP_OAUTH_ISSUER` / `MCP_OAUTH_RESOURCE`、各有效期、`MCP_OAUTH_RATE_LIMIT_PER_MIN`、`MCP_OAUTH_FETCH_TIMEOUT_MS`。

反向代理整站转发（例如 Nginx / OpenResty 的 `location /`）时已经覆盖 `/oauth/*` 和 `/.well-known/*`，不需要单独配置。

### 6.4 在 ChatGPT 中添加

1. ChatGPT → 插件 → 添加 → 添加自定义 MCP 服务器，服务器 URL 填 `https://你的域名/mcp`，身份验证选 OAuth
2. 展开「高级 OAuth 设置」，记下「CIMD 客户端元数据 URL」和「回调 URL」（DaMail 支持 RFC 9207 时，ChatGPT 使用全局的 `https://chatgpt.com/oauth/client.json` 和 `https://chatgpt.com/connector_platform_oauth_redirect`；**以页面上显示的为准**）
3. DaMail「开放接口 → OAuth 设置」→ 添加客户端，填上面的元数据 URL → 读取 → 勾选与 ChatGPT 页面一致的回调地址 → 添加；服务器访问不了 chatgpt.com 时先在「代理选择」里选代理；打开启用，保存
4. 回到 ChatGPT：如果注册方法显示「CIMD（不可用）」，把高级设置收起再展开让它重新发现。**关闭「开启 OIDC」**（DaMail 不签发 ID Token，开着会让 ChatGPT 请求全部作用域），默认请求的权限范围保留 `mail:read`
5. 勾选风险确认 → 创建 → 在 DaMail 登录 / 同意页确认权限与邮箱范围 → 允许
6. 在 DaMail「已授权的应用」里确认出现该授权；先用只读工具测试，再按需授予草稿权限
7. ChatGPT 用 `private_key_jwt` 认证，DaMail 会抓取它的 `jwks_uri`（与 client_id 同源，同样走所选代理）；失败时看服务端日志 `[oauth]`

### 6.5 curl 自检（把域名替换为你的）

```bash
curl -i https://mail.example.com/mcp -X POST -H 'content-type: application/json' -d '{}'
# 期望：401，WWW-Authenticate: Bearer resource_metadata="https://mail.example.com/.well-known/oauth-protected-resource/mcp", scope="mail:read"
```

```bash
curl -s https://mail.example.com/.well-known/oauth-protected-resource/mcp
```

```bash
curl -s https://mail.example.com/.well-known/oauth-authorization-server
```

```bash
curl -i https://mail.example.com/mcp -X POST -H 'authorization: Bearer invalid' -H 'content-type: application/json' -d '{}'
# 期望：401 error="invalid_token"，不会因为浏览器有登录 Cookie 而通过
```

## 7. 测试

```bash
pnpm test
```

测试使用本地 `damail_test` 库（每次重建并执行全部迁移；库名不是 `*_test` 时拒绝运行），随机端口起完整服务；CIMD 文档抓取用注入的 mock，不访问外网、不连接邮箱、不发信（发送只验证入队和限额）。

### 已测试（自动化，55 个用例全部通过）

- 网页设置：没保存过时显示环境变量配置；只有网页登录态能修改；不合法的设置（http / 通配符 / 带 # / 无回调 / 重复 / 代理不存在 / 负数上限）被拒绝；保存后立即生效（旧客户端失效、新客户端可授权、发信上限更新）；回调按客户端绑定；关闭开关后端点 404、已签发令牌不可用，重新开启恢复；启动时加载、存的设置失效时停用；读取客户端文档拒绝内网和非 HTTPS
- 经代理抓取失败时只读请求重试一次

- 经代理抓取 CIMD：只访问白名单源、经所选代理、替换超时、不跟随重定向；其他源 / http / 内网地址不请求；代理不存在时报错不直连；经代理完成完整授权和换 token（底层请求为 mock，真实代理只在生产联调中验证）

- discovery：PRM 路径插入与根路径、AS 元数据字段、未认证 401 头、不跳转登录页
- 主流程：登录 → 同意 → 回调带 code / 原样 state / iss → PKCE 换 token → 调用 MCP
- 授权请求：未注册 client、回调不在白名单（不跳转）、PKCE plain / 缺失、resource 缺失或错误、无 DaMail 权限、未知 scope、用户拒绝、登录 ≠ 同意、CSRF（缺 token、Origin 不符、`Origin: null` 无 same-origin）、重复提交、取消勾选 send
- 换 token：错误 / 缺失 verifier、错误 redirect_uri、错误 resource、错误 client、缺 resource 时 audience 仍绑定、授权码重复兑换与并发兑换、过期授权码
- refresh：轮换、旧 token 重放撤销整个授权、不能扩权或换 resource、其他 client 不能用
- 撤销：网页撤销后 access / refresh 失效、`/oauth/revoke`、过期 access token、数据库无令牌明文
- 权限与归属：只读不能写草稿（403 insufficient_scope）、tool 模式、securitySchemes、草稿权限不能发信、不能处理网页 / API Key / 其他授权 / 其他用户的草稿、发送限额与待审批草稿、邮箱范围外的邮件和草稿
- 兼容：每个 MCP 工具都配置了权限、OAuth 令牌不能访问 `/api/v1`、无效 Bearer 不回退会话、API Key 与网页会话回归、邮件服务商 OAuth 路由不受影响
- CIMD：非白名单 URL 不抓取；文档不存在、client_id 不一致、共享密钥认证、回调不在名单内被拒；合法文档可授权且回调精确匹配

### 已手工验证（本地浏览器面板，测试库）

- 登录页、同意页渲染（当前账号、切换账号、三个权限及 send 警示、邮箱范围），真实浏览器提交成功（修复了 `no-referrer` 导致浏览器发送 `Origin: null` 被 CSRF 拦截的问题）
- 取消 send、只选工作邮箱 → 回调 `?code=…&state=preview-1&iss=http%3A%2F%2Flocalhost%3A18787`
- 网页「开放接口 → OAuth 授权」列表显示该授权（读取邮件 + 写草稿、<work@local.test>），撤销后显示“已撤销”
- `pnpm -r typecheck`、`pnpm --filter web build` 通过

### 未测试

- **与真实 ChatGPT 的连接**（CIMD 文档实际内容、`private_key_jwt` 客户端认证、ChatGPT 对 HTTP 403 与工具层 challenge 的实际处理、逐步授权体验）
- 生产环境 HTTPS 反向代理下的完整流程
- 生产库迁移
- 多实例部署

## 8. 依赖选择

- **oidc-provider 9.13.3**（MIT，作者 panva，OpenID Foundation 认证）：内置 CIMD（实验特性，`ack: 'draft-02'`）、RFC 9207、RFC 8707、PKCE、refresh 轮换、private_key_jwt、撤销。只新增这一个运行时依赖（及其类型 `@types/oidc-provider`），不引入外部服务、没有费用、不迁移账号体系
- 未选：`@modelcontextprotocol/sdk` 自带的 `mcpAuthRouter`（面向 DCR、无 CIMD / RFC 9207，且需自己实现令牌存储与撤销）；托管 IdP（Auth0 / Keycloak 等，需要外部服务或额外部署，并要把 DaMail 账号迁过去）
- 依据：MCP 授权规范 2026-07-28 版；`@modelcontextprotocol/sdk` 1.32.2（协议版本 2025-11-25）

## 9. 已知限制

- **单租户**：DaMail 的邮箱、邮件、草稿没有 `user_id`，所有网页用户本来就能看到全部邮箱。OAuth 授权绑定用户和选定的邮箱范围，草稿按授权隔离，但不同 DaMail 用户之间**没有**数据隔离；要做到需要先迁移账户体系（本期按你的选择不做）
- 限流计数、同意页“处理中”标记在内存里，只适用于单实例
- 换 token 时省略 `resource` 被接受（oidc-provider 行为），但令牌 audience 仍绑定授权时的资源；带了错误的 `resource` 会被拒绝
- CIMD 文档被缓存（最少 60 秒），ChatGPT 更新文档或你修改白名单后最多 1 小时才生效（重启服务立即生效）
- 不确定 ChatGPT 更适配 HTTP 403 还是工具层 challenge，可用 `MCP_OAUTH_SCOPE_CHALLENGE` 切换
- 原有网页登录（`server/src/api/auth.ts`）的限流仍取 `X-Forwarded-For` 首项，本次未改动
- access token 是 opaque 的，每次 MCP 请求查一次库（单用户场景下开销可以忽略）
