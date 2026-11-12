---
title: Models
description: Add model channels and pick models for mail analysis, the assistant and translation
---

AI features in DaMail are **off by default**, and there is no DaMail cloud service involved: you bring your own model keys, and requests go straight from your server to the model provider.

Go to **AI → Models**. Setup has two steps: add a **channel** (provider + endpoint + key), then pick **models** for each feature.

## Add a channel

Click **Add channel**:

| Field | Description |
|---|---|
| Name | Anything you like, such as "Claude" or "DeepSeek" |
| Provider | **Anthropic** or **OpenAI-compatible API** |
| Base URL | Leave empty for the official Anthropic API, or enter an Anthropic-compatible proxy. Required for OpenAI-compatible APIs; DaMail calls `{Base URL}/chat/completions` and `{Base URL}/models` |
| API key | Stored encrypted in your database; only the first and last few characters are shown |
| Models | Click **Sync upstream** to fetch the model list and tick the ones you want, or type model names |
| Prices | USD per million tokens, used only for cost tracking. **Fill reference prices** fills in common models; set a **rate** if a reseller discounts official prices |
| Concurrency | Maximum parallel requests on this channel, 10 by default. Set 1–2 if you see frequent 429s |

You can add several channels — for example a cheap DeepSeek channel for analysis and Claude for the assistant.

### Common providers

| Provider | Type | Base URL |
|---|---|---|
| Anthropic Claude | Anthropic | Leave empty |
| OpenAI | OpenAI-compatible | `https://api.openai.com/v1` |
| DeepSeek | OpenAI-compatible | `https://api.deepseek.com` |
| Qwen (Alibaba Cloud) | OpenAI-compatible | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Moonshot (Kimi) | OpenAI-compatible | `https://api.moonshot.cn/v1` |
| Local Ollama | OpenAI-compatible | `http://<ollama-host>:11434/v1` |

:::note[Local models]
Inside a container, `localhost` is the container itself. If Ollama runs on the host, use the host's LAN address, or add `extra_hosts: ["host.docker.internal:host-gateway"]` to the damail service in Compose and use `http://host.docker.internal:11434/v1`. The model must produce reliable JSON; very small models categorize poorly.
:::

## Pick models

There are three model settings at the bottom of the page:

| Setting | Used for | Tip |
|---|---|---|
| **Default model** | Categorizing and summarizing new mail, the AI brief in reports, AI search, label suggestions | Pick something cheap and fast if you get a lot of mail |
| **AI assistant** | The chat panel in the corner | Needs tool calling; a stronger model works better |
| **Translation** | The **Translate** button on a message | Can use its own channel and model, with a target language |

The assistant and translation **follow the default channel and model** unless you change them; switching channel means picking a model again.

**Effort** controls how long the model thinks: "low" is enough for categorizing; higher is slower and uses more tokens. Anthropic supports low / medium / high / xhigh / max; OpenAI-compatible APIs support low / medium / high.

Click **Save settings**, then turn on **Enable AI** at the top. The **Test** button next to each model makes a real call and shows the latency or the error.

## Rate limits and retries

- When a provider returns 429, the channel pauses briefly (following `Retry-After`, 5 seconds to 2 minutes) and then continues with queued requests
- The channel list shows active and queued requests and when it was last rate-limited
- Failed analysis is retried; if it still fails, AI is skipped and **inbox rules and notifications still run**

## Privacy

:::caution[What is sent to the model]
Once enabled, the sender, recipients, subject and body (truncated at 20,000 characters) of each message are sent to the provider you choose. You can limit analysis to some mailboxes, ignore certain senders, or use a local model only.
:::

Every prompt tells the model to treat message content as **untrusted data**. Model output is only used for labels, summaries and replies that **wait for your approval** — it never triggers sending. You can read the system prompts for each feature under **AI → Prompts**.
