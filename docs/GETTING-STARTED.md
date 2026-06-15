# Getting Started

This page covers the full CLI command reference, how to onboard new source
folders into `obsync.yml`, and the day-to-day workflow once obsync is set up.

For initial install and first-run steps, see the
[Quick Start](../README.md#quick-start) section of the README.

## CLI Commands

| Command | Description |
|---------|-------------|
| `obsync sync` | Copy changed .md files from all sources into the vault |
| `obsync sync --dry-run` | Preview what would change without writing |
| `obsync sync --verbose` | Show per-file details during sync |
| `obsync sync --no-ai` | Sync without triggering any AI summarization |
| `obsync watch` | Watch source folders and sync automatically on save |
| `obsync watch --no-ai` | Watch and sync without AI summarization |
| `obsync status` | Show last sync time, file counts, and pending changes |
| `obsync init` | Create a new obsync.yml config file |
| `obsync add <path>` | Interactively add a single folder as a new source |
| `obsync discover <root>` | Scan `<root>`'s subfolders for candidate sources and add selected ones |
| `obsync install-service` | Install a background service that runs `obsync watch` — see [PLATFORM-SERVICE.md](PLATFORM-SERVICE.md) |
| `obsync uninstall-service` | Remove the background service — see [PLATFORM-SERVICE.md](PLATFORM-SERVICE.md) |
| `obsync service status` | Show whether the background service is running — see [PLATFORM-SERVICE.md](PLATFORM-SERVICE.md) |

## Onboarding

Before the daily workflow, get your sources into `obsync.yml`:

- **`obsync discover <root>`** — scan the immediate subfolders of `<root>`
  for folders containing `.md` files, and interactively add the ones you
  pick (each gets an auto-detected name/category/scan mode you confirm or
  edit). `<root>` should be the *parent* of the project folders you want as
  sources, e.g. `obsync discover ~/Dev/Personal`, not `~/Dev` or `~`.
- **`obsync add <path>`** — add one specific folder as a source, with the
  same interactive confirmation.

Nothing is written to `obsync.yml` without your confirmation per candidate.

## Daily Workflow

obsync is designed to run in the background, not as a manual checklist:

1. **Run `obsync watch` continuously**, either:
   - manually (e.g. in a terminal tab or tmux pane), or
   - as a background service via `obsync install-service` (macOS via launchd,
     Linux via systemd --user — starts on login and survives terminal close;
     check with `obsync service status`, remove with `obsync uninstall-service`).
     See [PLATFORM-SERVICE.md](PLATFORM-SERVICE.md) for per-OS setup,
     including Windows.

   Every time you save a markdown file in a configured source, obsync
   copies it into the vault — with labels, frontmatter, and an AI summary
   callout (if enabled) — within a few seconds.
2. **Edit your source files as you normally would.** There's nothing extra
   to remember — no separate "publish" step.
3. **Treat the vault's generated pages as reference surfaces, not a daily
   checklist:**
   - `_dashboard/Home.md` — a snapshot of the last sync: source summaries,
     recent activity, and links to label index pages. Open it when you want
     a quick overview of what changed recently.
   - `_index/*.md` — per-label pages linking every file tagged with that
     label. Open one when you're looking for "everything related to X."
   - `_changelog/` — a dated history of what was added/updated/unchanged
     per sync run. Useful for "what changed since last week," not something
     to read every day.

If `obsync watch` isn't running, run `obsync sync` manually before relying on
the vault being up to date.

## Configuration

For details on `obsync.yml` fields (sources, AI backend, ignore patterns,
labels), see [CONFIGURATION.md](CONFIGURATION.md).

## Troubleshooting

If obsync reports an error on startup or during sync, see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common error messages and fixes.
