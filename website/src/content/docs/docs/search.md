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
| `after:` / `before:` | `after:2026-10-01` `after:7d` | Date range; `before` excludes that day. Relative dates: `today` `yesterday` `7d` (last 7 days, including today) `2w` `3m` `1y` |
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

Chinese keywords work too, such as `发件人:`, `未读` and `今天`; they're converted to the syntax above when you search. To search for a word like `今天` literally, put it in quotes.

## Suggestions and shortcuts

- **Quick filters**: click the empty search box to see quick filters (unread, starred, has attachment, needs reply, today, last 7/30 days) and your recent searches. Recent searches are stored only in this browser.
- **Autocomplete**: start typing a filter name (`fr`, `att`) to complete it. After `from:` or `to:` you get matching contacts; after `account:`, `folder:`, `label:`, `category:`, `priority:`, `after:` or `before:` you get the available values.
- **Keyboard**: `↑` `↓` to select, `Tab` to complete, `Enter` to search (or pick the selected item), `Esc` to close. Press `/` anywhere to focus the search box.
- **Conditions**: after searching, each condition appears as a tag under the search box; click × to remove it.
- **Syntax help**: click **?** at the end of the search box and click any item to insert it at the cursor.

For natural-language search, click **AI search** next to the search box — see [AI search](/docs/ai/search/).
