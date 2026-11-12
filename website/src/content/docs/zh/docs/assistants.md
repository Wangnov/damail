---
title: 接入 AI 助手
description: 把 DaMail 接入 Claude Duet、ChatGPT dots、Grok Bot、Meta Muse 等主动型 AI 助手，让它们帮你管理邮件
---

Claude Duet、ChatGPT dots、Grok Bot、Meta Muse 这类**主动型 AI 助手**会在后台持续工作：早上给你简报，提醒哪些邮件需要处理，替你起草回复等你确认。它们都支持通过「自定义连接器」接入远程 MCP 服务器，所以接上 DaMail 后，你所有邮箱里的邮件都能交给它们打理。

DaMail 对它们来说就是一个标准的 MCP 服务器：

| 项目 | 值 |
|---|---|
| 服务器地址 | `https://mail.example.com/mcp` |
| 认证方式 | OAuth（登录 DaMail 后在同意页授权） |
| 可授予的权限 | `mail:read`、`mail:organize`、`mail:draft`、`mail:send` |

:::tip[接入后能做什么]
- 每天早上汇总新邮件：哪些重要、哪些要回复、有哪些验证码和账单
- 找出等你回复的邮件，起草回复放进「待审批」，你在 DaMail 或助手里确认后再发
- 按你的话整理邮件：标记已读、加星标、归档、设置跟进提醒
- 跨所有邮箱搜索，例如“上个月所有发票”“和张三关于合同的往来”
:::

## 准备 DaMail

所有助手都需要先完成这三步：

1. DaMail 通过 HTTPS 对外访问，`PUBLIC_URL` 以 `https://` 开头。这些助手运行在云端，必须能从公网访问到你的 DaMail
2. 在「设置 → OAuth 设置」打开启用
3. 把助手添加为允许的客户端。按助手页面上提供的信息选择方式：
   - **元数据文档（CIMD）**：页面提供了「客户端元数据 URL」时，填入后点读取，勾选与页面一致的回调地址
   - **预注册客户端**：页面让你填写 OAuth Client ID 时，在 DaMail 自定义一个 Client ID（如 `claude-duet`），填上助手页面显示的回调地址，再把同一个 Client ID 填回助手

详细说明和自检命令见 [ChatGPT 与 OAuth](/zh/docs/oauth/)。

## 服务器放在哪里

助手和 DaMail 之间有两个方向的连接，要求不一样：

| 方向 | 做什么 | 要求 |
|---|---|---|
| 助手 → DaMail | 助手的云端调用 `https://你的域名/mcp`，打开 DaMail 的登录和同意页 | DaMail 要有公网可访问的 HTTPS 地址，**代理帮不上** |
| DaMail → 外部 | 读取客户端元数据（如 `chatgpt.com`）、同步 Gmail 等邮箱、检查更新 | 直连不了时，用「设置 → 代理设置」里的代理 |

所以服务器放在哪里都可以：

- **海外或香港的服务器**：最省事，两个方向都能直连，不需要代理
- **国内服务器**：出站在「设置 → 代理设置」添加[代理](/zh/docs/proxies/)，再在「OAuth 设置」的代理选择和邮箱设置里选用；入站用 80 / 443 端口对外提供网站需要域名备案
- **家里或公司内网的机器**：用 Cloudflare Tunnel 这类内网穿透工具提供一个公网 HTTPS 地址，把它填进 `PUBLIC_URL`

## Claude Duet

Claude Duet 使用你 Claude 账号里的连接器，在 Claude 中添加一次 DaMail，Duet 就能用。

1. 打开 claude.ai → 设置 → 连接器 → 添加自定义连接器
2. 名称填 `DaMail`，URL 填 `https://mail.example.com/mcp`
3. 展开「高级设置」，按上面的方式在 DaMail 添加客户端。Claude 的回调地址通常是 `https://claude.ai/api/mcp/auth_callback`，以页面显示为准
4. 点连接，跳到 DaMail 登录，在同意页选择权限和邮箱后允许
5. 在 Duet 里直接说“每天早上帮我看看有哪些邮件要回复”即可

## ChatGPT dots

dots 运行在 ChatGPT 里，使用你在 ChatGPT 中已连接的应用。

1. 按 [ChatGPT 与 OAuth](/zh/docs/oauth/) 在 ChatGPT 中添加 DaMail 并完成授权
2. 打开 dots，让它使用 DaMail，例如“有重要邮件时提醒我，并起草回复”

## Grok Bot

1. 打开 grok.com → 连接器 → 添加自定义连接器
2. URL 填 `https://mail.example.com/mcp`，认证方式选 OAuth
3. 按 Grok 页面显示的回调地址在 DaMail 添加客户端
4. 连接后在 DaMail 登录并授权，之后就能在 Grok Bot 里让它处理邮件，也可以配合 Routines 定时执行

## Meta Muse

1. 打开 Muse → Settings → Connectors → Add custom connector
2. 粘贴 `https://mail.example.com/mcp`
3. 按 Muse 页面显示的回调地址在 DaMail 添加客户端
4. Muse 会打开 DaMail 的登录页，登录并允许后即可使用

## 其他助手

只要客户端支持「远程 MCP + OAuth」，都可以按上面的方式接入。支持填写请求头的客户端（Claude Code、Cursor、Claude Desktop 等）也可以直接用 API Key，见 [MCP 接入](/zh/docs/mcp/)。

## 安全建议

- **先给只读权限**：初次接入只勾选 `mail:read`，确认助手的表现后再授予 `mail:draft`
- **发信先审批**：不授予 `mail:send` 时，助手写的邮件只会进入「草稿 → 待审批」，由你确认后才发出。授予后每小时直接发送的数量也有上限
- **限定邮箱**：在同意页只勾选需要交给助手的邮箱，其他邮箱的邮件它完全看不到
- **随时撤销**：在「设置 → OAuth 授权」能看到每个助手的授权和最近使用时间，撤销后立即失效
- **有据可查**：助手的每次调用都记录在「审计」里

通过 OAuth 接入的助手不能修改收信规则、通知渠道，也不能退订邮件，这些只能在 DaMail 网页上操作。
