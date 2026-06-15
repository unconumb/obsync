// TypeScript mirrors of widget/src-tauri/src/status/types.rs and
// service_status.rs's serde shapes (camelCase on the wire). Keep these in
// lockstep with the Rust structs — see status/types.rs's own header comment.

export type ServiceStatus = "running" | "loaded-not-running" | "not-loaded";

export interface SyncCounts {
  added: number;
  updated: number;
  moved: number;
  removed: number;
  unchanged: number;
  errors: number;
}

export interface SyncError {
  file: string;
  message: string;
}

export interface SyncSection {
  state: string;
  lastSyncAt: string | null;
  counts: SyncCounts;
  errors: SyncError[];
}

export interface AiSection {
  backend: string;
  queueDepth: number;
}

export interface SourceEntry {
  name: string;
  pendingCount: number;
}

export interface VaultSection {
  path: string;
}

export interface StatusFile {
  sync: SyncSection;
  ai: AiSection;
  sources: SourceEntry[];
  vault: VaultSection;
  pid: number;
  port: number;
  updatedAt: string;
}

/**
 * The "status-updated" Tauri event payload (Plan 02's StatusEvent /
 * status/mod.rs). The not-running view MUST be driven by `serviceStatus`,
 * never by `status === null` alone (status.json can be transiently absent
 * while the watch service is running).
 */
export interface StatusEvent {
  status: StatusFile | null;
  serviceStatus: ServiceStatus;
}

/** Result of the `sync_now` command (commands.rs SyncNowResult). */
export interface SyncNowResult {
  alreadySyncing: boolean;
}
