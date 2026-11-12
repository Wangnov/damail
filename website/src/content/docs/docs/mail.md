---
title: Reading & sending
description: Unified inbox, threads, compose, signatures, undo send and scheduled send, draft approval
---

## Unified inbox

Mail from every mailbox comes together in one place. The sidebar switches between views, categories, labels and mailboxes:

| View | Contents |
|---|---|
| Inbox | The inboxes of all mailboxes |
| Important | Mail AI marked high priority |
| Awaiting reply | Threads where you're waiting for an answer — see [Awaiting reply & follow-ups](/docs/automation/follow-ups/) |
| Unread / Starred / Sent / All Mail | Across every mailbox |
| Categories / Labels | AI categories and your labels — see [Categories & labels](/docs/ai/labels/) |
| Mailboxes | One mailbox's mail and folders |

Messages about the same thing are grouped into **threads**, including replies you sent from other clients.

- The list supports **multi-select** and a **right-click menu**: read / unread, star, archive, move, delete
- Read, starred, archive, delete and move are **written back to your mail server**, so your phone's mail app sees the same thing
- Delete moves mail to Trash; in Trash you can **delete forever**, which removes it from the server permanently
- The search box supports syntax such as `from:`, `has:attachment` and `is:unread` — see [Search syntax](/docs/search/) — or try [AI search](/docs/ai/search/)

## Reading mail

- **Safe rendering**: HTML mail is sanitized and shown in a script-free sandbox
- **Remote images are blocked by default**, so senders can't use tracking pixels to see that you opened their mail; click **Show images** when you want them
- With AI on, the **AI summary** card at the top shows the summary, codes, amounts, due dates, tracking numbers and to-dos
- Click **Translate** for foreign-language mail — see [Translation](/docs/ai/translate/)
- Download the original message (`.eml`)
- Messages larger than `MAX_MESSAGE_MB` (30 MB by default) only sync their first 2 MB, with a note that attachments may be incomplete

## Writing mail

Click **Compose**, or reply, reply all or forward from a message:

- **From**: choose which mailbox to send from; replies default to the mailbox that received the original
- **Recipients**: type them, or **Choose from contacts**, sorted by frequency or recency, with multi-select
- **Rich text**: bold, font size, color, alignment, lists, quotes, links and tables; paste or drag images into the body
- **HTML source mode**: paste HTML you wrote yourself and send it as is
- **Attachments**: use the button or drag files into the compose window; the total size limit is `MAX_ATTACHMENT_MB` (25 MB by default)
- **Signatures**: one per mailbox, added automatically below the body; untick to leave it off
- **Autosave**: drafts save as you type

### Undo send

After you click **Send**, the message waits a few seconds before it actually goes out (10 seconds by default, set with `SEND_DELAY_SEC`). Click **Undo** during that time and it returns to drafts.

### Scheduled send

Use the arrow next to the send button and choose **Schedule send**: today 18:00, tomorrow 08:00, tomorrow 14:00, next Monday 09:00 or a custom time (up to a year ahead). Until then the message sits in the outbox, and you can cancel the schedule and keep editing.

:::note
Scheduled mail is sent by the DaMail server, so the service needs to be running at that time.
:::

### Follow-up reminders

Next to the send button you can set **Remind if no reply**; if there's no answer by then you get a notification — see [Follow-up reminders](/docs/automation/follow-ups/#follow-up-reminders).

## Drafts and approval

**Drafts** in the top navigation holds everything not yet sent or just sent:

| Tab | Contents |
|---|---|
| Awaiting approval | Mail written by the AI assistant, inbox rules, MCP or the REST API — **sent only after you approve it** |
| Drafts | Your unfinished drafts, plus mail you rejected that's waiting for the submitter to revise |
| Outbox | Scheduled mail and mail being sent; undo or cancel the schedule |
| Sent | Mail sent through DaMail |
| Failed | Mail that didn't go out and why; edit and resend |

When reviewing mail awaiting approval you can:

- **Approve and send**: send it as is (still with an undo window)
- **Edit, then send**: change it in the editor first
- **Reject**: the submitter (an agent, for example) sees it was rejected and can revise and resubmit

Every message shows where it came from (web, AI assistant, inbox rule, MCP, API) and any note from the submitter. To get approval requests on your phone, subscribe a [notification channel](/docs/automation/notifications/) to `draft.pending`.

## Subscriptions

**Subscriptions** in the top navigation groups marketing mail and mailing lists by sender with counts and open rates, so you can unsubscribe in one click from the ones you never read — without opening their website. See [Subscriptions](/docs/subscriptions/).

## Contacts

**Contacts** builds your address book from the mail you send and receive, with message counts and last contact. From here you can add a sender or a whole domain to the **ignore list**: their mail is no longer sent to AI and is left out of reports and the overview.
