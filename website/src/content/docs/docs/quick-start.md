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

## One-line install

```bash
curl -fsSL https://damail.app/install.sh | sh
```

The script first asks which language to use for its messages (简体中文 or English). It then creates `damail/` in the current directory, downloads `docker-compose.yml`, writes a `.env` with a random `MASTER_KEY` and database password, then pulls the images, starts DaMail and waits until it is ready. Then open `http://localhost:8787` and create the admin account.

If you already have a domain, pass the public URL along:

```bash
curl -fsSL https://damail.app/install.sh | DAMAIL_PUBLIC_URL=https://mail.example.com sh
```

| Variable | Default | Notes |
|---|---|---|
| `DAMAIL_PUBLIC_URL` | `http://localhost:8787` | Public URL. If it starts with `https://`, `COOKIE_SECURE=true` is set for you |
| `DAMAIL_DIR` | `damail` | Install directory |
| `DAMAIL_PORT` | `8787` | Host port |
| `DAMAIL_BIND` | `127.0.0.1` | Listen address. Use `0.0.0.0` to serve directly without a reverse proxy |
| `DAMAIL_VERSION` | `latest` | Image version, such as `v0.1.0` |
| `DAMAIL_LANG` | asked | `zh` or `en` to skip the language prompt, for unattended installs |

- To read the script first: `curl -fsSLO https://damail.app/install.sh`, then `sh install.sh`
- An existing `.env` is never changed, so **running it again upgrades**
- If your user can't access Docker, use `sudo sh` instead of `sh`

**Back up `damail/.env`** once it's installed, then set up the reverse proxy in step 3 below. To install by hand instead, follow steps 1 and 2.

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
2. Add mailboxes under **Settings → Accounts** — see [Mailboxes](/docs/mailboxes/)
3. For AI features, add a model under **AI → Models** — see [Models](/docs/ai/models/)
4. For agents, create a key under **Settings → API keys** — see [MCP](/docs/mcp/)

## Backups

Back up the PostgreSQL volume (`db-data`), the DaMail data volume (`app-data`, raw messages and attachments) and your `.env`.
