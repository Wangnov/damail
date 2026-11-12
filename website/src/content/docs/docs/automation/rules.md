---
title: Inbox rules
description: Combine sender, subject, AI category and more to notify, flag, archive or draft replies automatically
---

Inbox rules run when new mail reaches your inbox: they are checked in order and their actions run on matches. For example:

- push verification codes to your phone
- star finance mail
- archive marketing automatically
- send a client's mail to a team chat and have AI draft an acknowledgement

Go to **AI → Inbox rules**. Rules only apply to mail received **after they are created**.

## Create a rule

### 1. Name and mailboxes

Name the rule and pick the mailboxes it applies to; none selected means all mailboxes.

### 2. Conditions

Choose "when mail matches **all** / **any** conditions", then add conditions:

| Condition | Checks | Notes |
|---|---|---|
| From | contains / doesn't contain / equals / matches regex | Name and address |
| To / Cc | same | |
| Subject | same | |
| Body | same | |
| Anywhere | same | From, to, subject or body |
| Has attachment | yes / no | |
| Unread | yes / no | |
| AI category | is / is not | Requires [mail analysis](/docs/ai/analysis/) |
| AI priority | is / is not | High / normal / low |
| AI says needs reply | yes / no | |
| Has verification code | yes / no | AI extracted a code |
| Label | labeled / not labeled | See [Categories & labels](/docs/ai/labels/) |

Text matching is **case-insensitive**, including regex.

:::note
Rules are checked after the message has been analyzed. If AI is off or analysis failed for that message, AI conditions don't match; other conditions are still checked.
:::

### 3. Actions

| Action | Description |
|---|---|
| Send notification | Push to a chosen [notification channel](/docs/automation/notifications/) |
| Mark as read | Written back to the mail server |
| Star | Written back to the mail server |
| Archive | Moves to the archive folder |
| Move to folder | Only applies to mail in that folder's mailbox |
| Mark as junk | Moves to the junk folder |
| Move to trash | Moves to trash; nothing is deleted permanently |
| AI reply draft (needs approval) | Drafts a reply following your instructions into **Drafts → Awaiting approval** |

A rule can have several actions. Actions that move the message (archive, move, junk, trash) always **run last**, so the other actions can still find it.

With **stop processing** on, later rules are skipped when this one matches.

## Dry run

Before saving, click **Dry run** to test the conditions against the **last 200 inbox messages** and see which would match. A dry run never performs any action.

## AI reply drafts

- Spell out the tone and points, such as "politely confirm receipt and say I'll reply by Friday"
- Drafts **only go to the approval queue and are never sent automatically** — you confirm or edit them first
- Mail from your own other mailboxes is **never drafted for**, so two mailboxes can't reply to each other in a loop
- Channels subscribed to "an agent submitted mail for approval" are notified when the draft is queued

## Managing rules

The rule list shows match counts and when each rule last matched. Reorder with the up / down arrows, and toggle rules on or off.

Every match is written to the **audit log**, including which actions ran and whether any failed.

## When rules don't run

As with analysis, only new inbox mail from the last 3 days triggers rules. The initial backfill, resyncs and moving old mail back to the inbox don't.
