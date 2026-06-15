# obsync menu bar widget

A lightweight macOS menu bar (tray) app that shows whether `obsync watch` is
running, idle, syncing, or erroring, with sync counts and quick actions
(Sync Now, Open Dashboard). It reads `~/.obsync/status.json`, written by
`obsync watch` — see [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for how
the status surface fits into the rest of obsync.

**Platform support: macOS only.** This is a [Tauri](https://tauri.app) app
built with `macos-private-api` for native menu bar tinting. Linux/Windows
tray parity is planned but not yet implemented.

## Development

Requires Rust and the Tauri CLI prerequisites — see the
[Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) for
macOS setup.

```bash
cd widget
npm install
npm run tauri dev    # launch in development mode
npm run tauri build   # produce a release .app / .dmg
```
