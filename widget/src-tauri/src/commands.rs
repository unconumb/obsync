//! Cold-start snapshot (`obsync status --json`) and `obsync` binary
//! resolution (D-03, Pitfall 3).
//!
//! GUI-launched macOS apps inherit a minimal `PATH`
//! (`/usr/bin:/bin:/usr/sbin:/sbin`) that does not include
//! `/usr/local/bin`, `/opt/homebrew/bin`, or nvm/volta shims — so a plain
//! `Command::new("obsync")` PATH lookup can fail even though `obsync
//! --version` works fine in a terminal. This module resolves and caches an
//! absolute path to `obsync` via a `zsh -ilc 'which obsync'` fallback,
//! exposed for reuse by Plan 03's "Sync Now" action.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::service_status::current_service_status;
use crate::status::state::SharedStatus;
use crate::status::types::StatusPayload;
use crate::status::{StatusEvent, STATUS_UPDATED_EVENT};
use crate::tray::DROPDOWN_WINDOW_LABEL;

/// Cached resolved absolute path to the `obsync` binary, populated on first
/// successful `zsh -ilc 'which obsync'` fallback.
static OBSYNC_PATH: OnceLock<String> = OnceLock::new();

/// `obsync status --json` stdout shape: `StatusPayload` PLUS
/// `watchActive: bool` and an optional `watchPid: number`
/// (`src/cli/commands/status.ts` lines 115-144).
///
/// `#[serde(flatten)]` merges `StatusPayload`'s top-level fields
/// (`sync`/`ai`/`sources`/`vault`) alongside the two extra cold-start-only
/// fields.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColdStartSnapshot {
    #[serde(flatten)]
    pub payload: StatusPayload,
    pub watch_active: bool,
    pub watch_pid: Option<u32>,
}

/// Resolve the `obsync` binary path.
///
/// 1. If a path was previously cached (via the `zsh -ilc` fallback below),
///    reuse it.
/// 2. Try plain `"obsync"` first (works when PATH is already correct, e.g.
///    when launched from a terminal).
/// 3. On failure, run `zsh -ilc 'which obsync'` once (a login shell sources
///    `.zshrc`/nvm init and typically has the correct PATH), cache the
///    resolved absolute path, and return it.
///
/// Returns `None` if even the login-shell fallback cannot locate `obsync`
/// (documented limitation — see SUMMARY).
pub async fn resolve_obsync_path(app: &AppHandle) -> Option<String> {
    if let Some(cached) = OBSYNC_PATH.get() {
        return Some(cached.clone());
    }

    // Plain "obsync" — works if PATH already includes the install location.
    if command_exists(app, "obsync").await {
        let _ = OBSYNC_PATH.set("obsync".to_string());
        return Some("obsync".to_string());
    }

    // Login-shell fallback: `zsh -ilc 'which obsync'` sources .zshrc/nvm
    // init (Pitfall 3 / Open Question 3). Fixed literal command string —
    // no interpolated input (T-10-06).
    let shell = app.shell();
    let output = shell
        .command("zsh")
        .args(["-ilc", "which obsync"])
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if resolved.is_empty() {
        return None;
    }

    let _ = OBSYNC_PATH.set(resolved.clone());
    Some(resolved)
}

/// Check whether `program` can be spawned with `--version` (used to probe
/// plain `"obsync"` on PATH without caching a failure).
async fn command_exists(app: &AppHandle, program: &str) -> bool {
    let shell = app.shell();
    match shell.command(program).args(["--version"]).output().await {
        Ok(output) => output.status.success(),
        Err(_) => false,
    }
}

