---
title: Upgrading
description: Upgrade to a new version, and the in-app update notice
---

## Upgrade

If you installed with the script, run the install command again from the same folder. Your `.env` is left untouched:

```bash
curl -fsSL https://damail.app/install.sh | sh
```

Or run this in the folder with `docker-compose.yml`:

```bash
docker compose pull && docker compose up -d
```

Database migrations run on startup. Back up the database before upgrading.

To pin a version, set it in `.env`:

```ini
DAMAIL_VERSION=v0.2.0
```

See [GitHub Releases](https://github.com/gopkg-dev/damail/releases) for what changed in each version, or **Settings → About → Changelog** in the app.

## Update notice

Every 6 hours the server checks GitHub for the latest stable release (pre-releases are ignored), and all users share the result. When a newer version is out:

- each device gets one “Update available” notification
- the Settings icon, the Changelog menu item and the version in the avatar menu show a red dot
- the top of the Changelog page shows the new release notes and the upgrade command, with a “Check for updates” button

After you deploy a new version, the first visit also shows “Updated to vX”.

For offline deployments, or if you don’t want to contact GitHub, set `UPDATE_CHECK=false`. If GitHub is unreliable from your server, use `UPDATE_CHECK_PROXY_ID` to go through a proxy.

:::note[Why there is no one-click upgrade]
Upgrading from the web app would require the container to control the host’s Docker, which is too much power. Use [Watchtower](https://containrrr.dev/watchtower/) if you want automatic upgrades.
:::
