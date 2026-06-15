//! `notify` + `notify-debouncer-mini` file watcher on `~/.obsync/`
//! filtering for `status.json` (D-01).
//!
//! Mirrors `src/status/store.ts`'s atomic `.tmp` + `renameSync` write
//! pattern (Pitfall 2): a 200ms debounce window coalesces the remove+create
//! event pair into a single re-read. On `ENOENT`/parse error, `SharedStatus`
//! is set to `None` (fail-soft, mirrors `readStatusFile`'s null return —
//! never panics).
//!
//! Runs the debouncer's synchronous receive loop on a dedicated
//! `std::thread::spawn` (Pitfall 5 — the channel is sync, must not block the
//! async runtime/main thread).

use std::path::PathBuf;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::new_debouncer;
use tauri::{AppHandle, Emitter};

use super::state::SharedStatus;
use super::types::StatusFile;
use super::{StatusEvent, STATUS_UPDATED_EVENT};
use crate::service_status::current_service_status;

/// Debounce window over `~/.obsync/` — coalesces the `.tmp` + `renameSync`
/// remove/create event pair from `writeStatusFile` into one logical update.
const DEBOUNCE_WINDOW: Duration = Duration::from_millis(200);

/// Retry interval for (re-)establishing the `~/.obsync/` watch when the
/// directory does not exist yet at startup (e.g. fresh install, `obsync`
/// never run before the widget is launched).
const WATCH_RETRY_INTERVAL: Duration = Duration::from_secs(5);

/// Filename watched for within `~/.obsync/` (the parent directory is
/// watched, not this file directly — atomic renames can momentarily
/// invalidate a direct file watch, Pitfall 2/A4).
const STATUS_FILENAME: &str = "status.json";

/// Returns `true` if `path`'s file name is `status.json` — the filter
/// applied to each debounced event before triggering a re-read.
///
/// Extracted as a pure helper for unit testing.
pub fn is_status_file(path: &std::path::Path) -> bool {
    path.file_name()
        .map(|name| name == STATUS_FILENAME)
        .unwrap_or(false)
}

/// Resolve `~/.obsync/status.json` via the `dirs` crate.
///
/// Returns `None` if the home directory cannot be resolved (extremely
/// unlikely on a real desktop session) — the watcher logs and does not
/// start in that case.
fn status_file_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".obsync").join(STATUS_FILENAME))
}

/// Resolve `~/.obsync/` (the directory watched).
fn obsync_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".obsync"))
}

/// Fail-soft read of `status.json`: `ENOENT` or parse error -> `None`,
/// mirroring `readStatusFile()` (`src/status/store.ts`).
fn read_status_file(path: &std::path::Path) -> Option<StatusFile> {
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<StatusFile>(&contents).ok()
}

/// Replace the whole `SharedStatus` value and emit a `status-updated`
/// `StatusEvent` carrying the fresh status (or `None`) plus the
/// freshly-computed `service_status`.
///
/// Per the immutability convention, the whole `Option<StatusFile>` is
/// replaced (`*state.lock().unwrap() = new_status`) rather than mutated in
/// place.
fn update_shared_status(app: &AppHandle, state: &SharedStatus, new_status: Option<StatusFile>) {
    {
        let mut guard = state.lock().expect("status mutex not poisoned");
        *guard = new_status.clone();
    }

    let event = StatusEvent {
        status: new_status,
        service_status: current_service_status(),
    };

    if let Err(err) = app.emit(STATUS_UPDATED_EVENT, &event) {
        eprintln!("obsync-widget: failed to emit status-updated event: {err}");
    }
}

/// Start the `~/.obsync/` file watcher on a dedicated `std::thread::spawn`.
///
/// If `~/.obsync/` does not exist yet at startup (fresh install, `obsync`
/// never run), `.watch()` fails immediately — the thread retries every
/// `WATCH_RETRY_INTERVAL` until the directory appears (e.g. once `obsync
/// sync`/`install-service` creates it), then proceeds normally. This avoids
/// the prior behavior where a missing directory at startup permanently
/// disabled the watcher for the widget's lifetime.
///
/// On each debounced batch of events, filters for `status.json` and, if
/// matched, re-reads + parses the file, updates `SharedStatus`, and emits a
/// `status-updated` event. `ENOENT`/parse errors set `SharedStatus` to
/// `None` (fail-soft).
pub fn start_watcher(app: AppHandle, state: SharedStatus) {
    let Some(watch_dir) = obsync_dir() else {
        eprintln!("obsync-widget: could not resolve home directory; watcher not started");
        return;
    };
    let Some(file_path) = status_file_path() else {
        eprintln!("obsync-widget: could not resolve status.json path; watcher not started");
        return;
    };

    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();

        let mut debouncer = match new_debouncer(DEBOUNCE_WINDOW, tx) {
            Ok(debouncer) => debouncer,
            Err(err) => {
                eprintln!("obsync-widget: failed to create file watcher debouncer: {err}");
                return;
            }
        };

        loop {
            match debouncer
                .watcher()
                .watch(&watch_dir, RecursiveMode::NonRecursive)
            {
                Ok(()) => break,
                Err(err) => {
                    eprintln!(
                        "obsync-widget: {} not ready ({err}); retrying in {}s",
                        watch_dir.display(),
                        WATCH_RETRY_INTERVAL.as_secs()
                    );
                    std::thread::sleep(WATCH_RETRY_INTERVAL);
                }
            }
        }

        // Seed initial state from a synchronous read at startup (e.g. if
        // status.json already exists before the first fs event fires).
        update_shared_status(&app, &state, read_status_file(&file_path));

        for result in rx {
            match result {
                Ok(events) => {
                    let relevant = events.iter().any(|event| is_status_file(&event.path));
                    if relevant {
                        update_shared_status(&app, &state, read_status_file(&file_path));
                    }
                }
                Err(err) => {
                    eprintln!("obsync-widget: file watcher error: {err}");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn is_status_file_matches_exact_filename() {
        assert!(is_status_file(Path::new("/Users/testuser/.obsync/status.json")));
    }

    #[test]
    fn is_status_file_rejects_other_filenames() {
        assert!(!is_status_file(Path::new("/Users/testuser/.obsync/status.json.tmp")));
        assert!(!is_status_file(Path::new("/Users/testuser/.obsync/other.json")));
    }

    #[test]
    fn is_status_file_rejects_path_with_no_filename() {
        assert!(!is_status_file(Path::new("/")));
    }

    #[test]
    fn read_status_file_returns_none_on_missing_file() {
        let missing = Path::new("/nonexistent/path/status.json");
        assert!(read_status_file(missing).is_none());
    }

    #[test]
    fn read_status_file_returns_none_on_invalid_json() {
        let dir = std::env::temp_dir().join(format!(
            "obsync-widget-watcher-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("status.json");
        std::fs::write(&path, "not valid json").unwrap();

        assert!(read_status_file(&path).is_none());

        std::fs::remove_dir_all(&dir).ok();
    }
}