/// Spawn `obsync status --json`, collect stdout, and parse into
/// `ColdStartSnapshot`. Seeds `SharedStatus` from the result's `StatusFile`-
/// shaped fields (constructing a `StatusFile` requires `pid`/`port`/
/// `updated_at`, which the cold-start payload does not carry directly —
/// only `watch_pid`/`watch_active` are available, so `SharedStatus` is only
/// seeded when a live watch is detected and emits the lighter
/// `StatusPayload`-derived event; otherwise `SharedStatus` remains `None`
/// and the watcher's first debounced read on `status.json` is the
/// authoritative seed).
pub async fn cold_start_snapshot(app: &AppHandle, state: &SharedStatus) {
    let Some(obsync_path) = resolve_obsync_path(app).await else {
        eprintln!("obsync-widget: could not resolve obsync binary path for cold-start snapshot");
        return;
    };

    let shell = app.shell();
    let spawn_result = shell.command(&obsync_path).args(["status", "--json"]).spawn();

    let (mut rx, _child) = match spawn_result {
        Ok(pair) => pair,
        Err(err) => {
            eprintln!("obsync-widget: failed to spawn `obsync status --json`: {err}");
            return;
        }
    };

    let mut stdout = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                stdout.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Error(err) => {
                eprintln!("obsync-widget: `obsync status --json` error: {err}");
            }
            _ => {}
        }
    }

    let snapshot: ColdStartSnapshot = match serde_json::from_str(&stdout) {
        Ok(snapshot) => snapshot,
        Err(err) => {
            eprintln!("obsync-widget: failed to parse `obsync status --json` output: {err}");
            return;
        }
    };

    // status.json's debounced watcher read is the authoritative source for
    // pid/port/updated_at (StatusFile-only fields). The cold-start snapshot
    // is used here only to emit an immediate status-updated event with the
    // freshest StatusPayload-shaped data (sync/ai/sources/vault), without
    // overwriting SharedStatus's pid/port if the watcher has already seeded
    // it from status.json.
    let existing_pid_port = {
        let guard = state.lock().expect("status mutex not poisoned");
        guard.as_ref().map(|file| (file.pid, file.port, file.updated_at.clone()))
    };

    if let Some((pid, port, updated_at)) = existing_pid_port {
        let merged = crate::status::types::StatusFile {
            sync: snapshot.payload.sync,
            ai: snapshot.payload.ai,
            sources: snapshot.payload.sources,
            vault: snapshot.payload.vault,
            config_path: snapshot.payload.config_path,
            pid,
            port,
            updated_at,
        };
        {
            let mut guard = state.lock().expect("status mutex not poisoned");
            *guard = Some(merged.clone());
        }
        let event = StatusEvent {
            status: Some(merged),
            service_status: current_service_status(),
        };
        if let Err(err) = app.emit(STATUS_UPDATED_EVENT, &event) {
            eprintln!("obsync-widget: failed to emit cold-start status-updated event: {err}");
        }
    } else {
        // No status.json read yet (first launch race) — emit a
        // service_status-only event so the frontend's not-running branch
        // can render immediately; SharedStatus stays None until the
        // watcher's first debounced read.
        let event = StatusEvent {
            status: None,
            service_status: current_service_status(),
        };
        if let Err(err) = app.emit(STATUS_UPDATED_EVENT, &event) {
            eprintln!("obsync-widget: failed to emit cold-start status-updated event: {err}");
        }
    }
}

/// Outcome of `sync_now`, returned to the frontend.
///
/// `already_syncing: true` means the D-10 concurrency guard refused to spawn
/// a second `obsync sync` — the frontend's optimistic "Syncing..." UI should
/// still reflect the in-progress sync (it was already showing that state).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncNowResult {
    pub already_syncing: bool,
}

/// Build the argument list for the spawned `obsync sync` command
/// (sync_now-missing-config fix, Plan 10-03 Task 3).
///
/// When `config_path` is `Some`, appends `--config <path>` so the spawned
/// `obsync sync` loads the SAME config as the running `obsync watch`.
/// When `None` (e.g. status.json predates this fix, or `obsync watch` is not
/// running), falls back to `["sync"]` — prior behavior, letting `obsync
/// sync` default to `obsync.yml` in its CWD.
///
/// Pure function, extracted from `sync_now` for unit testability without an
/// `AppHandle`.
fn build_sync_args(config_path: Option<&str>) -> Vec<&str> {
    let mut args: Vec<&str> = vec!["sync"];
    if let Some(path) = config_path {
        args.push("--config");
        args.push(path);
    }
    args
}

