---
title: Categories & labels
description: Built-in categories and your own labels — AI suggests them from your mail and applies them to new mail
---

**Categories** are the ten built-in groups; every message belongs to exactly one. **Labels** are finer distinctions on top, such as "Broker trade confirmations" or "Client A project", and a message can have several.

Go to **AI → Categories & labels**.

## Let AI suggest labels

Suggestions beat writing your own: click **Recommend labels from my mail** and AI reviews the last 90 days of your mail. After a few dozen seconds you get a set of suggestions, each with a name, a description, how many messages it covers and examples.

- **Accept**: create the label and apply it to the past messages it covers
- **Rename**: change the name before accepting
- **Dismiss**: drop the suggestion
- If the name clashes with an existing label, **Merge into existing label** moves the covered messages there

From then on, AI decides whether to apply the label when it analyzes new mail.

## Create one yourself

Click **Create manually** and enter a name and a **description**. AI decides whether a new message gets the label from the description alone, so be specific:

- who sends it and what kind of mail it is
- what it does not include

> For example: trade confirmations and daily position statements from brokers such as Interactive Brokers; not marketing mail

Names and descriptions can be filled in for both English and Chinese; a missing language falls back to the one you filled in.

## Manage labels

| Action | Description |
|---|---|
| Color | Color of the label in lists and the sidebar |
| In sidebar | Show it under **Labels** in the mail sidebar |
| Apply to past | Have AI check the last 30 days of inbox mail for this label (only messages not yet checked for it; uses AI credits) |
| Delete | Removes the label from messages (the messages stay); inbox rule conditions that use it stop matching |

You can have up to 50 labels.

You can add or remove labels on a message by hand. A label you remove manually won't be re-applied by later analysis.

## Use labels elsewhere

- Search: click a label in the sidebar, or use `label:client` — see [Search syntax](/en/docs/search/)
- [Inbox rules](/en/docs/automation/rules/): use the **Label** condition, for example to push broker confirmations to your phone
