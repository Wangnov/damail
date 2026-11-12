---
title: Reports & stats
description: Daily and weekly mail digests with an AI brief, plus trends, hourly heatmaps and top senders
---

## Daily and weekly reports

Every morning DaMail sums up the previous day: how much mail arrived, what's important, what's waiting for your reply and which bills are due — with a short AI brief when AI is on. Every Monday there's a weekly report for the previous week.

Go to **Reports** in the top navigation.

### What's in a report

| Section | Contents |
|---|---|
| Overview | Received, important, needs reply and sent, compared with the previous day / week; inbox unread at generation time |
| AI brief | A short summary written by the default model; numbers only when AI is off |
| Daily volume | Per day, in weekly reports |
| Needs reply | Mail AI says needs a reply that you haven't answered |
| Important | Mail AI marked high priority |
| Bills | Mail with extracted amounts and due dates |
| Categories | Count per category |
| Top senders / per mailbox | Rankings |

Counting rules: sent, drafts and junk folders and mail to yourself are excluded, and a message in several folders counts once.

### Settings

Under **Report settings** on the Reports page:

| Setting | Default |
|---|---|
| Daily report | On, generated at 8:00 for the previous day |
| Weekly report | On, generated Mondays at 9:00 for the previous Monday–Sunday |

**Generate report** creates a report for any day or week on demand; for a period that isn't over, it counts up to now. Generating again for the same period replaces the old report.

:::caution[Time zone]
Reports use the **server's time zone** for day boundaries and generation times. Docker containers default to UTC — add `TZ: Europe/Berlin` (or your zone) under `environment` for the damail service in `docker-compose.yml`.
:::

### Push

To get reports on your phone or in a group chat, subscribe a [notification channel](/docs/automation/notifications/) to `report.daily` and `report.weekly`.

The AI assistant can read reports too — ask "what did today's report say?".

## Stats

Go to **Stats** in the top navigation and pick 7 days, 30 days, 90 days or 1 year:

- **Volume**: received and sent per day (per week for 1 year)
- **Hours**: a weekday × hour heatmap of when mail arrives
- **Categories**: count and unread per category
- **Top senders / domains**: who emails you most
- **Mailboxes**: received and sent per mailbox
- **Unread backlog**: inbox unread by age — under 24 hours, 1–7 days, 7–30 days, over 30 days
- **Reply rate**: of the mail AI said needs a reply, how much you answered

Counting matches the reports.
