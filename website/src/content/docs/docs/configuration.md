---
title: 配置
description: 环境变量说明
---

DaMail 的大部分设置都在网页上完成（邮箱、模型、规则、通知渠道、OAuth 设置等），环境变量只负责启动所需的基础配置。

使用仓库里的 `docker-compose.yml` 时，在同目录的 `.env` 里填写下面的变量。

## 基础

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MASTER_KEY` | — | **必填**。32 字节密钥（`openssl rand -hex 32`），加密邮箱凭证、签发会话。务必备份 |
| `POSTGRES_PASSWORD` | `damail` | Compose 里 PostgreSQL 的密码 |
| `PUBLIC_URL` | `http://localhost:8787` | 对外访问地址，用于 OAuth 回调、MCP 地址等 |
| `COOKIE_SECURE` | `false` | 通过 HTTPS 访问时设为 `true` |
| `BIND` | `127.0.0.1` | Compose 映射端口时监听的地址 |
| `DAMAIL_VERSION` | `latest` | 使用的镜像版本，例如 `v0.2.0` |
| `DATABASE_URL` | — | 不用 Compose 自带的数据库时，指向自己的 PostgreSQL（需要 `pg_trgm` 扩展） |

## 同步与发信

| 变量 | 默认值 | 说明 |
|---|---|---|
| `POLL_INTERVAL_SEC` | `300` | 默认轮询间隔（秒），每个邮箱可以单独设置；收件箱走 IDLE 实时推送，按此间隔兜底 |
| `MAX_MESSAGE_MB` | `30` | 单封邮件超过该大小只同步前 2MB |
| `SEND_DELAY_SEC` | `10` | 点击发送后延迟多少秒才真正发出，期间可撤销 |
| `MAX_ATTACHMENT_MB` | `25` | 写信时附件总大小上限 |
| `ALLOW_PRIVATE_WEBHOOKS` | `false` | 允许通知渠道推送到内网地址（如自建 n8n） |

## 检查新版本

| 变量 | 默认值 | 说明 |
|---|---|---|
| `UPDATE_CHECK` | `true` | 每 6 小时读一次 GitHub 上最新的正式版本，网页上提示「有新版本」。内网部署设为 `false` |
| `UPDATE_REPO` | `gopkg-dev/damail` | 读哪个仓库的 Release（自己 fork 时修改） |
| `UPDATE_CHECK_PROXY_ID` | — | 服务器直连不了 `api.github.com` 时，经「设置 → 代理设置」里的哪个代理（填代理 id），见[代理设置](/docs/proxies/) |

## MCP OAuth

ChatGPT 等客户端的 OAuth 接入推荐在网页「设置 → OAuth 设置」里配置，保存即生效；网页上保存过之后，对应的环境变量不再生效。只能用环境变量设置的项目：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MCP_OAUTH_ISSUER` | `PUBLIC_URL` | 授权服务器地址，非本机必须 HTTPS |
| `MCP_OAUTH_RESOURCE` | `PUBLIC_URL/mcp` | MCP 资源地址（令牌的 audience） |
| `MCP_OAUTH_ACCESS_TOKEN_TTL_SEC` | `900` | access token 有效期 |
| `MCP_OAUTH_REFRESH_TOKEN_TTL_SEC` | `2592000` | refresh token 有效期（30 天） |
| `MCP_OAUTH_RATE_LIMIT_PER_MIN` | `60` | OAuth 端点每个 IP 每分钟请求上限 |

完整列表见仓库里的 [.env.example](https://github.com/gopkg-dev/damail/blob/main/.env.example)。
