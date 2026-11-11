---
title: Mail analysis
description: Categorize new mail, set priority, summarize and extract codes, bills and to-dos automatically
---

When analysis is on, AI reads every new message that reaches your inbox and produces structured results. Inbox tags, the Important and Awaiting reply views, AI conditions in inbox rules, reports and the AI assistant all build on them.

Go to **AI → Mail analysis**. Analysis uses the **default model** from [Models](/en/docs/ai/models/), so set that up and enable AI first.

## What you get

| Result | Description |
|---|---|
| Category | Important, work, personal, finance, verification, shipping, notification, social, marketing or spam — every message gets one |
| Labels | Labels you accepted or created under [Categories & labels](/en/docs/ai/labels/); a message can have several |
| Priority | High / normal / low; high-priority mail shows up in **Important** |
| Needs reply | Messages that need a reply show up under the needs-reply filter |
| Summary | One sentence on what the message is about and what you need to do |
| Extracted info | Verification codes, amounts, due dates, tracking numbers, to-dos |

Where to see it:

- **Message list**: a category tag on each message; click it to see similar mail
- **Message view**: the **AI summary** card at the top, with the summary, extracted details and the model that produced it
- **Search**: syntax such as `category:finance`, `priority:high`, `is:needs-reply` and `has:code` filters on analysis results — see [Search syntax](/en/docs/search/)

## Settings

| Setting | Description |
|---|---|
| Analyze new mail | Master switch. Turning it off stops sending new mail to AI; existing results stay |
| Scope | Only analyze new mail in the selected mailboxes (all by default) |
| Ignored senders | Mail from these senders is never sent to AI and is left out of reports and the overview. Managed in **Contacts**, whole domains supported |
| Model | Uses the default model; change it under Models |

## When analysis runs

Only **new mail arriving in the inbox** (dated within the last 3 days) is analyzed automatically. These do **not** trigger it, so you don't burn through credits at once:

- The initial backfill after adding a mailbox
- Folder rebuilds and resyncs
- Moving old mail back to the inbox

[Inbox rules](/en/docs/automation/rules/) and [notifications](/en/docs/automation/notifications/) run after analysis finishes, so rules can use the AI results.

## Analyze past mail

Mail received before you turned analysis on is not analyzed automatically. Under **Analyze past mail**, choose how many and click **Start**:

- Processes newest first, with progress shown at the top of the page
- **Only adds labels and summaries — no inbox rules, no notifications**
- Already analyzed mail is skipped

## Tuning

- Categories are built in and can't be changed; use [labels](/en/docs/ai/labels/) for finer distinctions
- Read the prompts sent to the model under **AI → Prompts**
- Too much marketing? Archive it with an inbox rule, or unsubscribe in [Subscriptions](/en/docs/subscriptions/)
