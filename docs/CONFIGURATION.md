# Configuration

obsync is configured via a single `obsync.yml` file, created by `obsync init`
(written with `600` permissions — owner read/write only) and edited by hand or
via `obsync add`/`discover`.

This page describes the top-level shape and the most commonly-tuned fields.
See [obsync.yml.example](../obsync.yml.example) for the full annotated
reference (every supported field, with inline comments).

## Top-Level Shape

```yaml
vault:
  # Absolute path (or ~ for home) to your Obsidian vault root directory.
  path: ~/Documents/Obsidian/MyVault

# Optional AI backend configuration.
# Remove this block (or set backend: none) to disable AI summarization entirely.
ai:
  backend: ollama        # ollama | claude | openai | none
  model: qwen3.5:9b      # model name passed to the backend
  ollama_url: http://localhost:11434   # only used when backend: ollama

sources:
  - name: example
    path: ~/Documents/Obsidian/MyVault/../some-project
    category: Projects
    scan: scattered
    ai_summary: false
```

## `ai.backend`

`ai.backend` accepts `ollama | claude | openai | none`:

- `ollama` — runs fully locally, no API key needed (e.g. `qwen3.5:9b`)
- `claude` — requires `ANTHROPIC_API_KEY` (e.g. `claude-haiku-4-5`)
- `openai` — requires `OPENAI_API_KEY` (e.g. `gpt-4o-mini`)

For `claude`/`openai`, set the corresponding key in your shell environment
or `.env` file before running `obsync`. If the key is missing, obsync fails
closed: AI summarization is skipped and an error is logged, sync still runs.

## `sources[]` Fields

Each entry in `sources[]` describes one folder to sync from:

- **`scan: scattered`** — every `.md` file anywhere in the source tree (minus
  `ignore` patterns) is synced. Good for note dumps / runbook folders.
- **`scan: docs` + `docs_path`** — only files under `docs_path` (relative to
  the source's `path`) are synced. Good for project repos where you only want
  the `docs/` subtree.
- **`ai_ignore: string[]`** — per-source glob patterns excluded from AI
  summarization. Matching files still sync normally, they just never get a
  summary callout or get sent to the AI backend.
- **`labels: string[]`** — cross-source tags used to build `_index/<Label>.md`
  pages that link every file tagged with that label across sources. Files can
  also gain labels via inline `#hashtag` or frontmatter `tags:`.

## Global Ignore Patterns

A top-level `ignore: string[]` applies to all sources. Supported pattern
formats:

- `"dirname/"` — matches the named directory anywhere in the path
- `"*.ext"` — matches files with the given extension
- `"exact-name.md"` — exact filename or path segment match

## Audit Log

By default, the audit log is written to `~/.obsync/audit.log`. Override the
location with the optional top-level `audit_log: <path>` field.

---

See [obsync.yml.example](../obsync.yml.example) for the full annotated reference.
