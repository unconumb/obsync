//! Status data model and shared state for the obsync menu bar widget.
//!
//! - `types` — serde structs mirroring `src/status/types.ts`
//!   (StatusPayloadSchema/StatusFileSchema).
//! - `state` — `SharedStatus` (`Arc<Mutex<Option<StatusFile>>>`) registered
//!   as Tauri managed state; populated by the watcher and poller below.
//! - `watcher` — `notify`-based file watcher on `~/.obsync/` (D-01).
//! - `poller` — `reqwest`-based `/status` polling loop gated on pid
//!   liveness (D-02).

pub mod poller;
pub mod state;
pub mod types;
pub mod watcher;

use serde::Serialize;

use types::StatusFile;

/// Wrapper payload emitted on every `"status-updated"` Tauri event by both
/// the watcher (Task 1) and the poller (Task 2).
///
/// This is the SINGLE source the frontend uses to learn both the current
/// `StatusFile` (or `None` if absent/unreadable) AND the launchd service
/// state — the frontend must never infer "not running" from a null
/// `status` payload, since `status.json` can be transiently absent during
/// startup races or linger after launchd stops the service (see
/// `service_status::ServiceStatus`).
///
/// Serializes to JS as `{ status: <StatusFile|null>, serviceStatus:
/// 'running'|'loaded-not-running'|'not-loaded' }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    pub status: Option<StatusFile>,
    pub service_status: crate::service_status::ServiceStatus,
}

/// Tauri event name emitted by both the watcher and the poller whenever
/// `SharedStatus` changes (or the launchd service status is recomputed).
pub const STATUS_UPDATED_EVENT: &str = "status-updated";
