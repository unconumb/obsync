//! Serde structs mirroring `src/status/types.ts` (StatusPayloadSchema /
//! StatusFileSchema, Phase 9 + Phase 10 Plan 01's additive `vault` field).
//!
//! This is the Rust-side contract for everything the widget reads from
//! `~/.obsync/status.json` (StatusFile) and the `/status` HTTP endpoint
//! (StatusPayload). Field names/casing must stay in lockstep with the
//! TypeScript source of truth — `#[serde(rename_all = "camelCase")]` maps
//! `lastSyncAt`, `queueDepth`, `pendingCount`, and `updatedAt` correctly.
//!
//! CRITICAL: `SyncSection.errors` (a `Vec<SyncError>` of per-file failures)
//! and `SyncCounts.errors` (a `u32` count) are two distinct fields with the
//! same name at different nesting levels — do not collapse them.

use serde::{Deserialize, Serialize};

/// Six sync-result counts, 1:1 with `StatusPayloadSchema.sync.counts`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SyncCounts {
    pub added: u32,
    pub updated: u32,
    pub moved: u32,
    pub removed: u32,
    pub unchanged: u32,
    pub errors: u32,
}

/// A single per-file sync error, 1:1 with `StatusPayloadSchema.sync.errors[]`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SyncError {
    pub file: String,
    pub message: String,
}

/// Sync engine status section, 1:1 with `StatusPayloadSchema.sync`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSection {
    /// "idle" | "syncing" | "error"
    pub state: String,
    pub last_sync_at: Option<String>,
    pub counts: SyncCounts,
    pub errors: Vec<SyncError>,
}

/// AI inference status section, 1:1 with `StatusPayloadSchema.ai`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSection {
    /// "ollama" | "claude" | "openai" | "none"
    pub backend: String,
    pub queue_depth: u32,
}

/// Per-source pending-change entry, 1:1 with `StatusPayloadSchema.sources[]`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SourceEntry {
    pub name: String,
    #[serde(rename = "pendingCount")]
    pub pending_count: u32,
}

/// Vault location section (Plan 01's additive field), 1:1 with
/// `StatusPayloadSchema.vault`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VaultSection {
    /// Absolute or `~`-prefixed path to the Obsidian vault root.
    pub path: String,
}

/// Mirrors `StatusPayloadSchema` — the shape returned by the `/status` HTTP
/// endpoint and embedded (plus pid/port/updatedAt) in `status.json`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusPayload {
    pub sync: SyncSection,
    pub ai: AiSection,
    pub sources: Vec<SourceEntry>,
    pub vault: VaultSection,
    /// Absolute path to the `obsync.yml` config used by the producing
    /// process (additive, optional — sync_now-missing-config fix, Plan
    /// 10-03 Task 3). `None` for status.json files written before this
    /// field existed, or for cold-start snapshots that omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_path: Option<String>,
    /// ISO timestamp of the last status.json write by the producing process
    /// (additive, optional — poller-clobbers-fresh-sync-status fix, Plan
    /// 10-04). `None` for `obsync watch` builds that predate this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// Mirrors `StatusFileSchema` — `StatusPayloadSchema` plus the on-disk-only
