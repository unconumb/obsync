//! `reqwest`-based `/status` polling loop, gated on `status.json` pid
//! liveness (D-02).
//!
//! Refreshes `ai.queueDepth`/`sync.state` (and the rest of `StatusPayload`)
//! roughly every 7s while `SharedStatus` reports a live `pid`. Never polls
//! when `SharedStatus` is `None` or its `pid` is invalid — liveness is
//! decided by `status.json` presence/pid (the watcher's domain), not by the
//! HTTP probe (Pattern 3 / Don't Hand-Roll).

use std::time::Duration;

use tauri::{AppHandle, Emitter};

use super::state::SharedStatus;
use super::types::{StatusFile, StatusPayload};
use super::{StatusEvent, STATUS_UPDATED_EVENT};
use crate::service_status::current_service_status;

/// Steady-state poll interval.
const POLL_INTERVAL: Duration = Duration::from_secs(7);

/// First-connect retry attempts (Pitfall 4 — the HTTP server may not have
/// bound yet immediately after `status.json` reports a new port).
const FIRST_CONNECT_RETRIES: u32 = 3;

/// Delay between first-connect retry attempts.
const FIRST_CONNECT_RETRY_DELAY: Duration = Duration::from_millis(200);

/// Liveness gate (D-02): only poll `/status` when `status` is `Some` and
/// its `pid` is a plausible live pid (`pid > 0`).
///
/// Extracted as a pure predicate for unit testing — mirrors
/// `Number.isFinite(statusFile.pid) && statusFile.pid > 0` from
/// `src/cli/commands/status.ts` (pid is already a `u32` here, so only the
/// `> 0` check applies).
pub fn should_poll(status: Option<&StatusFile>) -> bool {
    match status {
        Some(file) => file.pid > 0,
        None => false,
    }
}

/// Merge a freshly-polled `StatusPayload` into the current `StatusFile`,
/// keeping the on-disk-only `pid`/`port`/`updated_at` fields from
/// `current`.
///
/// poller-clobbers-fresh-sync-status fix (Plan 10-04): `payload.updated_at`
/// is the polled `obsync watch` process's own last status.json write. If
/// it's older than (or absent vs.) `current.updated_at` (the on-disk
/// status.json's timestamp, kept fresh by `watcher.rs` on every file
/// change), `obsync watch` has not synced since a separate process (e.g. a
/// one-shot `obsync sync` from "Sync Now") last updated status.json on disk
/// -- skip the merge entirely and keep `current` as-is, rather than
/// overwriting fresher on-disk-derived `sync`/`sources`/`ai`/`vault`/
/// `config_path` with stale values.
fn merge_payload(current: &StatusFile, payload: StatusPayload) -> StatusFile {
    // Lexicographic >= is equivalent to chronological ordering only because both
    // producers format `updated_at` via `Date.toISOString()` (fixed-width,
    // millisecond-precision, UTC `Z`). If either side ever changes timestamp
    // format, this comparison must change too.
    let payload_is_fresh = payload
        .updated_at
        .as_deref()
        .is_some_and(|updated_at| updated_at >= current.updated_at.as_str());

    if !payload_is_fresh {
        return current.clone();
    }

    StatusFile {
        sync: payload.sync,
        ai: payload.ai,
        sources: payload.sources,
        vault: payload.vault,
        config_path: payload.config_path,
        pid: current.pid,
        port: current.port,
        updated_at: current.updated_at.clone(),
    }
}

/// Emit the same `StatusEvent` wrapper used by `watcher.rs`, recomputing
/// `service_status` at emit time.
fn emit_status_updated(app: &AppHandle, status: Option<StatusFile>) {
    let event = StatusEvent {
        status,
        service_status: current_service_status(),
    };
    if let Err(err) = app.emit(STATUS_UPDATED_EVENT, &event) {
        eprintln!("obsync-widget: failed to emit status-updated event: {err}");
    }
}

/// Poll `http://127.0.0.1:{port}/status` once, with first-connect
/// retry/backoff. Connection-refused on the first attempt is treated as
/// transient (Pitfall 4) — never downgrades liveness from an HTTP failure.
async fn poll_once(port: u16) -> Option<StatusPayload> {
    let url = format!("http://127.0.0.1:{port}/status");

    for attempt in 0..FIRST_CONNECT_RETRIES {
        match reqwest::get(&url).await {
            Ok(resp) => match resp.json::<StatusPayload>().await {
                Ok(payload) => return Some(payload),
                Err(err) => {
                    eprintln!("obsync-widget: /status response parse error: {err}");
                    return None;
                }
            },
            Err(err) => {
                if attempt + 1 < FIRST_CONNECT_RETRIES {
                    tokio::time::sleep(FIRST_CONNECT_RETRY_DELAY).await;
                    continue;
                }
                eprintln!("obsync-widget: /status request failed after retries: {err}");
                return None;
            }
        }
    }

    None
}

