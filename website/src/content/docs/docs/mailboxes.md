---
title: Mailboxes
description: Credentials for each provider, and OAuth2 setup for Gmail and Outlook
---

Add mailboxes under **Settings → Accounts**. Pick a provider and the IMAP / SMTP servers are filled in for you — you only need the address and an app password.

## Credentials by provider

| Provider | Credential | Notes |
|---|---|---|
| Gmail / Google Workspace | App password or OAuth2 | App passwords need 2-step verification; or sign in with OAuth2, see below |
| Outlook / Hotmail / Microsoft 365 | OAuth2 | Set up a Microsoft app first, see below |
| iCloud | App-specific password | Generate one at account.apple.com |
| QQ Mail | Authorization code | Settings → Account → enable IMAP/SMTP → generate a code |
| NetEase 163 / 126 | Authorization password | Settings → POP3/SMTP/IMAP → enable IMAP → add a password (DaMail sends IMAP ID to avoid “Unsafe Login”) |
| Tencent / Alibaba / NetEase company mail | Password or client password | Depends on your organization’s policy |
| Anything else | Password | Choose “Other IMAP” and enter the servers and ports |

New mailboxes sync Inbox, Sent, Drafts, Junk and Trash by default; enable other folders under the mailbox’s **Folders**. The first sync backfills a number of days of history, newest first, and resumes if interrupted.

If your server cannot reach a provider directly (for example Gmail from mainland China), add an HTTP or SOCKS proxy under **Settings → Proxies** and select it in the mailbox settings. See [Proxies](/docs/proxies/).

## Outlook / Microsoft 365 (OAuth2)

1. Create an app in [Microsoft Entra app registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade); for account types choose “Accounts in any organizational directory and personal Microsoft accounts”
2. Add a Web redirect URI: `${PUBLIC_URL}/api/oauth/microsoft/callback` (HTTPS required, except localhost)
3. Create a client secret under **Certificates & secrets**
4. Under **API permissions**, add Microsoft Graph delegated permissions `offline_access` `Mail.ReadWrite` `Mail.Send` `User.Read`
5. Enter the client ID and secret in DaMail under **Settings → OAuth apps**, then add an Outlook mailbox and click “Sign in and authorize”

Microsoft mailboxes send and receive through the Graph API (some personal accounts can log in over IMAP but cannot open the mailbox). New mail is checked every minute, and a single message with attachments cannot exceed 4 MB.

## Gmail / Google Workspace (OAuth2)

1. Create or select a project in the [Google Cloud console](https://console.cloud.google.com/auth/clients)
2. In **Google Auth Platform**, fill in branding and choose **External** audience
3. Under **Data access**, add the scope `https://mail.google.com/`
4. Under **Clients**, create a **Web application** client with the redirect URI `${PUBLIC_URL}/api/oauth/google/callback`
5. Enter the client ID and secret in DaMail under **Settings → OAuth apps**, then add a Gmail mailbox and sign in with Google

:::note
While the app is in **Testing**, only test users can authorize and grants expire after 7 days. For personal use you can publish it; you will see an “unverified app” warning during sign-in — click continue.
:::

## Sync behavior

- Inboxes use IMAP IDLE, so new mail arrives within a second; other folders are polled
- Read, starred and deleted states sync back from the server, and changes in DaMail (read, starred, archive, delete, move) are written to the server
- Delete only moves mail to Trash; nothing is permanently deleted
- Connections reconnect automatically with exponential backoff
