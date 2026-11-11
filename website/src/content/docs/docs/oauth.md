---
title: ChatGPT 与 OAuth
description: 通过 OAuth 登录授权，把 DaMail 接入 ChatGPT 等 MCP 客户端
---

ChatGPT 的自定义 MCP 连接器不支持填写 API Key，需要标准的 OAuth 授权。DaMail 自带授权服务器：客户端添加 `https://你的域名/mcp` 后会打开 DaMail 的登录与同意页，由你选择权限和可访问的邮箱。

Claude Duet、ChatGPT dots、Grok Bot、Meta Muse 等 AI 助手也通过这套授权接入，各自的步骤见[接入 AI 助手](/docs/assistants/)。

:::note
这和「接入邮箱」里的 Gmail / Microsoft OAuth 是两条独立的链路：那条是 DaMail 去登录你的邮箱，这条是 ChatGPT 来登录 DaMail。
:::

## 前提

- DaMail 通过 HTTPS 对外访问（`PUBLIC_URL` 是 `https://` 开头）
- 服务器能访问客户端的元数据地址（ChatGPT 是 `chatgpt.com`）；访问不了时在「设置 → 代理设置」准备一个[代理](/docs/proxies/)

## 在 ChatGPT 中添加

1. ChatGPT → 设置 → 连接器 → 添加自定义 MCP 服务器，服务器 URL 填 `https://mail.example.com/mcp`，身份验证选 OAuth
2. 展开「高级 OAuth 设置」，记下「客户端元数据 URL」和「回调 URL」，**以页面上显示的为准**
3. 在 DaMail「设置 → OAuth 设置」：
   - 添加客户端，填上面的元数据 URL，点读取
   - 勾选和 ChatGPT 页面一致的回调地址
   - 服务器访问不了 chatgpt.com 时，在「代理选择」里选代理
   - 打开启用，保存（立即生效）
4. 回到 ChatGPT：**关闭「开启 OIDC」**（DaMail 不签发 ID Token），默认请求的权限保留 `mail:read`
5. 创建后会跳到 DaMail：登录，在同意页确认权限和邮箱范围，点允许
6. 在 DaMail「设置 → OAuth 授权」里能看到这条授权，可以随时撤销

建议先用只读权限试用，需要时再授予草稿权限。

## 权限

| 权限 | 能做什么 |
|---|---|
| `mail:read` | 读邮件、会话、附件、草稿、统计、日报、通讯录 |
| `mail:organize` | 标记、移动、跟进提醒 |
| `mail:draft` | 写草稿、提交网页审批、撤销 |
| `mail:send` | 不经网页审批直接发送本授权创建的草稿（需要单独勾选） |

- 客户端默认只请求 `mail:read`，用到其他权限时会提示重新授权
- 每个授权绑定一个用户和同意页选定的邮箱，范围外的邮件、草稿、附件都访问不到
- OAuth 只能处理本授权创建的草稿；直接发送每小时最多 `MCP_OAUTH_SEND_LIMIT_PER_HOUR` 封（默认 10，设为 0 禁止）
- 收信规则、通知渠道、退订、忽略名单**不对 OAuth 开放**
- access token 15 分钟有效，refresh token 30 天、每次刷新轮换；撤销后立即失效

## 自检

```bash
curl -i https://mail.example.com/mcp -X POST -H 'content-type: application/json' -d '{}'
# 期望：401，WWW-Authenticate 里带 resource_metadata
```

```bash
curl -s https://mail.example.com/.well-known/oauth-protected-resource/mcp
curl -s https://mail.example.com/.well-known/oauth-authorization-server
```

## 已知限制

- DaMail 目前是单租户：所有网页用户都能看到全部邮箱。OAuth 授权按用户和邮箱范围隔离，但不同 DaMail 用户之间没有数据隔离
- 限流计数在内存里，只适用于单实例部署
- 客户端元数据文档会被缓存，修改后最多 1 小时生效（重启服务立即生效）
