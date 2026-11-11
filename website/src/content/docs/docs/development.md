---
title: 本地开发
description: 搭建开发环境、项目结构和测试
---

## 环境

需要 Node 22+、pnpm 和 Docker。

```bash
git clone https://github.com/gopkg-dev/damail.git && cd damail
cp .env.example .env
docker compose -f docker-compose.dev.yml -p damail-dev up -d   # PostgreSQL + GreenMail 测试邮箱
pnpm install
pnpm dev                                                         # 后端 :8787，前端 :5180
```

打开 http://localhost:5180，第一次访问时创建管理员账号。

## 用测试邮箱体验

GreenMail 预置了 `alice` / `alice-pass`、`bob` / `bob-pass` 两个账号。添加邮箱时服务商选「其他 IMAP」，服务器填 `127.0.0.1`，端口 `3143`，关闭 SSL。投递一批测试邮件：

```bash
pnpm --filter server exec tsx scripts/seed-greenmail.ts alice@local.test
```

## 检查

```bash
pnpm typecheck   # 服务端和前端的类型检查
pnpm test        # 服务端集成测试，使用独立的 damail_test 数据库
```

测试只访问本机数据库，不连真实邮箱、不访问外网、不发信。

## 项目结构

```txt
server/                 Hono + Drizzle + imapflow
  src/sync/             同步引擎：IDLE、增量、标记、删除检测、服务商预设
  src/services/         入库与会话归并、查询、整理回写、草稿与审批、发信、
                        任务队列、AI 分析、规则、通知、报告
  src/api/              网页后台和 REST API
  src/mcp/              MCP 服务器（无状态 Streamable HTTP）
  src/oauth/            MCP OAuth 授权服务器
  drizzle/              数据库迁移
  test/                 集成测试
web/                    React + Ant Design + TanStack Query
website/                官网和文档（Astro + Starlight）
```

## 官网

官网是独立的 pnpm 工作区：

```bash
cd website
pnpm install
pnpm dev        # http://localhost:4321/
```

首页在 `website/src/pages`，文档在 `website/src/content/docs`（中文在根目录，英文在 `en/`）。推送到 `main` 后由 GitHub Actions 部署到 GitHub Pages。

## 提交规范

提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/)：`type(scope): summary`，例如 `feat(mail): add unread filter to thread list`、`fix(sync): reconnect after IDLE timeout`。
