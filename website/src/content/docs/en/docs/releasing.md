---
title: Releasing
description: How maintainers publish a new version
---

A version is a git tag (`v0.2.0`), and its release notes are the tag message. A release goes like this:

1. A maintainer runs `pnpm release 0.2.0`: checks, writes the notes, creates an annotated tag and pushes it
2. GitHub Actions picks up the tag:
   - runs type checks and server tests, and stops on failure
   - builds and pushes `ghcr.io/gopkg-dev/damail` tagged `v0.2.0`, `0.2.0`, `0.2` and `latest`
   - creates a GitHub Release from the tag message
3. Running DaMail instances see the new release and show “Update available”

## The release command

```bash
pnpm release 0.2.0          # or patch / minor / major to bump the latest version
```

It will:

1. Check that you are on `main` with a clean tree, not behind `origin/main`, and the version is newer than existing tags
2. Run `pnpm typecheck` and `pnpm test` (needs the local dev database)
3. Open your editor with a draft listing the commits since the last version
4. Preview the GitHub Release body, then create the annotated tag and push `main` and the tag

Options: `--notes <file>` (use prepared notes, no editor), `--dry-run` (check and preview only), `--no-push` (local tag only), `--skip-checks`, `--yes`.

## Writing release notes

```txt
DaMail v0.2.0

This release adds a release pipeline and update notifications.

New
- Release command: pnpm release
- In-app notice when a new version is available

Fixed
- Newsletter list was cut off beyond 300 senders
```

- The first line is the title (with the version) and becomes the GitHub Release title
- Lines without `- ` are the intro; a line followed by `- items` is a section title
- To ship both languages, write each section twice: lines with Chinese characters count as Chinese, the rest as English, and the app shows the one matching the UI language
- Lines starting with `#` are ignored

The in-app changelog, the GitHub Release and the update notice all use these same notes.

## Pre-releases

`pnpm release 0.3.0-beta.1` builds the image as usual (without updating `latest`), marks the GitHub Release as a pre-release, and does not notify users.
