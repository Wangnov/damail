---
title: Awaiting reply & follow-ups
description: See which sent mail is still waiting for an answer, and get reminded when there's no reply
---

## Awaiting reply

**Awaiting reply** in the mail sidebar lists threads where you sent the last message and are waiting for an answer, with how long you've waited and how quickly that person usually replies.

How it decides (from headers only, no model calls):

- The last message in the thread is yours, and you started the conversation or asked a question or for something — a quick "thanks, got it" doesn't count
- You've waited more than 48 hours or 3× the person's usual reply time (median), whichever is longer, capped at one week
- Mail to automated and role addresses (like `noreply@`) is ignored
- Mail sent long ago drops off the list (unless it has a follow-up reminder)

Threads leave the list automatically when the other side replies. If you don't need to wait anymore, click **Stop waiting for a reply**.

## Follow-up reminders

When writing, pick **Remind if no reply** next to the send button: 1 day, 3 days, 1 week, 2 weeks or a custom time. You can also set one on mail you've already sent.

- If there's still no reply when it's due, a notification goes to channels subscribed to `followup.due` — see [Notification channels](/en/docs/automation/notifications/)
- A reply ends the reminder automatically (matched by the reply's `In-Reply-To` / `References`; mail from your own other mailboxes doesn't count)
- Due reminders show as a count on **Awaiting reply** in the sidebar
- Change the time, cancel the reminder or mark it done at any time
