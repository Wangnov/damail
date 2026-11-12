---
title: Notification channels
description: Push to Bark, WeCom, DingTalk, Feishu, Telegram and custom webhooks
---

Notification channels push what matters to your phone or team chat: verification codes, important mail, drafts awaiting approval, mailbox connection problems, daily and weekly reports.

Go to **AI → Notification channels**. A channel can be used in two ways:

- **Subscribe to events**: pushed automatically when the event happens
- **Called by rules**: the **Send notification** action in [inbox rules](/docs/automation/rules/)

## Supported channels

### Bark (iPhone)

1. Install the Bark app on your iPhone
2. Copy the push URL from its home screen, like `https://api.day.app/XXXX/`
3. Enter the `XXXX` part as the **Key**

Change **Server** for a self-hosted Bark server. For verification codes, Bark **copies the code automatically**, ready to paste.

### WeCom

1. Open the group chat that should receive notifications and tap "…" in the top right
2. Choose "Message push" (or "Group robot") → Add robot
3. Copy the robot's **webhook URL**

### DingTalk

1. Group settings → Robots → Add robot → Custom (via webhook)
2. Pick one security option: **Custom keywords** with `DaMail`, or **Signature** and copy the secret starting with `SEC`
3. Copy the **webhook URL**; with signatures, enter the secret as the signing secret

### Feishu / Lark

1. Group settings → Bots → Add bot → Custom bot
2. Copy the **webhook URL**
3. If signature verification is on, copy the secret into **Signing secret**

### Telegram

1. Message [@BotFather](https://t.me/BotFather) with `/newbot` and copy the **bot token**
2. Send your bot a message
3. Open `https://api.telegram.org/bot<Token>/getUpdates` and copy `chat.id` into **Chat ID** (a number for you, starting with `-` for groups)

If your server can't reach Telegram directly, set **API base** to a reverse proxy.

### Custom webhook

Push to your own service (n8n, Home Assistant and so on):

- `POST` JSON: `{ event, title, body, url, data, timestamp }`
- The `x-damail-event` header carries the event name
- With a secret set: `x-damail-signature: sha256=<HMAC-SHA256(secret, raw body)>`

See [REST API · Webhook](/docs/rest-api/#webhook) for the format and a verification example.

:::note[Private addresses]
Pushing to private addresses (`10.x`, `192.168.x`, `localhost` and so on) is blocked by default, so channels can't be used to probe your network. Set `ALLOW_PRIVATE_WEBHOOKS=true` if you really need to push to an internal service.
:::

## Events

| Group | Event | When |
|---|---|---|
| Incoming | `message.received` | New mail in the inbox (every message) |
| Incoming | `message.important` | New mail marked high priority by AI |
| Incoming | `message.verification` | A verification code arrived |
| Sending | `draft.pending` | The AI assistant, an inbox rule or an agent submitted mail for approval |
| Sending | `draft.sent` | Mail sent |
| Sending | `draft.failed` | Mail failed to send |
| Sending | `followup.due` | A [follow-up](/docs/automation/follow-ups/) is due and the sent mail has no reply yet |
| System | `account.error` | A mailbox connection went from OK to failing |
| Reports | `report.daily` | Daily mail report generated |
| Reports | `report.weekly` | Weekly mail report generated |

When an inbox rule calls a channel, webhooks receive the event name `rule.matched`, with the rule's ID and name in `data.rule`.

A channel with no events ticked is only used by inbox rules.

## Delivery

- **One push per message per channel**: if several events apply, the most specific wins (verification > important > new mail); a channel already notified by a rule isn't notified again by events
- **Retries**: failed pushes are retried after 30 seconds, 1 minute and 2 minutes — 4 attempts in total
- **Delivery history**: each channel's delivery history shows every push with its content, status and error
- **Send test**: check that it arrives before saving

## Suggested setups

| Goal | Setup |
|---|---|
| Verification codes on your phone | Bark channel subscribed to `message.verification` |
| Important mail alerts | WeCom / DingTalk / Feishu group subscribed to `message.important` |
| Approving agent-written mail | Subscribe to `draft.pending`, then approve in the web app |
| Know when a mailbox drops | Subscribe to `account.error` (fires after an app password expires or a password changes) |
| Morning digest | Subscribe to `report.daily` |
| Alerts for one sender | An inbox rule matching the sender with a **Send notification** action |
