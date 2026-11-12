---
title: Proxies
description: Route DaMail's outbound connections through an HTTP or SOCKS proxy when the server can't reach a mail provider or service directly
---

Some servers can't reach certain services directly, for example a server in mainland China connecting to Gmail or `chatgpt.com`. For those, add a proxy under **Settings → Proxies**. You pick the proxy feature by feature, and everything else keeps connecting directly.

## Add a proxy

1. Open **Settings → Proxies** and click **Add proxy**
2. Fill in the form:

| Field | Notes |
|---|---|
| Name | A label for yourself, such as "Hong Kong proxy" |
| Type | SOCKS5, HTTP, HTTPS or SOCKS4. HTTP and HTTPS proxies must support CONNECT |
| Host and port | For example `127.0.0.1` and `1080`. When DaMail runs in Docker, `127.0.0.1` is the container itself. To reach a proxy on the host, use the host's LAN address |
| Username and password | Only if the proxy needs authentication. The password is stored encrypted; leave it blank when editing to keep it |
| Test target | **Test connection** connects to this address through the proxy. The default is `imap.gmail.com:993`; change it to the server you need |

3. Click **Test connection**, then save once it succeeds

Accounts that use a proxy reconnect automatically after you edit it. If you delete a proxy, those accounts switch to a direct connection.

## Where to use it

| Use | Where to select it | What goes through the proxy |
|---|---|---|
| Sending and receiving mail | Edit mailbox → **Proxy** | IMAP, SMTP, Microsoft Graph and OAuth token refresh |
| Gmail / Microsoft authorization | **Settings → OAuth apps** → **Proxy** | Token exchange with Google or Microsoft during authorization. New mailboxes authorized this way use the same proxy by default |
| AI client sign-in | **Settings → OAuth settings** → **Proxy** | Fetching client metadata documents and keys for clients such as ChatGPT. Only the site of the client ID is accessed |
| Update checks | The `UPDATE_CHECK_PROXY_ID` environment variable | Reading the latest release from `api.github.com` |

:::note[What doesn't use the proxy]
- **AI model APIs:** calls to Claude or OpenAI-compatible APIs go out directly. If the server can't reach them, use a provider or relay it can reach in [Models](/docs/ai/models/)
- **Notifications:** Bark, WeCom, DingTalk, Feishu, Telegram and webhooks connect directly
- **Incoming traffic:** the web app, MCP and REST API are reached by others, so the proxy doesn't apply. AI assistants need a public HTTPS address for DaMail; see [AI assistants](/docs/assistants/#where-to-run-the-server)
:::

## Troubleshooting

**The test says the proxy refused the connection.** Check the host and port. In Docker, don't use `127.0.0.1`. Use the host's address, or run the proxy in the same Docker network and use its service name.

**The test passes but the mailbox still can't connect.** Make sure the proxy is selected and saved in the mailbox settings. For Gmail accounts authorized with OAuth, also select the proxy under **OAuth apps**, or authorization and token refresh will fail.
