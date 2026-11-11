---
title: Development
description: Set up a dev environment, project layout and tests
---

## Setup

You need Node 22+, pnpm and Docker.

```bash
git clone https://github.com/gopkg-dev/damail.git && cd damail
cp .env.example .env
docker compose -f docker-compose.dev.yml -p damail-dev up -d   # PostgreSQL + GreenMail test mail server
pnpm install
pnpm dev                                                         # server :8787, web :5180
```

Open http://localhost:5180 and create the admin account on first visit.

## Try it with test mailboxes

GreenMail comes with `alice` / `alice-pass` and `bob` / `bob-pass`. Add a mailbox with provider “Other IMAP”, server `127.0.0.1`, port `3143`, SSL off. Deliver a batch of sample mail:

```bash
pnpm --filter server exec tsx scripts/seed-greenmail.ts alice@local.test
```

## Checks

```bash
pnpm typecheck   # server and web type checks
pnpm test        # server integration tests against a separate damail_test database
```

Tests only touch the local database — no real mailboxes, no internet, no sending.

## Project layout

```txt
server/                 Hono + Drizzle + imapflow
  src/sync/             Sync engine: IDLE, incremental sync, flags, deletion detection, provider presets
  src/services/         Ingest and threading, queries, write-back, drafts and approval, sending,
                        job queue, AI analysis, rules, notifications, reports
  src/api/              Web admin and REST API
  src/mcp/              MCP server (stateless Streamable HTTP)
  src/oauth/            MCP OAuth authorization server
  drizzle/              Database migrations
  test/                 Integration tests
web/                    React + Ant Design + TanStack Query
website/                Website and docs (Astro + Starlight)
```

## Website

The website is a separate pnpm workspace:

```bash
cd website
pnpm install
pnpm dev        # http://localhost:4321/
```

The home page lives in `website/src/pages` and the docs in `website/src/content/docs` (Chinese at the root, English under `en/`). Pushing to `main` deploys it to GitHub Pages through GitHub Actions.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, for example `feat(mail): add unread filter to thread list` or `fix(sync): reconnect after IDLE timeout`.
