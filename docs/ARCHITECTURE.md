# Architecture

## What is obsync?

obsync is a local-first CLI tool that copies markdown files from one or more
source folders (project repos, notes folders, runbook directories) into an
Obsidian vault. On the way in, it organizes files into category folders,
injects frontmatter (sync metadata, labels, optional AI summaries), and
generates navigation pages (a dashboard, per-label index pages, and a
changelog) so the vault stays a useful, browsable knowledge base instead of a
pile of copied files.

## High-Level Data Flow

```
source folders  --->  Sync Engine  --->  Obsidian vault
 (configured in        (scan, diff,        (via OutputAdapter)
  obsync.yml)           copy, frontmatter,
                        AI summarize)
```

1. **Source folders** are configured in `obsync.yml` (`sources[]`) — each
   with a scan mode (`scattered` or `docs`), a category, and optional
   AI/label settings.
2. The **Sync Engine** scans each source, diffs against the previously-synced
   state, copies changed files, merges frontmatter, and (if enabled) queues
   files for AI summarization.
3. All vault writes go through an **OutputAdapter** — the engine itself never
   touches the filesystem of the vault directly. This keeps the engine
   reusable for future output targets beyond Obsidian.

## Component Breakdown

```
┌──────────────────────────────────────────────────────────────────┐
│  CLI (commander) — obsync sync / watch / add / discover / ...      │
├──────────────────────────────────────────────────────────────────┤
│  Sync Engine (runSync)                                              │
│    scanner → differ → copier → frontmatter → AI pipeline           │
│    depends on: OutputAdapter, AiProvider, StateFile                 │
├───────────────┬──────────────────────┬─────────────────────────────┤
│ OutputAdapter  │ AiProvider           │ State / Audit / Config       │
│ ObsidianAdapter│ OllamaProvider /     │ ~/.obsync/state.json          │
│ writeEntry()   │ ClaudeProvider /     │ ~/.obsync/audit.log           │
│ deleteEntry()  │ OpenAiProvider       │ obsync.yml (Zod-validated)    │
│                │ isAvailable()        │                               │
│                │ summarize()          │                               │
└───────────────┴──────────────────────┴─────────────────────────────┘
```

### CLI

Built with `commander`. Each subcommand (`sync`, `watch`, `status`, `init`,
`add`, `discover`, `install-service`, `uninstall-service`, `service status`)
lives under `src/cli/commands/`. See
[GETTING-STARTED.md](GETTING-STARTED.md) for the full command reference.

### Sync Engine

The core sync loop (`runSync`) ties everything together:

- **scanner** — walks each configured source according to its scan mode
  (`scattered` vs `docs` + `docs_path`), respecting `ignore` patterns.
- **differ** — compares the current scan against the previously-synced state
  to determine which files were added, updated, moved, removed, or unchanged.
- **copier** — copies changed files into the vault (through the
  `OutputAdapter`), injecting merged frontmatter.
- **AI pipeline** — for sources with `ai_summary: true`, queues eligible
  files for summarization (subject to redaction, smart triggers, and
  `ai_ignore` exclusions).

### OutputAdapter

The seam between the sync engine and the place files get written. The engine
never knows it is writing to Obsidian specifically — `ObsidianAdapter` is the
only current implementation, providing:

- `writeEntry(entry)` — write a file (with merged frontmatter + body) into the
  vault, atomically (write-to-temp, then rename).
- `deleteEntry(destinationPath)` — remove a previously-written vault file.

A future non-Obsidian output target would be a new adapter implementing the
same interface — the sync engine itself would not change.

### AiProvider

A pluggable interface for AI summarization, with three implementations:

- `OllamaProvider` — local inference via `http://localhost:11434`, the
  default and only backend that requires no API key.
- `ClaudeProvider` / `OpenAiProvider` — external API backends, opt-in via
  `ai.backend: claude` / `openai`, requiring `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` respectively.

Each provider implements:

- `isAvailable()` — fail-closed reachability check (never throws).
- `summarize(redactedText, model)` — returns a summary plus byte counts for
  audit logging.

`createAiProvider(aiConfig)` is the single factory choke point that selects a
backend based on `obsync.yml` and environment variables. All text is passed
through a redaction pass (stripping IPs, keys, tokens, PEM blocks) before
ever reaching `summarize()` — this applies identically regardless of backend.

### State and Audit

- **StateFile** (`~/.obsync/state.json`) — tracks per-file sync state via
  `FileStateEntry` records, keyed by `toStateKey(sourceName, relativePath)`.
  Used to detect adds/updates/moves/removals on the next sync.
- **AuditEntry** (`~/.obsync/audit.log`) — an append-only, content-free JSON
  Lines log of file operations and AI inference calls (timestamps, source
  names, byte counts — never file content).

### Shared Path Utilities

`src/utils/paths.ts` centralizes cross-platform path handling used throughout
the codebase:

- `expandHome` — expands `~` to the user's home directory.
- `isUnder` — checks whether a path is confined within a base directory
  (used to prevent writes escaping the vault).
- `toStateKey` — builds the stable per-file key used in `state.json`.
- `checkPathOverlap` — validates that source and vault paths don't overlap.
- `OBSYNC_TMP_SUFFIX` — the suffix used for atomic write-then-rename
  operations.

## Generated Vault Structure

Beyond copying source files, obsync generates navigation pages directly in
the vault:

- `_dashboard/Home.md` — a snapshot of the most recent sync (source
  summaries, recent activity, links to label index pages).
- `_index/<Label>.md` — one page per label, linking every file tagged with
  that label across all sources.
- `_changelog/YYYY-MM-DD-sync.md` — a dated record of what changed in each
  sync run (added/updated/moved/removed/unchanged/errors).

## Background Operation

`obsync watch` runs continuously, syncing on file-save via filesystem events.
It can run as a managed background service (macOS launchd, Linux systemd
`--user`) — see [PLATFORM-SERVICE.md](PLATFORM-SERVICE.md) — and exposes a
loopback-only HTTP status endpoint plus an atomic `status.json` file for
external tools (such as the macOS menu bar widget) to read sync status without
needing to run obsync's own CLI.
