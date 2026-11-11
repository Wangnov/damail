---
title: Quick start
description: Deploy DaMail with Docker Compose
---

## Requirements

- A server that stays on, with Docker and Docker Compose
- A domain and an HTTPS reverse proxy (Caddy, Nginx, …) — you can skip this to try it locally

:::tip[Where to host it]
Pick a region that can reach all your providers. Servers in mainland China cannot reach Gmail, while overseas servers may trigger login risk checks at QQ and 163. Hong Kong, Singapore or Japan work well for a mix of both.
:::

## 1. Download the config

```bash
mkdir damail && cd damail
curl -O https://raw.githubusercontent.com/gopkg-dev/damail/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/gopkg-dev/damail/main/.env.example
```

Edit `.env` and set at least:

```ini
# generate with: openssl rand -hex 32
MASTER_KEY=
POSTGRES_PASSWORD=use-a-strong-password
PUBLIC_URL=https://mail.example.com
# true when served over HTTPS
COOKIE_SECURE=true
```

:::caution[Back up MASTER_KEY]
Mailbox passwords are encrypted with it. If you lose it, stored passwords cannot be decrypted and every mailbox has to be re-entered.
:::

## 2. Start

```bash
docker compose pull && docker compose up -d
```

The image is `ghcr.io/gopkg-dev/damail` (linux/amd64, linux/arm64). Database migrations run on startup. By default it only listens on `127.0.0.1:8787`.

## 3. Reverse proxy

Proxy your domain to `http://127.0.0.1:8787` with HTTPS. **Turn off response buffering**, or live updates and MCP will stall.

Caddy:

```txt
mail.example.com {
  reverse_proxy 127.0.0.1:8787 {
    flush_interval -1
  }
}
```

Nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;
  proxy_read_timeout 1h;
}
```

## 4. Start using it

1. Open `https://mail.example.com` and create the admin account on first visit
2. Add mailboxes under **Settings → Accounts** — see [Mailboxes](/en/docs/mailboxes/)
3. For AI features, add a model under **AI → Models** — see [Models](/en/docs/ai/models/)
4. For agents, create a key under **Settings → API keys** — see [MCP](/en/docs/mcp/)

## Backups

Back up the PostgreSQL volume (`db-data`), the DaMail data volume (`app-data`, raw messages and attachments) and your `.env`.
