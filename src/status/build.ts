/**
 * build.ts — the single status payload producer (D-05).
 *
 * `buildStatusPayload()` is the ONE function that produces a `StatusPayload`
 * (D-01) from a `SyncResult`, the loaded config, the AI inference queue, and
 * a precomputed per-source pending-count map. `/status`, `status.json`, and
 * `obsync status --json` all call this function — there is no second
 * aggregation path (D-05).
 *
 * - D-02: sync.counts maps SyncResult's six counts 1:1
 *   (addedCount/updatedCount/movedCount/removedCount/unchangedCount/errorCount
 *   -> added/updated/moved/removed/unchanged/errors).
 * - D-04: sources[] is populated for ALL configured sources, with
 *   pendingCount from the caller-supplied pendingCountBySource map
 *   (defaulting to 0 when a source has no entry).
 *
 * This is a PURE function — no fs, no scan, no diff. Callers compute
 * pendingCountBySource via the existing diffSources/pendingCountBySource
 * pattern (src/cli/commands/status.ts) and pass it in.
 */

import type { ObsyncConfig } from '../config/types';
import type { SyncResult } from '../sync/engine';
import type { AiInferenceQueue } from '../ai/queue';
import type { StatusPayload } from './types';

/**
 * BuildStatusPayloadInput — everything buildStatusPayload needs to produce
 * a StatusPayload.
 */
export interface BuildStatusPayloadInput {
  config: ObsyncConfig;
  lastSyncResult: SyncResult | null;
  lastSyncAt: string | null;
  syncState: 'idle' | 'syncing' | 'error';
  aiQueue: AiInferenceQueue;
  pendingCountBySource: Map<string, number>;
  /**
   * Absolute path to the `obsync.yml` config file used by the calling
   * process (additive — sync_now-missing-config fix, Plan 10-03 Task 3).
   * Optional: omitted when the caller has no resolved config path to report
   * (StatusPayload.configPath is itself optional).
   */
  configPath?: string;
  /**
   * ISO timestamp of the last status.json write by the calling process
   * (additive — poller-clobbers-fresh-sync-status fix, Plan 10-04). Optional:
   * omitted when the caller has not yet written status.json
   * (StatusPayload.updatedAt is itself optional).
   */
  updatedAt?: string;
}

/**
 * buildStatusPayload — the single producer of StatusPayload (D-05).
 *
 * When `lastSyncResult` is null (the one-shot `status --json` case with no
 * fresh SyncResult), all six counts resolve to 0 and `errors` resolves to
 * `[]` via the `?? 0` / `?? []` fallbacks below — no special-casing needed.
 */
export function buildStatusPayload(input: BuildStatusPayloadInput): StatusPayload {
  const {
    config,
    lastSyncResult,
    lastSyncAt,
    syncState,
    aiQueue,
    pendingCountBySource,
    configPath,
    updatedAt,
  } = input;

  return {
    sync: {
      state: syncState,
      lastSyncAt,
      counts: {
        added: lastSyncResult?.addedCount ?? 0,
        updated: lastSyncResult?.updatedCount ?? 0,
        moved: lastSyncResult?.movedCount ?? 0,
        removed: lastSyncResult?.removedCount ?? 0,
        unchanged: lastSyncResult?.unchangedCount ?? 0,
        errors: lastSyncResult?.errorCount ?? 0,
      },
      errors: lastSyncResult?.errors ?? [],
    },
    ai: {
      backend: config.ai?.backend ?? 'none',
      queueDepth: aiQueue.size,
    },
    sources: config.sources.map((s) => ({
      name: s.name,
      pendingCount: pendingCountBySource.get(s.name) ?? 0,
    })),
    vault: {
      path: config.vault.path,
    },
    ...(configPath !== undefined ? { configPath } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}