/// `#[tauri::command]` — "Sync Now" (WIDGET-03, D-09/D-10/D-11).
///
/// D-10 concurrency guard: if `SharedStatus.sync.state == "syncing"`, return
/// `{ already_syncing: true }` WITHOUT spawning a second `obsync sync`.
/// Otherwise spawn `obsync sync` detached via `tauri-plugin-shell`, reusing
/// the cached `resolve_obsync_path` resolution from cold-start.
///
/// D-11: stdout is NOT collected/parsed for counts — the watcher/poller
/// re-poll `status.json`/`/status` is the single source of truth for
/// completion and counts.
#[tauri::command]
pub async fn sync_now(
    app: AppHandle,
    state: tauri::State<'_, SharedStatus>,
) -> Result<SyncNowResult, String> {
    let config_path = {
        let guard = state.lock().expect("status mutex not poisoned");
        if let Some(file) = guard.as_ref() {
            if file.sync.state == "syncing" {
                return Ok(SyncNowResult {
                    already_syncing: true,
                });
            }
            file.config_path.clone()
        } else {
            None
        }
    };

    let Some(obsync_path) = resolve_obsync_path(&app).await else {
        return Err("could not resolve obsync binary path".to_string());
    };

    // sync_now-missing-config fix (Plan 10-03 Task 3): pass --config when
    // SharedStatus knows the config path the running `obsync watch` uses, so
    // the spawned `obsync sync` loads the SAME config rather than defaulting
    // to `obsync.yml` in the widget process's CWD. Falls back to omitting
    // --config (prior behavior) when config_path is absent (e.g. status.json
    // predates this fix, or `obsync watch` is not running) — the D-10
    // already-syncing guard above still applies in both cases.
    let args = build_sync_args(config_path.as_deref());

    let shell = app.shell();
    match shell.command(&obsync_path).args(args).spawn() {
        Ok((mut rx, _child)) => {
            // Detached: drain the event channel on a background task without
            // collecting/parsing stdout (D-11) — the watcher/poller pick up
            // the resulting status.json/`/status` change.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Error(err) = event {
                        eprintln!("obsync-widget: `obsync sync` error: {err}");
                    }
                }
            });
            Ok(SyncNowResult {
                already_syncing: false,
            })
        }
        Err(err) => Err(format!("failed to spawn `obsync sync`: {err}")),
    }
}

/// `#[tauri::command]` — "Open Dashboard" (WIDGET-04).
///
/// Reads `vault.path` from `SharedStatus` and opens
/// `<vault.path>/_dashboard/Home.md` via `tauri-plugin-opener`'s
/// `open_path` (system default app — Obsidian/markdown viewer).
#[tauri::command]
pub fn open_dashboard(app: AppHandle, state: tauri::State<'_, SharedStatus>) -> Result<(), String> {
    let vault_path = {
        let guard = state.lock().expect("status mutex not poisoned");
        guard.as_ref().map(|file| file.vault.path.clone())
    };

    let Some(vault_path) = vault_path else {
        return Err("vault path is not yet known (no status available)".to_string());
    };

    let dashboard_path = format!("{vault_path}/_dashboard/Home.md");
    app.opener()
        .open_path(dashboard_path, None::<&str>)
        .map_err(|err| format!("failed to open dashboard: {err}"))
}

