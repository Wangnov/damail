---
title: 搜索语法
description: 搜索框支持的条件
---

搜索框支持以下条件，可以组合使用，其余文字按全文关键词处理（中文关键词也能搜到）：

| 条件 | 示例 | 说明 |
|---|---|---|
| `from:` | `from:alice@example.com` | 发件人 |
| `to:` | `to:me@example.com` | 收件人 |
| `subject:` | `subject:发票` | 主题 |
| `account:` | `account:gmail` | 邮箱地址、名称或服务商 |
| `folder:` | `folder:sent` | `inbox` `sent` `junk` `trash` 或文件夹名称 |
| `is:` | `is:unread` | `unread` `read` `starred` `answered` |
| `has:attachment` | | 带附件 |
| `after:` / `before:` | `after:2026-10-01` | 日期范围 |
| `label:` | `label:客户` | 标签 |
| `"..."` | `"季度预算"` | 精确短语 |
| `-` | `-广告` | 排除关键词 |

启用 AI 分析后还可以用：

| 条件 | 说明 |
|---|---|
| `category:` | `finance` `work` `personal` `verification` `shipping` 等分类 |
| `priority:` | `high` `normal` `low` |
| `is:needs-reply` | 需要回复 |
| `has:code` | 含验证码 |

中文写法也可以用，例如 `发件人:`、`未读`，提交时会自动换成上面的语法。

想用自然语言搜索时，点搜索框旁的「AI 搜索」，见 [AI 搜索](/zh/docs/ai/search/)。
