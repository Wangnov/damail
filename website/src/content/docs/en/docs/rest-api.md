---
title: REST API
description: REST endpoints, the inbox rule format and webhooks
---

Every endpoint accepts `Authorization: Bearer <API key>`, or a web session. Permissions match [MCP](/en/docs/mcp/#permissions); the required one is noted in parentheses.

## Mail

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/accounts` | Mailboxes, status and unread counts |
| GET | `/api/v1/folders?account=` | Folders |
| GET | `/api/v1/threads?view=&account=&folder=&q=&cursor=` | Threads; `view` is `inbox` `important` `unread` `starred` `sent` `all` |
| GET | `/api/v1/threads/:threadId` | Thread detail |
| GET | `/api/v1/messages?q=&account=&cursor=&limit=` | Flat message search |
| GET | `/api/v1/messages/:id?format=text` | Message detail |
| GET | `/api/v1/messages/:id/attachments/:index` | Download an attachment |
| GET | `/api/v1/messages/:id/raw` | Raw .eml |
| POST | `/api/v1/search/semantic` | `{q, limit?}` natural-language search (needs AI) |
| POST | `/api/v1/threads/batch` | `{threadIds, action}`: `read` `unread` `star` `unstar` `archive` `trash` (organize) |
| POST | `/api/v1/threads/mark-read` | `{view?, account?, folder?, q?}` mark everything matching as read (organize) |
| POST | `/api/v1/messages/batch` | `{ids, action, folderId?}`, also `junk` `inbox` `move` (organize) |
| GET | `/api/v1/stats` | Overview |
| GET | `/api/v1/analytics?days=7\|30\|90\|365` | Analytics data |
| GET | `/api/v1/reports?kind=daily\|weekly` | Daily / weekly reports |
| GET | `/api/v1/reports/:id` | Report detail |
| GET | `/api/v1/contacts?q=` | Contacts |
| GET | `/api/v1/subscriptions?days=&filter=&page=&pageSize=&sort=&order=` | Newsletter senders, paginated |
| GET | `/api/v1/events` | SSE: `messages.new` `messages.updated` `account.status` `drafts.updated` |

## Drafts and sending

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/drafts?status=&thread=` | Drafts and outbox |
| GET | `/api/v1/drafts/:id` | Draft detail; `preview` is the final plain text |
| POST | `/api/v1/drafts` | `{mode, sourceMessageId?, accountId?, to, cc, bcc, subject, body, includeQuote}`; `mode` is `new` `reply` `replyAll` `forward` (draft) |
| PATCH / DELETE | `/api/v1/drafts/:id` | Update / delete a draft (draft) |
| POST / DELETE | `/api/v1/drafts/:id/attachments[/:index]` | Upload (multipart field `file`) / remove an attachment (draft) |
| POST | `/api/v1/drafts/:id/submit` | Submit for approval (draft) |
| POST | `/api/v1/drafts/:id/send` | Queue for sending `{delaySec?, sendAt?}` (send) |
| POST | `/api/v1/drafts/:id/cancel` | Cancel sending (draft) |
| POST | `/api/v1/drafts/:id/reject` | Reject pending mail (web session only) |

## Inbox rules

| Method | Path | Description |
|---|---|---|
| GET / POST | `/api/v1/rules` | List / create (automation) |
| GET / PATCH / DELETE | `/api/v1/rules/:id` | Get / update / delete (automation) |
| POST | `/api/v1/rules/test` | Dry-run: returns matching mail without running actions (automation) |
| POST | `/api/v1/rules/reorder` | `{ids}` set the order (automation) |
| GET | `/api/v1/channels` | Notification channels without config (automation) |

Rule format:

```json
{
  "name": "Push verification codes to my phone",
  "accountIds": null,
  "match": "all",
  "conditions": [{ "field": "has_code", "op": "is", "value": true }],
  "actions": [{ "type": "notify", "channelId": 1 }, { "type": "mark_read" }],
  "stopProcessing": false
}
```

- `field`: `from` `to` `subject` `body` `any` (`op`: `contains` `not_contains` `equals` `regex`); `category` `priority` `has_attachment` `unread` `needs_reply` `has_code` (`op`: `is` `is_not`)
- `type`: `notify` (`channelId`) `mark_read` `star` `archive` `move` (`folderId`) `junk` `trash` `ai_reply` (`instruction`)

## Webhook

Custom webhook channels `POST` JSON:

```json
{ "event": "message.verification", "title": "...", "body": "...", "url": "...", "copy": "382916", "data": {}, "timestamp": "2026-11-12T08:00:00.000Z" }
```

Requests carry `x-damail-event`. With a secret set, they also carry `x-damail-signature: sha256=<hex>`; verify it with HMAC-SHA256 over the **raw request body**:

```js
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-damail-signature']))) reject();
```

See [Notification channels](/en/docs/automation/notifications/#events) for the events.
