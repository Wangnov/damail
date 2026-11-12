---
title: 接入邮箱
description: 各家邮箱的授权方式，以及 Gmail / Outlook 的 OAuth2 配置
---

在「设置 → 邮箱管理」添加邮箱。选好服务商后，IMAP / SMTP 服务器会自动填好，只需要填邮箱地址和授权码。

## 各家邮箱的凭证

| 服务商 | 凭证 | 说明 |
|---|---|---|
| QQ 邮箱 | 授权码 | 设置 → 账号 → 开启 IMAP/SMTP → 生成授权码 |
| 163 / 126 | 授权码 | 设置 → POP3/SMTP/IMAP → 开启 IMAP → 新增授权密码（DaMail 会自动发送 IMAP ID，避免 Unsafe Login） |
| Gmail / Google Workspace | 应用专用密码或 OAuth2 | 直连需要先开启两步验证；也可以用 OAuth2 登录，见下文 |
| iCloud | App 专用密码 | 在 account.apple.com 生成 |
| 腾讯 / 阿里 / 网易企业邮 | 密码或客户端专用密码 | 视企业安全设置而定 |
| Outlook / Hotmail / Microsoft 365 | OAuth2 | 需要先配置 Microsoft 应用，见下文 |
| 其他 | 密码 | 选「其他 IMAP」，手动填写服务器和端口 |

新添加的邮箱默认同步「收件箱」「已发送」「草稿箱」「垃圾邮件」和「已删除」，其他文件夹可以在邮箱的「文件夹」里单独开启。首次添加时按天数回溯历史邮件，从新到旧下载，中断后能续传。

服务器直连不了邮箱（例如国内服务器连 Gmail）时，可以在「设置 → 代理设置」添加 HTTP / SOCKS 代理，再在邮箱设置里选用，详见[代理设置](/zh/docs/proxies/)。

## Outlook / Microsoft 365（OAuth2）

1. 在 [Microsoft Entra 应用注册](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) 新建应用，账户类型选「任何组织目录中的账户和个人 Microsoft 账户」
2. 重定向 URI 选 Web，填 `${PUBLIC_URL}/api/oauth/microsoft/callback`（必须 HTTPS，localhost 除外）
3. 在「证书和密码」新建客户端密码
4. 「API 权限」添加 Microsoft Graph 委托权限：`offline_access` `Mail.ReadWrite` `Mail.Send` `User.Read`
5. 在 DaMail「设置 → 授权应用」填入 Client ID 和密码，然后添加邮箱时选 Outlook，点「登录并授权」

微软邮箱通过 Graph API 收发信（部分个人账号 IMAP 能登录却打不开邮箱），新邮件每分钟检查一次；单封邮件含附件不能超过 4MB。

## Gmail / Google Workspace（OAuth2）

1. 在 [Google Cloud 控制台](https://console.cloud.google.com/auth/clients) 新建或选择项目
2. 「Google Auth Platform」完成品牌信息，受众选「外部」
3. 「数据访问」添加范围 `https://mail.google.com/`
4. 「客户端」新建 OAuth 客户端，类型选「Web 应用」，已获授权的重定向 URI 填 `${PUBLIC_URL}/api/oauth/google/callback`
5. 在 DaMail「设置 → 授权应用」填入客户端 ID 和密钥，然后添加邮箱时选 Gmail 并用 Google 账号登录

:::note
应用处于「测试」状态时只有测试用户能授权，且授权 7 天后失效。个人使用可以发布为正式版，授权时提示「未经验证」，点继续即可。
:::

## 同步行为

- 收件箱通过 IMAP IDLE 实时推送，新邮件 1 秒内入库；其他文件夹按轮询间隔检查
- 已读、星标、删除会从服务器同步回来；在 DaMail 里的已读、星标、归档、删除、移动也会写回服务器
- 删除只移到「已删除」，不会永久删除
- 断线后按指数退避自动重连
