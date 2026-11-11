---
title: REST API
description: REST API、收信规则格式和 Webhook
---

所有接口都接受 `Authorization: Bearer <API Key>`，也可以用网页登录态访问。权限要求和 [MCP](/docs/mcp/#权限) 一致，括号里标注了需要的权限。

## 邮件

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/accounts` | 邮箱列表、状态、未读数 |
| GET | `/api/v1/folders?account=` | 文件夹 |
| GET | `/api/v1/threads?view=&account=&folder=&q=&cursor=` | 会话列表，`view` 为 `inbox` `important` `unread` `starred` `sent` `all` |
| GET | `/api/v1/threads/:threadId` | 会话详情 |
| GET | `/api/v1/messages?q=&account=&cursor=&limit=` | 扁平邮件搜索 |
| GET | `/api/v1/messages/:id?format=text` | 邮件详情 |
| GET | `/api/v1/messages/:id/attachments/:index` | 附件下载 |
| GET | `/api/v1/messages/:id/raw` | 原始 .eml |
| POST | `/api/v1/search/semantic` | `{q, limit?}` 自然语言搜索（需启用 AI） |
| POST | `/api/v1/threads/batch` | `{threadIds, action}`，`read` `unread` `star` `unstar` `archive` `trash`（organize） |
| POST | `/api/v1/threads/mark-read` | `{view?, account?, folder?, q?}` 把筛选结果全部标为已读（organize） |
| POST | `/api/v1/messages/batch` | `{ids, action, folderId?}`，另支持 `junk` `inbox` `move`（organize） |
| GET | `/api/v1/stats` | 概况 |
| GET | `/api/v1/analytics?days=7\|30\|90\|365` | 分析看板数据 |
| GET | `/api/v1/reports?kind=daily\|weekly` | 日报 / 周报列表 |
| GET | `/api/v1/reports/:id` | 报告详情 |
| GET | `/api/v1/contacts?q=` | 联系人 |
| GET | `/api/v1/subscriptions?days=&filter=&page=&pageSize=&sort=&order=` | 订阅发件人，分页 |
| GET | `/api/v1/events` | SSE：`messages.new` `messages.updated` `account.status` `drafts.updated` |

## 草稿与发信

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/drafts?status=&thread=` | 草稿与发件记录 |
| GET | `/api/v1/drafts/:id` | 草稿详情，`preview` 为最终发出的纯文本 |
| POST | `/api/v1/drafts` | `{mode, sourceMessageId?, accountId?, to, cc, bcc, subject, body, includeQuote}`，`mode` 为 `new` `reply` `replyAll` `forward`（draft） |
| PATCH / DELETE | `/api/v1/drafts/:id` | 修改 / 删除草稿（draft） |
| POST / DELETE | `/api/v1/drafts/:id/attachments[/:index]` | 上传（multipart，字段 `file`）/ 删除附件（draft） |
| POST | `/api/v1/drafts/:id/submit` | 提交审批（draft） |
| POST | `/api/v1/drafts/:id/send` | 放入发送队列 `{delaySec?, sendAt?}`（send） |
| POST | `/api/v1/drafts/:id/cancel` | 撤销发送（draft） |
| POST | `/api/v1/drafts/:id/reject` | 拒绝待审批邮件（仅网页登录态） |

## 收信规则

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / POST | `/api/v1/rules` | 规则列表 / 创建（automation） |
| GET / PATCH / DELETE | `/api/v1/rules/:id` | 规则详情 / 修改 / 删除（automation） |
| POST | `/api/v1/rules/test` | 试运行，返回会命中的邮件，不执行动作（automation） |
| POST | `/api/v1/rules/reorder` | `{ids}` 调整执行顺序（automation） |
| GET | `/api/v1/channels` | 通知渠道列表，不含配置（automation） |

规则格式：

```json
{
  "name": "验证码推送到手机",
  "accountIds": null,
  "match": "all",
  "conditions": [{ "field": "has_code", "op": "is", "value": true }],
  "actions": [{ "type": "notify", "channelId": 1 }, { "type": "mark_read" }],
  "stopProcessing": false
}
```

- `field`：`from` `to` `subject` `body` `any`（`op`：`contains` `not_contains` `equals` `regex`）；`category` `priority` `has_attachment` `unread` `needs_reply` `has_code`（`op`：`is` `is_not`）
- `type`：`notify`（`channelId`）`mark_read` `star` `archive` `move`（`folderId`）`junk` `trash` `ai_reply`（`instruction`）

## Webhook

自定义 Webhook 渠道以 `POST` 发送 JSON：

```json
{ "event": "message.verification", "title": "...", "body": "...", "url": "...", "copy": "382916", "data": {}, "timestamp": "2026-11-12T08:00:00.000Z" }
```

请求头带 `x-damail-event`。填写了密钥时还会带 `x-damail-signature: sha256=<hex>`，接收方用同一密钥对**原始请求体**做 HMAC-SHA256 校验：

```js
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-damail-signature']))) reject();
```

事件列表见[通知渠道](/docs/automation/notifications/#可订阅的事件)。
