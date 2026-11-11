---
title: 通知渠道
description: Bark、企业微信、钉钉、飞书、Telegram 和自定义 Webhook 推送
---

通知渠道把重要的事推送到你的手机或群聊：验证码、重要邮件、待审批的草稿、邮箱连接异常、日报周报等。

入口：**智能 → 通知渠道**。渠道有两种用法：

- **订阅事件**：事件发生时自动推送
- **被规则调用**：在[收信规则](/docs/automation/rules/)里用「推送通知」动作指定渠道

## 支持的渠道

### Bark（iPhone）

1. 在 iPhone 上安装 Bark App
2. 首页复制推送地址，形如 `https://api.day.app/XXXX/`
3. 把其中的 `XXXX` 填到 **Key**

自建 Bark 服务时修改「服务器」。推送验证码时，Bark 会**自动复制验证码**，打开通知就能粘贴。

### 企业微信

1. 打开要接收通知的群聊，点右上角「…」
2. 选择「消息推送」（或「群机器人」）→ 添加机器人
3. 复制机器人的 **Webhook 地址**

### 钉钉

1. 群设置 → 机器人 → 添加机器人 → 自定义（通过 Webhook 接入）
2. 安全设置二选一：**自定义关键词**填 `DaMail`，或者选**加签**并复制 `SEC` 开头的密钥
3. 复制 **Webhook 地址**；用了加签时把密钥填到「加签密钥」

### 飞书

1. 群设置 → 群机器人 → 添加机器人 → 自定义机器人
2. 复制 **Webhook 地址**
3. 开启了「签名校验」时，同时复制密钥填到「签名密钥」

### Telegram

1. 找 [@BotFather](https://t.me/BotFather) 发送 `/newbot` 创建机器人，复制 **Bot Token**
2. 给你的机器人发一条消息
3. 打开 `https://api.telegram.org/bot<Token>/getUpdates`，找到 `chat.id` 填到 **Chat ID**（个人是数字，群组以 `-` 开头）

服务器无法直连 Telegram 时，「API 地址」可以填反向代理。

### 自定义 Webhook

推送到你自己的服务（如 n8n、Home Assistant）：

- `POST` JSON：`{ event, title, body, url, data, timestamp }`
- 请求头 `x-damail-event` 是事件名
- 填了密钥时带 `x-damail-signature: sha256=<HMAC-SHA256(密钥, 原始请求体)>`

格式和签名校验示例见 [REST API · Webhook](/docs/rest-api/#webhook)。

:::note[内网地址]
默认禁止推送到内网地址（`10.x`、`192.168.x`、`localhost` 等），防止被用来探测内网。确实要推送到内网服务时，设置环境变量 `ALLOW_PRIVATE_WEBHOOKS=true`。
:::

## 可订阅的事件

| 分组 | 事件 | 触发时机 |
|---|---|---|
| 收信 | `message.received` | 收件箱收到新邮件（所有新邮件） |
| 收信 | `message.important` | AI 判定为高优先级的新邮件 |
| 收信 | `message.verification` | 收到验证码 |
| 发信 | `draft.pending` | AI 助手、收信规则或 Agent 提交了待审批的邮件 |
| 发信 | `draft.sent` | 邮件已发送 |
| 发信 | `draft.failed` | 邮件发送失败 |
| 发信 | `followup.due` | [跟进提醒](/docs/automation/follow-ups/)到期，发出的邮件还没有回复 |
| 系统 | `account.error` | 邮箱连接从正常变为异常 |
| 日报周报 | `report.daily` | 每日邮件日报生成 |
| 日报周报 | `report.weekly` | 每周邮件周报生成 |

收信规则调用渠道时，Webhook 收到的事件名是 `rule.matched`，`data.rule` 里带规则的 ID 和名称。

一个事件都不勾选时，这个渠道只会被收信规则用到。

## 推送规则

- **同一封邮件对一个渠道只推送一次**：同时满足多个事件时取最具体的一个（验证码 > 重要 > 新邮件）；规则已经推送过的渠道不会再按事件推送
- **失败重试**：推送失败会在 30 秒、1 分钟、2 分钟后重试，共 4 次
- **推送记录**：每个渠道的「推送记录」里能看到每条推送的内容、状态和错误
- **发送测试**：保存前可以点「发送测试」确认能收到

## 推荐配置

| 场景 | 做法 |
|---|---|
| 验证码推到手机 | Bark 渠道订阅 `message.verification` |
| 重要邮件提醒 | 企业微信 / 钉钉 / 飞书群订阅 `message.important` |
| 审批 Agent 写的邮件 | 订阅 `draft.pending`，收到后打开网页审批 |
| 邮箱掉线提醒 | 订阅 `account.error`（授权码过期、密码修改后会触发） |
| 每天早上看日报 | 订阅 `report.daily` |
| 某个发件人单独提醒 | 新建收信规则，条件写发件人，动作选「推送通知」 |
