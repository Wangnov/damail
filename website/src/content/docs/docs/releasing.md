---
title: 发布版本
description: 维护者如何发布新版本
---

版本号就是 git 标签（`v0.2.0`），更新说明就是标签附注。一次发布：

1. 维护者执行 `pnpm release 0.2.0`：检查、写更新说明、打附注标签并推送
2. GitHub Actions 收到标签后：
   - 跑类型检查和服务端测试，失败就停
   - 构建镜像推到 `ghcr.io/gopkg-dev/damail`：`v0.2.0`、`0.2.0`、`0.2`、`latest`
   - 用标签附注创建 GitHub Release
3. 各处部署的 DaMail 读到新 Release，提示「有新版本」

## 发布命令

```bash
pnpm release 0.2.0          # 或 patch / minor / major，在最新版本上加一
```

依次会：

1. 检查：在 `main` 分支、工作区干净、不落后 `origin/main`、版本号比现有标签新
2. 跑 `pnpm typecheck` 和 `pnpm test`（需要本地开发数据库）
3. 打开编辑器写更新说明，草稿里已经列好上个版本以来的提交
4. 预览 GitHub Release 正文，确认后打附注标签，推送 `main` 和标签

常用选项：`--notes 文件`（用写好的说明，不开编辑器）、`--dry-run`（只检查和预览）、`--no-push`（只打本地标签）、`--skip-checks`、`--yes`。

## 更新说明的写法

```txt
DaMail v0.2.0

这个版本加了版本发布流程和新版本提示。

新功能
- 发布命令 pnpm release
- 有新版本时在网页上提示

修复
- 订阅列表超过 300 个发件人时显示不全
```

- 第一行是标题（含版本号），作为 GitHub Release 的标题
- 不带 `- ` 的行是简介，紧跟着 `- 要点` 的那行是小节标题
- 想同时写英文就再写一份：含中文的行算中文、其余算英文，界面按语言显示对应的那份
- 以 `#` 开头的行会被忽略

网页里的「更新日志」、GitHub Release 正文和新版本提示用的都是这一份说明。

## 预发布

`pnpm release 0.3.0-beta.1`：照样构建镜像（不更新 `latest`），Release 标记为预发布，不会提示给用户。
