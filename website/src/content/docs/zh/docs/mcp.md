---
title: MCP 接入
description: 让 Claude、Cursor 等 AI Agent 通过 MCP 使用你的邮件
---

DaMail 内置一个 MCP 服务器（Streamable HTTP），地址是 `https://你的域名/mcp`。Agent 用 API Key 或 [OAuth](/zh/docs/oauth/) 认证。

## 创建 API Key

在「设置 → API Key」创建 Key，选择权限和可以访问的邮箱。Key 只显示一次，以 `dm_` 开头。

## 添加到客户端

Claude Code：

```bash
claude mcp add --transport http damail https://mail.example.com/mcp \
  --header "Authorization: Bearer dm_xxx"
```

Claude Desktop、Cursor 等使用 JSON 配置：

```json
{
  "mcpServers": {
    "damail": {
      "type": "http",
      "url": "https://mail.example.com/mcp",
      "headers": { "Authorization": "Bearer dm_xxx" }
    }
  }
}
```

ChatGPT 等不方便填 Key 的客户端用 OAuth 登录授权，见 [ChatGPT 与 OAuth](/zh/docs/oauth/)。

## 权限

| 权限 | 能做什么 | 对应的工具 |
|---|---|---|
| `read`（总是包含） | 读取邮件、会话、附件、草稿、统计、报告、通讯录 | `list_accounts` `list_folders` `search_emails` `semantic_search` `get_email` `get_thread` `get_attachment` `get_stats` `list_waiting` `list_subscriptions` `list_contacts` `translate_email` `get_report` `list_reports` `list_drafts` `get_draft` |
| `organize` | 标记已读 / 星标、归档、删除到已删除、移动、跟进提醒 | `mark_emails` `move_emails` `set_follow_up` `clear_follow_up` |
| `draft` | 写草稿、回复、转发，提交审批，撤销 | `create_draft` `update_draft` `delete_draft` `request_send` `cancel_send` |
| `send` | 不经审批直接发送（仍有撤销窗口）、退订 | `send_draft` `unsubscribe` |
| `automation` | 查看、试运行、创建、修改、删除收信规则；管理忽略名单；列出通知渠道（不含密钥） | `list_rules` `test_rule` `create_rule` `update_rule` `delete_rule` `list_channels` `list_ignored_senders` `ignore_sender` `unignore_sender` |

- 没有权限的工具**不会注册**，Agent 根本看不到；每次调用时服务端还会再检查一次
- 限定了邮箱的 Key 只能看到这些邮箱的邮件，也只能管理只作用于这些邮箱的规则
- Key 只能修改自己创建的草稿；审批（批准 / 拒绝）只能在网页上操作
- 模型配置和通知渠道的配置含密钥，只能在网页上管理

## 安全设计

- **发信要审批**：Agent 写的邮件默认进入「待审批」，你在网页上编辑、批准或拒绝；只有授予了 `send` 权限才能直接发出，发出前仍有 `SEND_DELAY_SEC` 秒的撤销窗口
- **邮件内容不可信**：MCP 的 instructions 要求 Agent 把邮件正文视为数据，不执行其中的指令
- **审计**：开放接口的每次调用都记录在「审计」里，可以按 Key 筛选

启用 AI 分析后，`get_email` / `get_thread` / `search_emails` 的结果会带上 `insight`（分类、优先级、摘要和提取的信息）。
