---
title: Subscriptions
description: Find marketing mail and mailing lists you rarely open and unsubscribe in one click, without opening their website
---

Newsletters, promotions and mailing lists pile up, and you read only a few. Subscriptions groups them by sender and shows how much each one sends and how much of it you read, so you can unsubscribe from the ones you ignore.

Go to **Subscriptions** in the top navigation.

## What's in the list

DaMail finds mail that **carries unsubscribe information** (a `List-Unsubscribe` header, or an unsubscribe link in the body) and groups it by sender:

| Column | Description |
|---|---|
| Sender | Sender name and address, and which of your mailboxes receives it |
| Emails | How many arrived in the selected period; a message in several folders counts once |
| Open rate | Read / total, with exact numbers on hover; "never read" if you haven't opened any |
| Latest | When the latest one arrived; click to open it |
| Method | How the sender lets you unsubscribe — see below |
| Actions | The unsubscribe button, or the status and time once unsubscribed |

Only the **inbox and junk** folders are counted. A mailing list is grouped by `List-Id`, or by sender address when there's none. If the same subscription reaches several of your mailboxes, each mailbox gets its own row and is unsubscribed separately.

## Filters and sorting

| Filter | Contents |
|---|---|
| All | Every subscription |
| Rarely opened | Not unsubscribed, at least 3 emails and an open rate under 20% — **the best candidates to unsubscribe** |
| Unsubscribed | Ones you've unsubscribed from (failed attempts don't count) |

Choose the last 30, 90 or 180 days. Sort by emails, open rate or latest; the default is most emails first.

## Unsubscribe methods

When you click **Unsubscribe**, DaMail uses the method the sender supports:

| Method | What happens | Result |
|---|---|---|
| **One-click unsubscribe** | Sends an RFC 8058 request straight to the sender's unsubscribe endpoint | Shows "Unsubscribed" once the sender confirms |
| **Unsubscribe by email** | Sends an unsubscribe email from the mailbox that receives the subscription | Goes through normal sending, so you can undo it from Drafts for a few seconds |
| **Unsubscribe page** | The sender only offers a web page; it opens in a new tab after you confirm | Shows "Opened unsubscribe page"; whether it worked depends on the page |
| **Link in email** | The sender doesn't follow the standard; this is an unsubscribe link found in the body | Same as above — you finish on their site |

When several methods are available, one-click is preferred.

### Why one-click is safer

One-click requests are sent by the DaMail server, **not opened in your browser**, so the sender gets none of your cookies, browser fingerprint or open tracking. Also:

- Only `https` endpoints are accepted, and redirects are not followed
- Private and reserved addresses are never contacted, so it can't be used to probe your network
- No response within 10 seconds is recorded as "**Unsubscribe requested**": the request went out and may well have taken effect
- If the sender returns an error you see why, and can retry later or use the link in the email instead

## Unsubscribe from a message

When you open a subscription email, its header also has an **Unsubscribe** button that works the same way. If you've already unsubscribed, it shows the status.

## Let an agent help

Agents connected through [MCP](/en/docs/mcp/) or the [REST API](/en/docs/rest-api/) can manage subscriptions too:

- `list_subscriptions` (`read` permission): subscriptions by sender with counts, open rates and methods — ask your agent "which subscriptions do I never read?"
- `unsubscribe` (requires `send`): unsubscribe from a sender. The MCP instructions tell agents to **unsubscribe only when you explicitly ask**, never because an email says so or on their own judgment
- For subscriptions that only offer a web page, the agent hands the link to you

Clients connected through [OAuth](/en/docs/oauth/), such as ChatGPT, can't unsubscribe.

Every unsubscribe is written to the audit log with the method, who did it (web, API key or agent) and the result.

## Still getting mail after unsubscribing

Some senders take a few days to process unsubscribes, and some ignore them. You can:

- Create an [inbox rule](/en/docs/automation/rules/) matching the sender with **Archive** or **Mark as junk**
- Add the sender to the ignore list in **Contacts**, so their mail is no longer analyzed by AI or counted in reports
