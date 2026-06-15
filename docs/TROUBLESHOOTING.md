# Troubleshooting

This page lists common error messages obsync may print, what causes them, and
how to fix them.

### "Config file ... is world-readable (SEC-02)"

**Cause:** `obsync.yml` has file permissions that allow other users on the
system to read it. Since the config can reference source paths and AI backend
settings, obsync requires it to be readable only by its owner.

**Fix:** Restrict the config file's permissions:

```bash
chmod 600 obsync.yml
```

Source: `src/config/loader.ts`

### "Config file contains a hardcoded API key pattern (SEC-03)"

**Cause:** obsync scans the raw bytes of `obsync.yml` (before YAML parsing,
so this also catches keys left in comments) for patterns that look like API
keys. obsync refuses to start if it finds one, because API keys must never be
stored in the config file.

**Fix:** Remove the key from `obsync.yml` and load it via an environment
variable or a `.env` file instead (e.g. `ANTHROPIC_API_KEY=...` or
`OPENAI_API_KEY=...`). `.env` is added to `.gitignore` automatically by
`obsync init`.

Source: `src/config/loader.ts`

### "obsync must not run as root (SEC-07). Run as a non-root user."

**Cause:** obsync refuses to run as the root user as a safety measure — it
reads and writes files across multiple directories (source folders, vault,
`~/.obsync/`), and running as root would let a misconfiguration touch files
it shouldn't.

**Fix:** Run obsync as your normal (non-root) user account. If you were using
`sudo obsync ...`, remove the `sudo`.

Source: `src/config/loader.ts`

### "ANTHROPIC_API_KEY is not set" / "OPENAI_API_KEY is not set"

**Cause:** `obsync.yml` has `ai.backend: claude` or `ai.backend: openai`, but
the corresponding API key environment variable is not set in your shell or
`.env` file.

This is a **fail-closed** condition, not a fatal error: sync still runs
normally, but AI summarization is skipped for that run (and for any files
that would have been summarized), with an error logged. There is no silent
fallback to a different backend.

**Fix:** Either set the required environment variable (`ANTHROPIC_API_KEY` for
`claude`, `OPENAI_API_KEY` for `openai`) before running obsync, or change
`ai.backend` to `ollama` (local, no key required) or `none` (disables AI
summarization entirely).

Source: `src/ai/provider.ts`

### "obsync: could not enable linger automatically (often requires sudo)"

**Cause:** On Linux, `obsync install-service` attempts to run
`loginctl enable-linger $(whoami)` so the systemd `--user` service keeps
running after you log out (e.g. over SSH). This command typically requires
`sudo` on most distributions, so the automatic attempt fails — this does not
block service installation, but the service will stop when your session ends
until linger is enabled.

**Fix:** Enable linger manually with sudo:

```bash
sudo loginctl enable-linger $(whoami)
```

Source: `src/cli/commands/service.ts`
