---
title: Search syntax
description: Filters supported by the search box
---

The search box supports these filters, which can be combined. Everything else is treated as full-text keywords (CJK included):

| Filter | Example | Description |
|---|---|---|
| `from:` | `from:alice@example.com` | Sender |
| `to:` | `to:me@example.com` | Recipient |
| `subject:` | `subject:invoice` | Subject |
| `account:` | `account:gmail` | Mailbox address, name or provider |
| `folder:` | `folder:sent` | `inbox` `sent` `junk` `trash` or a folder name |
| `is:` | `is:unread` | `unread` `read` `starred` `answered` |
| `has:attachment` | | Has attachments |
| `after:` / `before:` | `after:2026-10-01` | Date range |
| `label:` | `label:clients` | Label |
| `"..."` | `"quarterly budget"` | Exact phrase |
| `-` | `-newsletter` | Exclude a keyword |

With AI analysis enabled you can also use:

| Filter | Description |
|---|---|
| `category:` | `finance` `work` `personal` `verification` `shipping` and other categories |
| `priority:` | `high` `normal` `low` |
| `is:needs-reply` | Needs a reply |
| `has:code` | Contains a verification code |

For natural-language search, click **AI search** next to the search box — see [AI search](/en/docs/ai/search/).
