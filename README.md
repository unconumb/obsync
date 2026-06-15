# obsync

A local-first CLI tool that transforms scattered markdown documentation from multiple project and personal folders into an organized, visually navigable knowledge base inside Obsidian — with AI-powered summaries, intent-based categorization, auto-generated index pages, and a live dashboard. All processing is local by default; no data leaves the machine.

## Quick Start

```bash
git clone https://github.com/unconumb/obsync.git
cd obsync
npm install && npm run build && npm install -g .
obsync init
obsync sync
```

> A scoped npm package is planned — for now, install from source as above.

`obsync init` writes a starter `obsync.yml` (600 permissions) — edit it with
your vault path and source folders before running `obsync sync`. Already have
sources to add? `obsync discover ~/Dev/Personal` (or `obsync add <path>`) can
scan a folder and add matching sources interactively.

## What is obsync?

obsync watches markdown documentation across your project and personal
folders and syncs it into an Obsidian vault — organized by category, indexed
by label, with a generated dashboard and changelog. Optional AI summaries
(local via Ollama by default, or Claude/OpenAI if configured) add a short
callout to each synced file. Nothing leaves your machine unless you opt in to
an external AI backend.

## Configuration

`obsync.yml` defines your vault path, source folders, and AI backend. See
[docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full reference,
including `sources[]` fields (`scan`, `docs_path`, `ai_ignore`, `labels`),
global ignore patterns, and `ai.backend` options (`ollama | claude | openai |
none`).

## CLI Commands, Onboarding & Daily Workflow

obsync is designed to run continuously in the background via `obsync watch`
(or as an installed service — see below), syncing files as you save them. See
[docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) for the full CLI command
reference, onboarding with `obsync add`/`discover`, and the recommended daily
workflow (dashboard, label indexes, changelog).

## Architecture

For a top-down overview of how the sync engine, output adapters, AI
providers, and state/audit files fit together, see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Running as a Background Service

obsync can run `obsync watch` continuously without an open terminal — via
`launchd` on macOS or `systemd --user` on Linux, starting on login and
restarting automatically if it stops. See
[docs/PLATFORM-SERVICE.md](docs/PLATFORM-SERVICE.md) for per-OS setup
(including Windows).

## Troubleshooting

For common error messages (config permissions, missing API keys, service
setup issues) and their fixes, see
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Security

- API keys are loaded from environment variables or `.env` only — never from `obsync.yml`
- Config file is created with 600 permissions (owner read/write only)
- All vault writes are atomic (write-to-temp, then rename)
- No telemetry, analytics, or update checks

## Requirements

- Node.js >= 20.0.0
- npm >= 8.0.0
- Ollama (optional, for AI summaries): https://ollama.ai

## Support

obsync is free and open source. If it's useful to you, you can support
ongoing development at [buymeacoffee.com/gentoodelic](https://buymeacoffee.com/gentoodelic).
