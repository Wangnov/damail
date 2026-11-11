---
title: 快速开始
description: 用 Docker Compose 部署 DaMail
---

## 准备

- 一台能长期运行的服务器，装好 Docker 和 Docker Compose
- 一个域名和 HTTPS 反向代理（Caddy / Nginx 等）；只在本机试用可以跳过

:::tip[服务器放在哪里]
国内服务器连不上 Gmail；海外服务器登录 QQ / 163 可能触发异地登录风控。国内外邮箱混用时，建议放在香港、新加坡或日本。
:::

## 1. 下载配置

```bash
mkdir damail && cd damail
curl -O https://raw.githubusercontent.com/gopkg-dev/damail/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/gopkg-dev/damail/main/.env.example
```

编辑 `.env`，至少填好这几项：

```ini
# openssl rand -hex 32 生成
MASTER_KEY=
POSTGRES_PASSWORD=换成一个强密码
PUBLIC_URL=https://mail.example.com
# 通过 HTTPS 访问时设为 true
COOKIE_SECURE=true
```

:::caution[务必备份 MASTER_KEY]
邮箱授权码用它加密保存。丢失后已保存的授权码无法解密，只能逐个重新填写。
:::

## 2. 启动

```bash
docker compose pull && docker compose up -d
```

镜像来自 `ghcr.io/gopkg-dev/damail`（linux/amd64、linux/arm64）。数据库迁移在启动时自动执行。默认只监听 `127.0.0.1:8787`。

## 3. 配置反向代理

把域名代理到 `http://127.0.0.1:8787`，并开启 HTTPS。反向代理**必须关闭缓冲**，否则实时刷新和 MCP 会卡住。

Caddy：

```txt
mail.example.com {
  reverse_proxy 127.0.0.1:8787 {
    flush_interval -1
  }
}
```

Nginx：

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;
  proxy_read_timeout 1h;
}
```

## 4. 开始使用

1. 打开 `https://mail.example.com`，第一次访问时创建管理员账号
2. 在「设置 → 邮箱管理」添加邮箱，见[接入邮箱](/docs/mailboxes/)
3. 需要 AI 功能时，在「智能 → 模型配置」配置模型，见[模型配置](/docs/ai/models/)
4. 给 Agent 用：在「设置 → API Key」创建 Key，见 [MCP 接入](/docs/mcp/)

## 备份

需要备份的是：PostgreSQL 数据卷（`db-data`）、DaMail 数据卷（`app-data`，原始邮件和附件）以及 `.env`。
