/**
 * State types for obsync sync state persistence.
 *
 * The state file lives at ~/.obsync/state.json (D-23, STATE-01).
 * It tracks the last-synced hash per source file to enable idempotent sync (SYNC-02).
 * Written atomically (D-22, STATE-02): write to state.json.tmp then fs.renameSync().
 */

/**
 * FileStateEntry — the per-file record stored in the state file.
 *
 * Keyed by source-relative path in StateFile.files (e.g. 'runbooks/dr.md').
 */
export interface FileStateEntry {
  /** SHA-256 hex digest of the source file content at last sync. Used for change detection. */
  hash: string;
  /** ISO 8601 timestamp of when this file was last successfully synced. */
  syncedAt: string;
  /** Git commit ref (full SHA) at time of last sync, or null if the source is not a git repo. */
  gitRef: string | null;
  /** The source name (from config) that owns this file. Enables source-scoped state queries. */
  sourceName: string;
  /** Absolute destination path in the vault. Used to detect destination changes. */
  destinationPath: string;
  /** SHA-256 hex digest of the body content at last AI summarization (D-27). */
  aiSummaryHash?: string;
  /** ISO 8601 timestamp of last successful AI summarization (D-27). */
  aiSummarizedAt?: string;
  /** gitRef at time of last AI summarization, or null if not git-tracked (D-27). */
  aiGitRefAtSummary?: string | null;
  /** Line count of the body at last AI summarization, used for D-28 idle-fallback delta (D-27). */
  aiLineCountAtSummary?: number;
  /**
   * Merged tags for this file (frontmatter tags: + config labels: + inline #hashtag
   * extraction, D-67/D-68). Read by generateIndexPages to compute additive label sets
   * without re-reading vault files.
   */
  tags?: string[];
}

/**
 * StateFile — the top-level state file structure stored at ~/.obsync/state.json.
 *
 * version is a literal '1' (not string) to enable future version discrimination and
 * safe migration without breaking changes.
 */
export interface StateFile {
  /** Schema version. Always the literal '1' in Phase 1. Used for future migration detection. */
  version: '1';
  /** ISO 8601 timestamp of when the state file was last written. */
  updatedAt: string;
  /** Total number of completed sync runs. Incremented by runSync() after each successful non-dry-run. */
  syncCount?: number;
  /**
   * Map of source name to its last-synced category (VCAT-03).
   * Key: source name (from config)
   * Value: category string as of the last non-dry-run sync
   *
   * Written/updated each non-dry-run sync. Enables category-change
   * detection (comparing config.category to the persisted value) without
   * parsing the category back out of destinationPath.
   */
  sourceCategories?: Record<string, string>;
  /**
   * Map of source-relative file path to its last-synced state.
   * Key: source-relative path (e.g. 'runbooks/dr.md')
   * Value: FileStateEntry with hash, timestamps, and destination path
   */
  files: Record<string, FileStateEntry>;
}