/// `pid`/`port`/`updatedAt` fields (D-08/D-10 in Phase 9).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusFile {
    pub sync: SyncSection,
    pub ai: AiSection,
    pub sources: Vec<SourceEntry>,
    pub vault: VaultSection,
    /// Absolute path to the `obsync.yml` config used by the producing
    /// process (additive, optional — sync_now-missing-config fix, Plan
    /// 10-03 Task 3). `None` for status.json files written before this
    /// field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_path: Option<String>,
    pub pid: u32,
    pub port: u16,
    pub updated_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A literal status.json fixture (including the additive `vault` field)
    /// deserializes into `StatusFile` with every field correctly mapped.
    #[test]
    fn deserializes_status_file_json() {
        let json = r#"{
            "sync": {
                "state": "idle",
                "lastSyncAt": "2026-06-14T12:00:00.000Z",
                "counts": {
                    "added": 1,
                    "updated": 2,
                    "moved": 0,
                    "removed": 0,
                    "unchanged": 10,
                    "errors": 0
                },
                "errors": []
            },
            "ai": {
                "backend": "ollama",
                "queueDepth": 0
            },
            "sources": [
                { "name": "thornode", "pendingCount": 3 }
            ],
            "vault": {
                "path": "/Users/testuser/Vault"
            },
            "pid": 12345,
            "port": 54321,
            "updatedAt": "2026-06-14T12:00:01.000Z"
        }"#;

        let status: StatusFile = serde_json::from_str(json).expect("valid StatusFile JSON");

        assert_eq!(status.sync.state, "idle");
        assert_eq!(
            status.sync.last_sync_at,
            Some("2026-06-14T12:00:00.000Z".to_string())
        );
        assert_eq!(status.sync.counts.added, 1);
        assert_eq!(status.sync.counts.updated, 2);
        assert_eq!(status.sync.counts.moved, 0);
        assert_eq!(status.sync.counts.removed, 0);
        assert_eq!(status.sync.counts.unchanged, 10);
        assert_eq!(status.sync.counts.errors, 0);
        assert!(status.sync.errors.is_empty());
        assert_eq!(status.ai.backend, "ollama");
        assert_eq!(status.ai.queue_depth, 0);
        assert_eq!(status.sources.len(), 1);
        assert_eq!(status.sources[0].name, "thornode");
        assert_eq!(status.sources[0].pending_count, 3);
        assert_eq!(status.vault.path, "/Users/testuser/Vault");
        assert_eq!(status.config_path, None);
        assert_eq!(status.pid, 12345);
        assert_eq!(status.port, 54321);
        assert_eq!(status.updated_at, "2026-06-14T12:00:01.000Z");
    }

    /// sync_now-missing-config fix (Plan 10-03 Task 3): a status.json fixture
    /// WITH `configPath` deserializes into `StatusFile.config_path: Some(..)`.
    #[test]
    fn deserializes_status_file_json_with_config_path() {
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
                "path": "/Users/testuser/Vault"
            },
            "configPath": "/Users/testuser/obsync-vcat06-test.yml",
            "pid": 12345,
            "port": 54321,
            "updatedAt": "2026-06-14T12:00:01.000Z"
        }"#;

        let status: StatusFile = serde_json::from_str(json).expect("valid StatusFile JSON");

        assert_eq!(
            status.config_path,
            Some("/Users/testuser/obsync-vcat06-test.yml".to_string())
        );
    }

    /// `config_path: Some(..)` round-trips through serialization as
    /// `configPath` (camelCase), and `None` is omitted entirely
    /// (`skip_serializing_if`).
    #[test]
    fn serializes_config_path_camel_case_and_omits_when_none() {
        let with_path = StatusFile {
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
            sources: vec![],
            vault: VaultSection {
                path: "/Users/testuser/Vault".to_string(),
            },
            config_path: Some("/Users/testuser/obsync.yml".to_string()),
            pid: 1,
            port: 0,
            updated_at: "2026-06-14T12:00:01.000Z".to_string(),
        };

        let json = serde_json::to_string(&with_path).expect("serializes");
        assert!(json.contains("\"configPath\":\"/Users/testuser/obsync.yml\""));

        let without_path = StatusFile {
            config_path: None,
            ..with_path
        };
        let json = serde_json::to_string(&without_path).expect("serializes");
        assert!(!json.contains("configPath"));
    }

    /// `/status` HTTP responses (StatusPayload) omit pid/port/updatedAt —
    /// confirm deserialization succeeds without those fields.
    #[test]
    fn deserializes_status_payload_without_file_only_fields() {
        let json = r#"{
            "sync": {
                "state": "syncing",
                "lastSyncAt": null,
                "counts": {
                    "added": 0,
                    "updated": 0,
                    "moved": 0,
                    "removed": 0,
                    "unchanged": 0,
                    "errors": 0
                },
                "errors": [
                    { "file": "notes/a.md", "message": "permission denied" }
                ]
            },
            "ai": {
                "backend": "none",
                "queueDepth": 2
            },
            "sources": [],
            "vault": {
                "path": "~/Vault"
            }
        }"#;

        let payload: StatusPayload =
            serde_json::from_str(json).expect("valid StatusPayload JSON");

        assert_eq!(payload.sync.state, "syncing");
        assert_eq!(payload.sync.last_sync_at, None);
        assert_eq!(payload.sync.errors.len(), 1);
        assert_eq!(payload.sync.errors[0].file, "notes/a.md");
        assert_eq!(payload.sync.errors[0].message, "permission denied");
        assert_eq!(payload.ai.backend, "none");
        assert_eq!(payload.ai.queue_depth, 2);
        assert!(payload.sources.is_empty());
        assert_eq!(payload.vault.path, "~/Vault");
        assert_eq!(payload.config_path, None);
        assert_eq!(payload.updated_at, None);
    }

    /// poller-clobbers-fresh-sync-status fix (Plan 10-04): a `/status`
    /// response WITH `updatedAt` deserializes into
    /// `StatusPayload.updated_at: Some(..)`.
    #[test]
    fn deserializes_status_payload_with_updated_at() {
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
            "updatedAt": "2026-06-14T21:44:37.332Z"
        }"#;

        let payload: StatusPayload =
            serde_json::from_str(json).expect("valid StatusPayload JSON");

        assert_eq!(payload.updated_at, Some("2026-06-14T21:44:37.332Z".to_string()));
    }
}