/// `#[tauri::command]` — "Quit Obsync" (WIDGET-POLISH-QUIT).
///
/// Exits the widget process cleanly via `AppHandle::exit`, terminating the
/// tray icon and all windows.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Create the borderless dropdown `WebviewWindow` (Open Question 1
/// resolution): decorations off, skip-taskbar, always-on-top, hidden
/// initially. `tray.rs`'s left-click handler toggles its visibility.
///
/// Positioning: Tauri v2's `TrayIconEvent::Click` carries the click
/// position, but the window must exist before the first click. A small
/// fixed near-menu-bar position (top-right corner) is used as the initial
/// placement — documented fallback per RESEARCH.md Open Question 1, since
/// dynamically repositioning under the clicked tray icon on every click
/// would require storing the click position from the tray event handler and
/// is deferred (not required by D-08's functional spec).
///
/// Auto-dismiss on focus loss: a `WindowEvent::Focused(false)` listener
/// hides the window.
pub fn build_dropdown_window(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, DROPDOWN_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
        .title("obsync")
        .inner_size(280.0, 360.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()?;

    // Position near the top-right of the primary monitor (menu-bar area).
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let screen_size = monitor.size();
        let scale = monitor.scale_factor();
        let window_width = 280.0 * scale;
        let margin = 8.0 * scale;
        let x = (screen_size.width as f64 - window_width - margin).max(0.0);
        let y = margin;
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }

    let dismiss_window = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            let _ = dismiss_window.hide();
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// sync_now-missing-config fix (Plan 10-03 Task 3): when `config_path`
    /// is `Some`, `build_sync_args` appends `--config <path>`.
    #[test]
    fn build_sync_args_includes_config_flag_when_path_present() {
        let args = build_sync_args(Some("/Users/testuser/obsync-vcat06-test.yml"));
        assert_eq!(args, vec!["sync", "--config", "/Users/testuser/obsync-vcat06-test.yml"]);
    }

    /// When `config_path` is `None` (status.json predates this fix, or
    /// `obsync watch` is not running), `build_sync_args` falls back to
    /// `["sync"]` — prior behavior, no `--config` flag.
    #[test]
    fn build_sync_args_omits_config_flag_when_path_absent() {
        let args = build_sync_args(None);
        assert_eq!(args, vec!["sync"]);
    }

    /// A literal `obsync status --json` JSON string with watchActive/
    /// watchPid parses into `ColdStartSnapshot`.
    #[test]
    fn deserializes_cold_start_snapshot_with_watch_fields() {
        let json = r#"{
            "sync": {
                "state": "idle",
                "lastSyncAt": "2026-06-14T12:00:00.000Z",
                "counts": {
                    "added": 0,
                    "updated": 0,
                    "moved": 0,
                    "removed": 0,
                    "unchanged": 5,
                    "errors": 0
                },
                "errors": []
            },
            "ai": {
                "backend": "ollama",
                "queueDepth": 0
            },
            "sources": [],
            "vault": {
                "path": "~/Vault"
            },
            "watchActive": true,
            "watchPid": 12345
        }"#;

        let snapshot: ColdStartSnapshot =
            serde_json::from_str(json).expect("valid ColdStartSnapshot JSON");

        assert!(snapshot.watch_active);
        assert_eq!(snapshot.watch_pid, Some(12345));
        assert_eq!(snapshot.payload.sync.state, "idle");
        assert_eq!(snapshot.payload.vault.path, "~/Vault");
    }

    /// `watchActive: false` with no `watchPid` field (the no-watch case)
    /// parses correctly with `watch_pid: None`.
    #[test]
    fn deserializes_cold_start_snapshot_without_watch_pid() {
        let json = r#"{
            "sync": {
                "state": "idle",
                "lastSyncAt": null,
                "counts": {
                    "added": 0,
                    "updated": 0,
                    "moved": 0,
                    "removed": 0,
                    "unchanged": 0,
                    "errors": 0
                },
                "errors": []
            },
            "ai": {
                "backend": "none",
                "queueDepth": 0
            },
            "sources": [],
            "vault": {
                "path": "~/Vault"
            },
            "watchActive": false
        }"#;

        let snapshot: ColdStartSnapshot =
            serde_json::from_str(json).expect("valid ColdStartSnapshot JSON");

        assert!(!snapshot.watch_active);
        assert_eq!(snapshot.watch_pid, None);
    }
}
