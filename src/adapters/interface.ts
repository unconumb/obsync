/**
 * OutputAdapter interface — the primary seam between the sync engine and any output target.
 *
 * The core engine never knows it is writing to Obsidian specifically. ObsidianAdapter is
 * the first implementation. A future standalone app target = new adapter, engine untouched.
 *
 * D-17: OutputAdapter exposes a single writeEntry(entry: VaultEntry): Promise<void> method.
 * D-18: VaultEntry carries the full entry payload assembled by the engine.
 * D-20: ObsidianAdapter is the only Phase 1 implementation.
 * ARCH-01 / ARCH-02 / ARCH-03
 */

/**
 * VaultEntry — the full payload handed from the sync engine to any OutputAdapter implementation.
 *
 * Shape defined by D-18:
 * - destinationPath: absolute path inside the vault where the file must be written
 * - mergedFrontmatter: all frontmatter fields (source fields + obsync_* overrides merged)
 * - body: markdown body content (stripped of frontmatter delimiters)
 * - metadata: sync metadata used for state tracking and audit logging
 */
export interface VaultEntry {
  /** Absolute path inside the vault where this file will be written (validated for confinement). */
  destinationPath: string;
  /** All frontmatter fields: source fields take precedence; obsync_* fields are always overwritten. */
  mergedFrontmatter: Record<string, unknown>;
  /** Markdown body content with frontmatter delimiters removed. */
  body: string;
  /** Sync metadata for state persistence and audit log entries. */
  metadata: {
    /** Absolute path of the source file (read-only, never written to). */
    sourceFile: string;
    /**
     * SHA-256 hex digest of the source file content at time of sync.
     *
     * NOTE: when this VaultEntry was produced by an AI-summary re-write
     * (see processAiSummary in src/ai/process.ts), this value may instead
     * be a body-only hash (the hash of VaultEntry.body after the summary
     * callout was injected, excluding frontmatter). ObsidianAdapter.writeEntry
     * does not read or persist this field, so the discrepancy between a
     * full-content hash and a body-only hash is harmless today.
     */
    hash: string;
    /** Git commit ref (full SHA) of the source file at sync time, or null if not a git repo. */
    gitRef: string | null;
    /** ISO 8601 timestamp of when this sync operation ran. */
    syncedAt: string;
  };
}

/**
 * OutputAdapter — the interface that all vault output implementations must satisfy.
 *
 * ARCH-01: The core engine depends on this interface, never on ObsidianAdapter directly.
 * ARCH-03: Adding a new output target requires only implementing this interface.
 */
export interface OutputAdapter {
  /**
   * Write a single vault entry to the output target.
   *
   * Implementations are responsible for:
   * - Validating destinationPath confinement before any write (defense-in-depth per D-19)
   * - Atomic writes to prevent partial-write corruption (D-22)
   * - Creating any required parent directories
   * - Serializing mergedFrontmatter appropriately for the target format
   *
   * @param entry - The fully assembled entry to write
   * @throws If path confinement check fails or the write operation fails
   */
  writeEntry(entry: VaultEntry): Promise<void>;

  /**
   * Remove a previously-written vault file.
   *
   * Implementations are responsible for:
   * - Re-validating destinationPath confinement before any unlink (mirrors writeEntry's
   *   D-19 guarantee — defense-in-depth against path traversal)
   * - Idempotency: a missing file is not an error (already-gone is success)
   * - Only removing the file itself — parent directories are never pruned
   *
   * @param destinationPath - Absolute path inside the vault to remove
   * @throws If path confinement check fails, or if the unlink fails for a reason
   *         other than the file not existing
   */
  deleteEntry(destinationPath: string): Promise<void>;
}
