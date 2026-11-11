---
title: AI search
description: Describe the email you want in plain language; AI turns it into filters and synonyms, then picks the matches
---

When you can't remember the keywords, just describe what you're looking for:

- last month's cloud invoice
- the budget spreadsheet Daniel sent
- flight booking confirmation from last year
- did anyone ask me to meet next week?

## How to use it

Type the description into the search box and click **AI search** next to it (otherwise it's a regular keyword search). The results page shows:

- how AI understood your description
- how many messages it picked out of how many candidates
- a one-line reason why each message matches

Click **Use normal search instead** to switch back to keyword search.

## How it works

AI search needs no vector database or embeddings API — any chat model works:

1. **Understand**: the model turns your description into filters in [search syntax](/en/docs/search/) (dates, senders, categories…) plus a few groups of synonyms, covering English, Chinese and abbreviations
2. **Retrieve**: the existing full-text index returns up to 60 candidates
3. **Pick**: the model reads subjects and AI summaries, picks the messages that really match (up to 20) and explains why

If the filters return too few messages, the search relaxes automatically — first dropping keywords, then filters — and the results page says what was relaxed.

## Good to know

- AI must be enabled under [Models](/en/docs/ai/models/); AI search uses the **default model**
- Each search makes two model calls, recorded as "Semantic search" in usage
- The model sees candidates' subject, sender and summary, not the full body
- Results are better for mail that has been through [mail analysis](/en/docs/ai/analysis/), because picking uses the AI summaries
- It only searches mailboxes you have access to
