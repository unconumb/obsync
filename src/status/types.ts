/**
 * Status contract — Zod schema definitions and inferred TypeScript types
 * for the obsync status surface (STATUS-01/STATUS-02/STATUS-03).
 *
 * This file is the single source of truth for the shape consumed by all
 * three status surfaces: `obsync status --json`, the `/status` HTTP
 * endpoint (Plan 09-02), and `status.json` on disk (Plan 09-03).
 *
 * Design decisions:
 * - D-01: StatusPayloadSchema mirrors ObsyncConfigSchema's nested grouping
 *   (vault/ai/sources -> sync/ai/sources) — a single shared, sectioned
 *   status contract.
 * - D-02: sync.counts fields map 1:1 to SyncResult's six counts
 *   (added/updated/moved/removed/unchanged/error -> errors).
 * - D-08: StatusFileSchema extends StatusPayloadSchema with `port`,
 *   written by the HTTP server and read by status.json consumers.
 * - D-10: StatusFileSchema also extends with `pid` and `updatedAt` for
 *   staleness/liveness detection by readers (see src/utils/lock.ts
 *   isProcessRunning, D-11).
 */

import { z } from 'zod';

/**
 * StatusPayloadSchema — the shared, sectioned status contract.
 *
 * D-01: exactly three top-level keys (sync/ai/sources), mirroring
 * ObsyncConfigSchema's vault/ai/sources nesting convention.
 */
export const StatusPayloadSchema = z.object({
  /** Sync engine status: current state, last run timestamp, and counts. */
  sync: z.object({
    /** Current sync engine state. */
    state: z.enum(['idle', 'syncing', 'error']),
    /** ISO timestamp of the last completed sync, or null if never synced. */
    lastSyncAt: z.string().nullable(),
    /**
     * D-02: six counts mapping 1:1 to SyncResult's
     * addedCount/updatedCount/movedCount/removedCount/unchangedCount/errorCount.
     */
    counts: z.object({
      added: z.number().int().nonnegative(),
      updated: z.number().int().nonnegative(),
      moved: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
      unchanged: z.number().int().nonnegative(),
      errors: z.number().int().nonnegative(),
    }),
    /** Per-file errors from the last sync run. */
    errors: z.array(
      z.object({
        file: z.string(),
        message: z.string(),
      }),
    ),
  }),
  /** AI inference status: configured backend and current queue depth. */
  ai: z.object({
    /** Configured AI backend, mirrors ObsyncConfig.ai.backend. */
    backend: z.enum(['ollama', 'claude', 'openai', 'none']),
    /** D-03: AiInferenceQueue.size — number of jobs currently queued. */
    queueDepth: z.number().int().nonnegative(),
  }),
  /** Per-source pending-change counts. */
  sources: z.array(
    z.object({
      name: z.string(),
      pendingCount: z.number().int().nonnegative(),
    }),
  ),
  /**
   * Vault location (additive, no version bump per VCAT-03 precedent).
   * Mirrors src/config/types.ts ObsyncConfigSchema.vault shape — lets the
   * menu bar widget locate `_dashboard/Home.md` (WIDGET-04).
   */
  vault: z.object({
    /** Absolute or ~ path to the Obsidian vault root directory. */
    path: z.string().min(1),
  }),
  /**
   * Absolute path to the `obsync.yml` config file used by the producing
   * process (additive, no version bump, mirrors the `vault.path`
   * precedent). Optional — older status.json files predate this field.
   * Lets the menu bar widget's "Sync Now" pass `--config <configPath>` to
   * the spawned `obsync sync` so it loads the SAME config as the running
   * `obsync watch` (sync_now-missing-config fix, Plan 10-03 Task 3).
   */
  configPath: z.string().min(1).optional(),
  /**
   * ISO timestamp of the last status.json write by the producing process
   * (additive, optional, mirrors the `configPath` precedent). Lets the menu
   * bar widget's poller distinguish a fresh `/status` payload from a stale
   * one served by a long-running `obsync watch` process that hasn't synced
   * since a separate one-shot `obsync sync` updated status.json
   * (poller-clobbers-fresh-sync-status fix, Plan 10-04).
   */
  updatedAt: z.string().optional(),
});

/**
 * StatusFileSchema — the on-disk status.json envelope.
 *
 * D-08: adds `port` (written by the HTTP server, read by status.json
 * consumers). D-10: adds `pid` and `updatedAt` for staleness detection.
 * These three fields are NOT present in StatusPayloadSchema — they are
 * specific to the persisted file written by `obsync watch`.
 */
export const StatusFileSchema = StatusPayloadSchema.extend({
  /** PID of the process that wrote this file (D-10, D-11 liveness probe). */
  pid: z.number().int().positive(),
  /** Port the HTTP status server is listening on (D-08). */
  port: z.number().int().nonnegative(),
  /** ISO timestamp of when this file was last written (D-10). */
  updatedAt: z.string(),
});

/**
 * StatusPayload — TypeScript type inferred from StatusPayloadSchema.
 * Single source of truth — always matches StatusPayloadSchema exactly.
 */
export type StatusPayload = z.infer<typeof StatusPayloadSchema>;

/**
 * StatusFile — TypeScript type inferred from StatusFileSchema.
 * Single source of truth — always matches StatusFileSchema exactly.
 */
export type StatusFile = z.infer<typeof StatusFileSchema>;
