//! Shared in-memory status state — registered as Tauri managed state.
//!
//! `watcher.rs` (Plan 02) updates this from `~/.obsync/status.json` on each
//! debounced filesystem event; `poller.rs` (Plan 02) refreshes the lighter
//! `StatusPayload` shape from `/status`. `tray.rs` and the dropdown frontend
//! (Plan 03) read from this shared handle via Tauri commands/events.
//!
//! Per the immutability convention, updates replace the whole
//! `Option<StatusFile>` value (`*state.lock().unwrap() = Some(new_file)`)
//! rather than mutating fields in place.

use std::sync::{Arc, Mutex};

use super::types::StatusFile;

/// Shared, lock-guarded, possibly-absent status snapshot.
///
/// `None` represents "no status.json present / unreadable" — the fail-soft
/// state mirroring `readStatusFile()`'s null return (src/status/store.ts),
/// which `tray.rs` renders as the "not running" / dimmed icon state.
pub type SharedStatus = Arc<Mutex<Option<StatusFile>>>;

/// Construct a new, empty `SharedStatus` (no status.json read yet).
pub fn new_shared_status() -> SharedStatus {
    Arc::new(Mutex::new(None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::types::{AiSection, SourceEntry, SyncCounts, SyncSection, VaultSection};

    fn sample_status_file() -> StatusFile {
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
            pid: 1,
            port: 0,
            updated_at: "2026-06-14T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn new_shared_status_starts_empty() {
        let shared = new_shared_status();
        let guard = shared.lock().expect("lock not poisoned");
        assert!(guard.is_none());
    }

    #[test]
    fn shared_status_replaces_whole_value() {
        let shared = new_shared_status();
        *shared.lock().expect("lock not poisoned") = Some(sample_status_file());

        let guard = shared.lock().expect("lock not poisoned");
        let status = guard.as_ref().expect("status set");
        assert_eq!(status.pid, 1);
        assert_eq!(status.sync.state, "idle");
    }
}
