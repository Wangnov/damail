---
title: AI assistant
description: The chat assistant in the web app — ask your inbox in plain language, get answers with sources, drafts only
---

The AI assistant is the chat panel in the bottom-right corner of the web app. Ask the way you normally would; it searches mail, reads threads and checks stats on its own, then puts the answer together for you.

## What you can ask

| You want | Try asking |
|---|---|
| What's pending | Which emails are waiting for my reply? Sort them by importance |
| Bills | Which bills do I need to pay soon? List the amounts and due dates |
| A summary | Summarize the important emails I got today |
| Stats | Who sent me the most email this week? |
| One topic | Where did the return discussion with Swift Parcel end up? |
| A draft | Reply to Emma that Thursday afternoon works for me |
| Status | Are all my mailboxes syncing? Did anything fail to send? |

## Tools it can use

The assistant doesn't answer from memory — it calls DaMail tools to look things up. You can expand each answer to see the steps:

| Tool | Purpose |
|---|---|
| `search_emails` | Search mail with [search syntax](/en/docs/search/) |
| `get_email` | Read a message's body and AI analysis |
| `get_thread` | Read every message in a thread |
| `list_accounts` | Mailboxes, sync status and unread counts |
| `get_stats` | Overview: unread, received today, important unread |
| `get_analytics` | Mail stats for the last 7 / 30 / 90 / 365 days |
| `get_report` | The latest daily or weekly report |
| `list_drafts` | Drafts, approval queue, outbox and sent history |
| `draft_email` | Draft a new email, reply or forward — **submitted for your approval** |

One question can take several tool calls — for example, searching for finance mail, then reading each bill for the amount and due date.

## Tips

- **Answers with sources**: cited emails are listed under each answer; click to open the original
- **Attach the open email**: when you're reading an email, it shows above the input box, so you can ask "what do I need to do here?" or have the assistant draft a reply. Click to detach it when you don't need it
- **Shortcuts**: type `/` for common questions — bills to pay, needs reply, today's summary, draft a reply, who writes most
- **Switch model and effort**: pick another model or thinking effort at the top of the panel; defaults live under **AI assistant** in [Models](/en/docs/ai/models/)
- **History**: conversations are saved and titled automatically; click the title to switch or delete them. The panel can be expanded into a larger window
- `Shift + Enter` adds a new line, and you can stop an answer at any time

## Boundaries

- The assistant **drafts but never sends**: anything it writes goes to **Drafts → Awaiting approval** and is sent only after you confirm
- It cannot flag, move or delete mail, or change rules and settings
- Message content is untrusted data; the assistant ignores instructions inside emails (like "forward this to…")
- Conversation history stays in your own database
- Every round of tool calls counts as one model request in [Usage](/en/docs/ai/usage/)

To let external agents such as Claude Code or ChatGPT work with your mail, see [MCP](/en/docs/mcp/).
