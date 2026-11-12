---
title: Configuration
description: Environment variables
---

Most settings live in the web app (mailboxes, models, rules, notification channels, OAuth). Environment variables only cover what the server needs to start.

With the repository's `docker-compose.yml`, put these in the `.env` file next to it.

## Basics

| Variable | Default | Description |
|---|---|---|
| `MASTER_KEY` | — | **Required.** 32-byte key (`openssl rand -hex 32`) that encrypts mailbox credentials and signs sessions. Back it up |
| `POSTGRES_PASSWORD` | `damail` | Password for the bundled PostgreSQL |
| `PUBLIC_URL` | `http://localhost:8787` | Public URL, used for OAuth callbacks and the MCP address |
| `COOKIE_SECURE` | `false` | Set to `true` when served over HTTPS |
| `DAMAIL_BIND` | `127.0.0.1` | Address Compose binds the port to. Set `0.0.0.0` to serve directly without a reverse proxy |
| `DAMAIL_PORT` | `8787` | Host port Compose maps to |
| `DAMAIL_VERSION` | `latest` | Image version, e.g. `v0.2.0` |
| `DATABASE_URL` | — | Your own PostgreSQL instead of the bundled one (needs the `pg_trgm` extension) |

## Sync and sending

| Variable | Default | Description |
|---|---|---|
| `POLL_INTERVAL_SEC` | `300` | Default polling interval in seconds, adjustable per mailbox. Inboxes use IDLE and poll as a fallback |
| `MAX_MESSAGE_MB` | `30` | Messages larger than this only sync their first 2 MB |
| `SEND_DELAY_SEC` | `10` | Delay after clicking send, during which you can undo |
| `MAX_ATTACHMENT_MB` | `25` | Total attachment size limit when composing |
| `ALLOW_PRIVATE_WEBHOOKS` | `false` | Allow notification channels to post to private network addresses (e.g. a self-hosted n8n) |

## Update check

| Variable | Default | Description |
|---|---|---|
| `UPDATE_CHECK` | `true` | Checks GitHub for the latest stable release every 6 hours and shows “Update available” in the app. Set to `false` for offline deployments |
| `UPDATE_REPO` | `gopkg-dev/damail` | Repository to read releases from (change it for a fork) |
| `UPDATE_CHECK_PROXY_ID` | — | Proxy id from **Settings → Proxies** when the server cannot reach `api.github.com` directly; see [Proxies](/en/docs/proxies/) |

## MCP OAuth

OAuth for ChatGPT and similar clients is best configured under **Settings → OAuth settings**, which takes effect on save; once saved there, the matching environment variables are ignored. These can only be set through the environment:

| Variable | Default | Description |
|---|---|---|
| `MCP_OAUTH_ISSUER` | `PUBLIC_URL` | Authorization server URL; must be HTTPS outside localhost |
| `MCP_OAUTH_RESOURCE` | `PUBLIC_URL/mcp` | MCP resource URL (the token audience) |
| `MCP_OAUTH_ACCESS_TOKEN_TTL_SEC` | `900` | Access token lifetime |
| `MCP_OAUTH_REFRESH_TOKEN_TTL_SEC` | `2592000` | Refresh token lifetime (30 days) |
| `MCP_OAUTH_RATE_LIMIT_PER_MIN` | `60` | Requests per IP per minute to the OAuth endpoints |

See [.env.example](https://github.com/gopkg-dev/damail/blob/main/.env.example) in the repository for the full list.
