---
title: AI assistants
description: Connect DaMail to proactive AI assistants such as Claude Duet, ChatGPT dots, Grok Bot and Meta Muse so they can manage your mail
---

Proactive AI assistants such as Claude Duet, ChatGPT dots, Grok Bot and Meta Muse keep working in the background. They send you a morning brief, flag mail that needs you and draft replies for you to approve. All of them can add a remote MCP server as a custom connector, so once DaMail is connected they can work across every mailbox you have.

To these assistants, DaMail is a standard MCP server:

| Setting | Value |
|---|---|
| Server URL | `https://mail.example.com/mcp` |
| Authentication | OAuth (sign in to DaMail and approve on the consent page) |
| Permissions | `mail:read`, `mail:organize`, `mail:draft`, `mail:send` |

:::tip[What they can do once connected]
- Summarize new mail every morning: what matters, what needs a reply, which codes and bills arrived
- Find mail waiting for your reply and draft answers into **Awaiting approval**, to send only after you confirm
- Organize mail on request: mark as read, star, archive, set follow-up reminders
- Search across all mailboxes, such as "every invoice from last month" or "my thread with Alex about the contract"
:::

## Prepare DaMail

Every assistant needs these three steps first:

1. Serve DaMail over HTTPS, with `PUBLIC_URL` starting with `https://`. These assistants run in the cloud, so your DaMail must be reachable from the internet
2. Turn it on under **Settings → OAuth settings**
3. Add the assistant as an allowed client, using whatever its connector page offers:
   - **Metadata document (CIMD):** if the page shows a client metadata URL, paste it, click Fetch and tick the matching callback URL
   - **Pre-registered client:** if the page asks for an OAuth client ID, make one up in DaMail (for example `claude-duet`), enter the callback URL the assistant shows, and paste the same client ID back into the assistant

Full details and self-check commands are in [ChatGPT and OAuth](/docs/oauth/).

## Where to run the server

There are two directions of traffic between an assistant and DaMail, with different requirements:

| Direction | What happens | Requirement |
|---|---|---|
| Assistant → DaMail | The assistant's cloud calls `https://your-domain/mcp` and opens DaMail's sign-in and consent pages | DaMail needs a public HTTPS address. **A proxy can't help here** |
| DaMail → outside | Fetching client metadata (such as `chatgpt.com`), syncing Gmail and other mailboxes, checking for updates | If the server can't reach them directly, use a proxy from **Settings → Proxies** |

So the server can live anywhere:

- **Overseas or Hong Kong server:** the simplest option. Both directions work directly, with no proxy
- **Server in mainland China:** add a [proxy](/docs/proxies/) under **Settings → Proxies** for outbound traffic and select it in **OAuth settings** and in mailbox settings. Serving a website on ports 80/443 requires an ICP filing for the domain
- **Machine at home or in an office network:** use a tunnel such as Cloudflare Tunnel to get a public HTTPS address, and set it as `PUBLIC_URL`

## Claude Duet

Claude Duet uses the connectors in your Claude account. Add DaMail to Claude once and Duet can use it.

1. Open claude.ai → Settings → Connectors → Add custom connector
2. Name it `DaMail` and enter `https://mail.example.com/mcp`
3. Expand **Advanced settings** and add the client in DaMail as described above. Claude's callback URL is usually `https://claude.ai/api/mcp/auth_callback`; use what the page shows
4. Click Connect, sign in to DaMail, choose permissions and mailboxes on the consent page, and allow
5. Then just ask Duet something like "every morning, tell me which emails need a reply"

## ChatGPT dots

dots runs inside ChatGPT and uses the apps you've connected there.

1. Add DaMail to ChatGPT and authorize it as described in [ChatGPT and OAuth](/docs/oauth/)
2. Open dots and ask it to use DaMail, for example "let me know when something important arrives and draft a reply"

## Grok Bot

1. Open grok.com → Connectors → add a custom connector
2. Enter `https://mail.example.com/mcp` and choose OAuth
3. Add the client in DaMail with the callback URL Grok shows
4. Connect, sign in to DaMail and authorize. Grok Bot can then handle your mail, including on a schedule with Routines

## Meta Muse

1. Open Muse → Settings → Connectors → Add custom connector
2. Paste `https://mail.example.com/mcp`
3. Add the client in DaMail with the callback URL Muse shows
4. Muse opens the DaMail sign-in page. Sign in, allow access, and you're done

## Other assistants

Any client that supports remote MCP with OAuth can connect the same way. Clients that let you set request headers, such as Claude Code, Cursor and Claude Desktop, can also use an API key; see [MCP](/docs/mcp/).

## Staying safe

- **Start read-only.** Grant only `mail:read` at first, and add `mail:draft` once you trust how the assistant behaves
- **Approve before sending.** Without `mail:send`, mail an assistant writes only goes to **Drafts → Awaiting approval** until you confirm it. Even with `send`, direct sending is capped per hour
- **Limit mailboxes.** Tick only the mailboxes you want to share on the consent page. The assistant can't see anything else
- **Revoke any time.** **Settings → OAuth grants** lists each assistant's grant and when it was last used. Revoking takes effect immediately
- **Everything is logged.** Each call an assistant makes is recorded under **Audit**

Assistants connected through OAuth can't change inbox rules or notification channels, and can't unsubscribe from mail. Those stay in the DaMail web app.