/// Spawn the polling loop on Tauri's existing async runtime
/// (`tauri::async_runtime::spawn` — NEVER a second `tokio::Runtime`,
/// Pattern 3).
///
/// Each iteration: read `SharedStatus`; if `should_poll`, poll `/status`
/// and merge the result, guarding against a poller write stomping a newer
/// on-disk update that landed between the read and the merge (compares
/// `updated_at` timestamps captured at read time vs. the value now in
/// state — if they differ, the watcher has produced a newer snapshot and
/// the poller's merge is skipped for this cycle; this is the documented
/// ~7s self-correcting flicker tradeoff if the timestamps ever race).
pub fn start_poller(app: AppHandle, state: SharedStatus) {
    tauri::async_runtime::spawn(async move {
        loop {
            let snapshot = {
                let guard = state.lock().expect("status mutex not poisoned");
                guard.clone()
            };

            if should_poll(snapshot.as_ref()) {
                let current = snapshot.expect("should_poll guarantees Some");
                let port = current.port;
                let read_at_updated_at = current.updated_at.clone();

                match poll_once(port).await {
                    Some(payload) => {
                        let mut guard = state.lock().expect("status mutex not poisoned");
                        let stomped = match guard.as_ref() {
                            Some(now) => now.updated_at != read_at_updated_at,
                            None => true,
                        };

                        if !stomped {
                            let merged = merge_payload(&current, payload);
                            *guard = Some(merged.clone());
                            drop(guard);
                            emit_status_updated(&app, Some(merged));
                        }
                        // else: a newer watcher update landed during this poll
                        // cycle — skip the merge for this iteration (self-
                        // corrects on the next ~7s poll).
                    }
                    None => {
                        // not-running-on-stop fix (Plan 10-04): the polled
                        // process is gone (connection refused after
                        // uninstall-service). SharedStatus still holds its
                        // last-known pid, so should_poll stays true and no
                        // watcher event fires either -- without this emit,
                        // the tray icon would be stuck on its last state
                        // forever. Re-emit the unchanged snapshot so
                        // current_service_status() is recomputed and
                        // derive_icon_state can transition to NotRunning.
                        emit_status_updated(&app, Some(current));
                    }
                }
            }

            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::types::{AiSection, SourceEntry, SyncCounts, SyncSection, VaultSection};

    fn sample_status_file(pid: u32) -> StatusFile {
        StatusFile {
            sync: SyncSection {
                state: "idle".to_string(),
                last_sync_at: None,
                counts: SyncCounts {
                    added: 0,
                    updated: 0,
                    moved: 0,
                    removed: 0,
                    unchanged: 0,
                    errors: 0,
                },
                errors: vec![],
            },
            ai: AiSection {
                backend: "none".to_string(),
                queue_depth: 0,
            },
            sources: vec![SourceEntry {
                name: "thornode".to_string(),
                pending_count: 0,
            }],
            vault: VaultSection {
                path: "~/Vault".to_string(),
            },
            config_path: None,
            pid,
            port: 54321,
            updated_at: "2026-06-14T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn should_poll_false_when_status_is_none() {
        assert!(!should_poll(None));
    }

    #[test]
    fn should_poll_false_when_pid_is_zero() {
        let status = sample_status_file(0);
        assert!(!should_poll(Some(&status)));
    }

    #[test]
    fn should_poll_true_when_pid_positive() {
        let status = sample_status_file(12345);
        assert!(should_poll(Some(&status)));
    }

    fn sample_payload(updated_at: Option<&str>) -> StatusPayload {
        StatusPayload {
            sync: SyncSection {
                state: "syncing".to_string(),
                last_sync_at: Some("2026-06-14T01:00:00.000Z".to_string()),
                counts: SyncCounts {
                    added: 1,
                    updated: 2,
                    moved: 0,
                    removed: 0,
                    unchanged: 5,
                    errors: 0,
                },
                errors: vec![],
            },
            ai: AiSection {
                backend: "ollama".to_string(),
                queue_depth: 3,
            },
            sources: vec![],
            vault: VaultSection {
                path: "~/Vault".to_string(),
            },
            config_path: Some("/Users/testuser/obsync.yml".to_string()),
            updated_at: updated_at.map(str::to_string),
        }
    }

    #[test]
    fn merge_payload_keeps_pid_port_updated_at_from_current() {
        let current = sample_status_file(999);
        let payload = sample_payload(Some("2026-06-14T01:00:00.000Z"));

        let merged = merge_payload(&current, payload);

        assert_eq!(merged.pid, 999);
        assert_eq!(merged.port, 54321);
        assert_eq!(merged.updated_at, "2026-06-14T00:00:00.000Z");
        assert_eq!(merged.sync.state, "syncing");
        assert_eq!(merged.ai.queue_depth, 3);
        assert_eq!(merged.config_path, Some("/Users/testuser/obsync.yml".to_string()));
    }

    /// poller-clobbers-fresh-sync-status fix (Plan 10-04): a polled payload
    /// whose `updated_at` is OLDER than the on-disk `current.updated_at`
    /// (e.g. a separate one-shot `obsync sync` updated status.json after
    /// `obsync watch` last synced) must NOT overwrite `current` -- the
    /// merge is skipped entirely.
    #[test]
    fn merge_payload_skips_stale_payload() {
        let mut current = sample_status_file(999);
        current.updated_at = "2026-06-14T02:00:00.000Z".to_string();
        let payload = sample_payload(Some("2026-06-14T01:00:00.000Z"));

        let merged = merge_payload(&current, payload);

        assert_eq!(merged.sync.state, current.sync.state);
        assert_eq!(merged.ai.queue_depth, current.ai.queue_depth);
        assert_eq!(merged.config_path, current.config_path);
        assert_eq!(merged.updated_at, "2026-06-14T02:00:00.000Z");
    }

    /// A polled payload with no `updated_at` (older `obsync watch` build
    /// that predates this field) is treated conservatively as stale --
    /// merge skipped, `current` preserved unchanged.
    #[test]
    fn merge_payload_skips_payload_without_updated_at() {
        let current = sample_status_file(999);
        let payload = sample_payload(None);

        let merged = merge_payload(&current, payload);

        assert_eq!(merged.sync.state, current.sync.state);
        assert_eq!(merged.config_path, current.config_path);
    }
}
