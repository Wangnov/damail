---
title: Usage & cost
description: A record of every model call, cost statistics and price settings
---

DaMail records every model call so you can track down failures and keep costs in check. Go to **AI → Usage**.

## Requests

One row per model call: time, purpose, channel, model, status, latency, input / output tokens, cache hits and cost. Failed requests show the error. Filter by purpose, model, channel and status.

Purposes:

| Purpose | Comes from |
|---|---|
| Mail analysis | Automatic analysis of new mail and analyzing past mail |
| Reply drafts | The **AI reply draft** action in inbox rules |
| Reports | The AI brief in reports |
| Semantic search | [AI search](/docs/ai/search/) |
| AI assistant | Each round of the assistant's tool calls counts once |
| Chat titles | Automatic titles for assistant conversations |
| Translation | [Translation](/docs/ai/translate/) |
| Label suggestions | Suggestions in [Categories & labels](/docs/ai/labels/) |
| Test | The **Test** button in Models |

Requests are kept for 180 days.

## Stats

See request counts, failures, cost, token usage and average latency for the last 24 hours, 7, 30 or 90 days, broken down by model, purpose and channel and compared with the previous period.

## How cost is calculated

Cost = model price × tokens × channel rate. Prices are set when editing a channel in [Models](/docs/ai/models/) (USD per million tokens); **Fill reference prices** fills in official prices for common models.

- An empty cache price falls back to the input price
- Models without a price aren't counted; the stats page tells you how many requests were left out
- After adding prices, **Recalculate at current prices** fills in the cost of those requests

## Keeping costs down

- Use a cheap, fast model with low effort for mail analysis
- Limit [analysis scope](/docs/ai/analysis/#settings) to the mailboxes that matter
- Add notification and marketing senders to the ignore list
- Give the assistant its own stronger model so everyday analysis stays cheap
