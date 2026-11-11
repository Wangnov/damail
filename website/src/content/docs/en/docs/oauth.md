---
title: ChatGPT and OAuth
description: Connect ChatGPT and other MCP clients to DaMail with OAuth sign-in
---

ChatGPT’s custom MCP connectors cannot take an API key and need standard OAuth. DaMail has its own authorization server: after a client adds `https://your-domain/mcp`, it opens DaMail’s sign-in and consent page, where you choose permissions and mailboxes.

AI assistants such as Claude Duet, ChatGPT dots, Grok Bot and Meta Muse connect through the same flow. See [AI assistants](/en/docs/assistants/) for each one.

:::note
This is separate from the Gmail / Microsoft OAuth used to add mailboxes: that one is DaMail signing in to your mail provider, this one is ChatGPT signing in to DaMail.
:::

## Requirements

- DaMail is served over HTTPS (`PUBLIC_URL` starts with `https://`)
- The server can reach the client’s metadata URL (`chatgpt.com` for ChatGPT); otherwise prepare a [proxy](/en/docs/proxies/) under **Settings → Proxies**

## Add DaMail to ChatGPT

1. In ChatGPT, open Settings → Connectors → add a custom MCP server, enter `https://mail.example.com/mcp` and choose OAuth
2. Expand **Advanced OAuth settings** and note the client metadata URL and callback URL — **use what the page shows**
3. In DaMail under **Settings → OAuth settings**:
   - add a client with that metadata URL and click Fetch
   - tick the callback URL that matches ChatGPT
   - pick a proxy if the server cannot reach chatgpt.com
   - turn it on and save (takes effect immediately)
4. Back in ChatGPT, **turn off OIDC** (DaMail does not issue ID tokens) and keep the default scope `mail:read`
5. After creating it you are sent to DaMail: sign in, review permissions and mailboxes on the consent page, and allow
6. The grant appears under **Settings → OAuth grants**, where you can revoke it at any time

Start with read-only access and grant drafting later if you need it.

## Permissions

| Scope | Allows |
|---|---|
| `mail:read` | Read mail, threads, attachments, drafts, stats, reports and contacts |
| `mail:organize` | Mark, move and follow-up reminders |
| `mail:draft` | Write drafts, submit for approval in the web app, cancel |
| `mail:send` | Send drafts created by this grant without approval (must be ticked separately) |

- Clients request only `mail:read` by default and are prompted to re-authorize when they need more
- Each grant is bound to one user and the mailboxes chosen on the consent page; mail, drafts and attachments outside that scope are unreachable
- OAuth can only handle drafts created by its own grant; direct sending is capped at `MCP_OAUTH_SEND_LIMIT_PER_HOUR` per hour (default 10, 0 disables it)
- Inbox rules, notification channels, unsubscribe and the ignore list are **not available over OAuth**
- Access tokens last 15 minutes; refresh tokens last 30 days and rotate on every use; revoking takes effect immediately

## Self-check

```bash
curl -i https://mail.example.com/mcp -X POST -H 'content-type: application/json' -d '{}'
# Expect 401 with resource_metadata in WWW-Authenticate
```

```bash
curl -s https://mail.example.com/.well-known/oauth-protected-resource/mcp
curl -s https://mail.example.com/.well-known/oauth-authorization-server
```

## Known limitations

- DaMail is single-tenant today: every web user can see every mailbox. OAuth grants are scoped per user and mailbox, but there is no data isolation between DaMail users
- Rate-limit counters live in memory, so this assumes a single instance
- Client metadata documents are cached; changes can take up to an hour (restart to apply immediately)
