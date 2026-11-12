---
title: 升级
description: 升级到新版本，以及网页上的新版本提示
---

## 升级

用一键脚本安装的，在原来的目录再运行一次安装命令即可（`.env` 不会被改动）：

```bash
curl -fsSL https://damail.app/install.sh | sh
```

或者在 `docker-compose.yml` 所在目录执行：

```bash
docker compose pull && docker compose up -d
```

数据库迁移在启动时自动执行。升级前建议先备份数据库。

想固定在某个版本，在 `.env` 里写：

```ini
DAMAIL_VERSION=v0.2.0
```

每个版本的变化见 [GitHub Releases](https://github.com/gopkg-dev/damail/releases)，网页上「设置 → 关于 → 更新日志」也能看到。

## 新版本提示

DaMail 服务端每 6 小时读一次 GitHub 上最新的正式版本（预发布版本不算），所有用户共用这一份结果。有新版本时：

- 每台设备弹一次「有新版本」通知
- 设置图标、「更新日志」菜单和头像菜单的版本号上挂红点
- 更新日志页顶部显示新版本的更新说明和升级命令，也能手动「检查更新」

部署了新版本后第一次打开网页，还会提示一次「已更新到 vX」。

内网部署或不想访问 GitHub 时，在 `.env` 里设置 `UPDATE_CHECK=false`；服务器访问 GitHub 不稳定时，可以用 `UPDATE_CHECK_PROXY_ID` 指定代理。

:::note[为什么没有一键升级]
网页上一键升级需要让容器控制宿主机的 Docker，权限太大。需要自动升级的话可以自己配 [Watchtower](https://containrrr.dev/watchtower/)。
:::
