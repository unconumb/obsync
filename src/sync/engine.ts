import * as fs from 'fs';
import { sha256 } from '../utils/hash';
import { scanSource } from './scanner';
import { runHealthChecks } from '../health/checks';
import { diffSources } from './differ';
import { copyFile, buildDestPath } from './copier';
import { mergeFrontmatter } from './frontmatter';
import { readState, writeState } from '../state/store';
import { appendAuditEntry, getAuditLogPath } from '../audit/logger';
import { ObsidianAdapter } from '../adapters/obsidian';
import { toStateKey } from '../utils/paths';
import { acquireLock, releaseLock, LockConflictError } from '../utils/lock';
import { generateChangelog } from '../generators/changelog';
import { generateDashboard } from '../generators/dashboard';
import { generateIndexPages } from '../generators/index-page';
import { createAiProvider, getMissingApiKeyReason } from '../ai/provider';
import { evaluateTrigger } from '../ai/triggers';
import { processAiSummary } from '../ai/process';
import { AiInferenceQueue } from '../ai/queue';
import { shouldIgnore } from './ignore';
import type { AiProvider } from '../ai/provider';
import type { ObsyncConfig } from '../config/types';
import type { StateFile, FileStateEntry } from '../state/types';

/**
 * Options for a sync run.
 */
export interface SyncOptions {
  /** If true, no files are written to the vault (SYNC-07). */
  dryRun: boolean;
  /** If true, print per-file results to stdout (SYNC-08). */
  verbose: boolean;
  /**
   * If true, skip AI summarization entirely for this run regardless of
   * per-source ai_summary (AI-09, D-41). The run-wide fail-closed warning
   * path and CLI --no-ai wiring are completed in Plan 04. Optional for
   * backward compatibility with existing callers — defaults to false.
   */
  noAi?: boolean;
  /**
   * Test injection seam for the AI provider factory — defaults to the real
   * createAiProvider. Mirrors the existing fs/adapter injection convention
   * in this file.
   */
  _createAiProvider?: (aiConfig: ObsyncConfig['ai']) => AiProvider | null;
  /**
   * Optional shared AiInferenceQueue instance (AI-07/D-40). When provided
   * (e.g. by `obsync watch`, which creates one queue at startup and reuses
   * it across debounce cycles), runSync enqueues this run's AI jobs onto it
   * instead of creating a new queue — keeping inference serialized across
   * the whole watch session. Defaults to a fresh per-run queue when omitted
   * (matches `obsync sync`'s one-shot behavior).
   */
  aiQueue?: AiInferenceQueue;
  /**
   * Controls whether the category-change reconciliation pre-pass (VCAT-04/05)
   * actually moves files when a source's `category` no longer matches
   * `state.sourceCategories[source.name]`. Defaults to true (treated as true
   * when omitted) — `obsync sync` reconciles. `obsync watch` passes false
   * (D-07): the pre-pass still detects and audit-logs the mismatch, but
   * performs no moves and leaves sourceCategories unchanged for the changed
   * source so a later `obsync sync` still detects and reconciles it.
   */
  reconcileCategoryChanges?: boolean;
  /**
   * Test injection seam for the category-change reconciliation PID lock —
   * defaults to the real acquireLock/releaseLock from ../utils/lock. Mirrors
   * the existing _createAiProvider injection convention in this file.
   */
  _lock?: { acquire: () => void; release: () => void };
  /**
   * VCAT-06 confirmation seam: when category-change reconciliation has a
   * non-empty move plan (and reconcileCategoryChanges !== false, !dryRun),
   * runSync awaits this callback with the full move plan BEFORE acquiring the
   * lock or moving any files. Returning false skips ALL reconciliation for
   * this run — no lock, no copies, no deletes — and leaves
   * sourceCategories unchanged for the affected sources so the change is
   * re-offered next sync (D-11). The rest of the sync (diffSources/copy/D-70)
   * proceeds normally either way.
   *
   * Defaults to true (proceed) when omitted — preserves existing
   * non-interactive/test behavior. `obsync sync` always supplies a real
   * callback that renders the per-file preview and prompts once for the whole
   * batch (D-10/D-11). Mirrors the existing _createAiProvider injection
   * convention in this file — the engine stays testable without
   * @clack/prompts.
   */
  _confirmCategoryChanges?: (
    moves: ReadonlyArray<CategoryChangeMove>,
  ) => Promise<boolean>;
}

/**
 * A single pending category-change move, as presented to
 * SyncOptions._confirmCategoryChanges (VCAT-06).
 */
export interface CategoryChangeMove {
  /** source.name from config. */
  sourceName: string;
  /** Relative path within the source directory. */
  relPath: string;
  /** Current absolute vault path (before the move). */
  oldDestinationPath: string;
  /** New absolute vault path under the changed category (after the move). */
  newDestinationPath: string;
}

/**
 * Per-file detail for a single copied file in a sync run.
 * Consumed by changelog and dashboard generators (Plan 03).
 */
export interface SyncChange {
  /**
   * Outcome category for this file relative to pre-run state (D-71).
   * 'moved' — content hash matched an orphaned state entry at a new relPath,
   *   OR (VCAT-04/05, Phase 8) the file's source category changed in config
   *   and the file was relocated to the new vaultRoot/category/sourceName/relPath
   *   during the category-change reconciliation pre-pass.
   * 'removed' — source file no longer exists and no matching move was found.
   */
  type: 'added' | 'updated' | 'moved' | 'removed';
  /** source.name from config. */
  sourceName: string;
  /** Relative path within the source directory. */
  relPath: string;
  /** Absolute path in the vault where the file was written. */
  destinationPath: string;
  /** ISO 8601 timestamp of this sync run. */
  syncedAt: string;
}

/**
 * Summary of a completed sync run.
 */
export interface SyncResult {
  /** Number of files successfully copied to the vault (backward compat: addedCount + updatedCount). */
  copiedCount: number;
  /** Number of files absent from pre-run state that were copied (first-time sync). */
  addedCount: number;
  /** Number of files present in pre-run state with a changed hash (re-sync with modification). */
  updatedCount: number;
  /** Number of files detected as moved to a new relative path (content hash unchanged, D-71). */
  movedCount: number;
  /** Number of files removed from the source with no matching move detected (D-71). */
  removedCount: number;
  /** Number of files skipped (unchanged, dry-run, or TOML/JSON). */
  skippedCount: number;
  /** Number of files unchanged since last sync (hash match). */
  unchangedCount: number;
  /** Number of files that encountered an error during sync. */
  errorCount: number;
  /** Details of each error that occurred. */
  errors: Array<{ file: string; message: string }>;
  /** Per-file detail for each successfully copied file (for changelog/dashboard generators). */
  changes: SyncChange[];
  /**
   * Per-file detail for each file successfully summarized by AI this run
   * (AUDIT-02 surfacing — Plan 04). Empty when no AI ran (no-ai, no eligible
   * files, or fail-closed). Counts and source names only — no summary text.
   */
  aiSummaries: Array<{ sourceName: string; relPath: string }>;
}

/**
 * runSync — execute a full sync run.
 *
 * Steps:
 *   1. Log sync_start audit entry
 *   2. Read current state from disk
 *   3. Scan all configured sources
 *   4. Diff against state using sha256 content hashes
 *   5. For each file in diffResult.toSync: copyFile (errors are isolated per SYNC-06)
 *   6. If verbose: print per-file results
 *   7. Build updated state from successful copies
 *   8. If !dryRun: write updated state
 *   9. Log sync_complete audit entry
 *  10. Return SyncResult
 *
 * SYNC-06: A single file error logs to audit and continues — remaining files still sync.
 * SYNC-07: dry-run shows what would change without writing to vault or state.
 * SYNC-08: verbose mode prints per-file results.
 * ARCH-01/02/03: engine depends on OutputAdapter interface, not ObsidianAdapter directly.
 *
 * @param config - Validated, path-expanded ObsyncConfig.
 * @param options - SyncOptions controlling dryRun and verbose behavior.
 * @returns SyncResult with counts and error details.
 */
export async function runSync(
  config: ObsyncConfig,
  options: SyncOptions,
): Promise<SyncResult> {
  const now = new Date().toISOString();
  const auditLogPath = getAuditLogPath(config.audit_log);

  // Step 1: Log sync start
  appendAuditEntry(
    {
      type: 'sync_start',
      timestamp: now,
      sourceCount: config.sources.length,
    },
    auditLogPath,
  );

  // Step 2: Read current state
  const state = readState();

  // Create adapter early (hoisted from Step 5) so the category-change
  // reconciliation pre-pass (VCAT-04/05, below) can use writeEntry/deleteEntry
  // before diffSources runs.
  const adapter = new ObsidianAdapter(config.vault.path);

  // Capture pre-run file keys so the copy loop can distinguish added vs updated
  const preRunStateKeys = new Set(Object.keys(state.files));

  // Error tracking — declared before scanning so a per-source scan failure
  // (CR-01) can be recorded into the same counters/array used by the rest
  // of the run.
  let errorCount = 0;
  const errors: Array<{ file: string; message: string }> = [];

  // Result accumulators — declared before the category-change reconciliation
  // pre-pass (below) so it can push 'moved' SyncChanges, increment movedCount,
  // and update state entries directly (D-09 ordering: pre-pass runs before
  // diffSources/the copy loop).
  let copiedCount = 0;
  let addedCount = 0;
  let updatedCount = 0;
  let movedCount = 0;
  let removedCount = 0;
  let skippedCount = 0;
  const changes: SyncChange[] = [];

  // Track updated file entries for state persistence (only successfully copied files)
  const updatedFiles: Record<string, FileStateEntry> = { ...state.files };

  // Step 3: Scan all configured sources.
  //
  // CR-01: scanSource throws if a source's scan root is unreadable (rather
  // than silently returning []). We catch per-source here so one source's
  // transient I/O failure does not abort the whole sync run — but we record
  // which sources failed so the reconciliation pass below can skip pruning
  // for them. Treating a failed scan as "this source now has zero files"
  // would otherwise cause every previously-synced file for that source to be
  // classified as orphaned and permanently deleted.
  const allSourceFiles: ReturnType<typeof scanSource> = [];
  const failedScanSourceNames = new Set<string>();
  for (const source of config.sources) {
    try {
      allSourceFiles.push(...scanSource(source, config.ignore));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failedScanSourceNames.add(source.name);
      appendAuditEntry(
        {
          type: 'error',
          timestamp: new Date().toISOString(),
          sourceName: source.name,
          sourceFile: source.path,
          message: `scan failed: ${message}`,
        },
        auditLogPath,
      );
      errorCount += 1;
      errors.push({ file: source.path, message: `scan failed: ${message}` });
    }
  }

  // XPLAT-03/04/05: run platform health checks on the shared scan output
  // (D-46/D-52 — single scan feeds both the Linux file-count and Windows
  // path-length checks). Never throws, never blocks sync (D-44).
  runHealthChecks(config, allSourceFiles);

  // Category-change detection pre-pass (VCAT-03/04/05/07, Phase 8 Plan 3).
  //
  // Runs AFTER the scan loop (allSourceFiles populated) but BEFORE diffSources
  // (D-09 ordering): diffSources compares content hashes against vault copies
  // and would classify a pure category change as 'unchanged' — this pre-pass
  // is the only place that catches it.
  //
  // updatedSourceCategories starts as a clone of the persisted map and is
  // mutated below; it is written into updatedState.sourceCategories at the
  // end of the run (Step 7).
  const updatedSourceCategories: Record<string, string> = {
    ...(state.sourceCategories ?? {}),
  };

  interface CategoryMove extends CategoryChangeMove {
    stateKey: string;
  }

  let categoryMoves: CategoryMove[] = [];
  const changedSources = new Set<string>();

  for (const source of config.sources) {
    const prev = state.sourceCategories?.[source.name];
    const curr = source.category;

    if (prev === undefined) {
      // FIRST-SYNC GUARD (Pitfall 1): no prior recorded category for this
      // source — establish the baseline only, queue NO moves. Without this
      // guard every source would appear to have "changed" category on its
      // very first sync (false positive).
      updatedSourceCategories[source.name] = curr;
      continue;
    }

    if (prev === curr) {
      continue;
    }

    // Category changed for this source — collect a move for every tracked
    // file belonging to it.
    changedSources.add(source.name);

    if (failedScanSourceNames.has(source.name)) {
      // This source's scan failed this run, so allSourceFiles has zero
      // entries for it — every matchingSourceFile lookup below would be
      // undefined and we'd silently produce zero moves. Skip move
      // collection entirely and record an explicit audit entry so the
      // user can distinguish "scan failed, can't reconcile" from "file
      // legitimately removed".
      appendAuditEntry(
        {
          type: 'error',
          timestamp: new Date().toISOString(),
          sourceName: source.name,
          sourceFile: source.path,
          message: `category-change reconciliation skipped for source "${source.name}" — scan failed this run`,
        },
        auditLogPath,
      );
      continue;
    }

    for (const [stateKey, entry] of Object.entries(state.files)) {
      if (entry.sourceName !== source.name) {
        continue;
      }

      const relPath = stateKey.slice(entry.sourceName.length + 1);
      const matchingSourceFile = allSourceFiles.find(
        (sf) => sf.sourceName === source.name && sf.relPath === relPath,
      );
      if (!matchingSourceFile) {
        // File no longer exists on disk — the existing
        // removed/move-by-hash reconciliation pass handles this case.
        continue;
      }

      const clone = { ...matchingSourceFile, category: curr };
      const newDestinationPath = buildDestPath(clone, config.vault.path);

      categoryMoves.push({
        sourceName: source.name,
        relPath,
        stateKey,
        oldDestinationPath: entry.destinationPath,
        newDestinationPath,
      });
    }
  }

  // DETECT-ONLY (D-07): for each changed source, append a content-free audit
  // entry regardless of whether reconciliation runs — watch-mode parity and
  // sync both get this log line.
  for (const source of config.sources) {
    if (!changedSources.has(source.name)) {
      continue;
    }
    appendAuditEntry(
      {
        type: 'error',
        timestamp: new Date().toISOString(),
        sourceName: source.name,
        sourceFile: source.path,
        message: `category changed for source "${source.name}" — run "obsync sync" to reconcile`,
      },
      auditLogPath,
    );
  }

  // VCAT-06 (D-10/D-11): confirm the move plan BEFORE acquiring the lock or
  // moving anything. Default to true (proceed) when no callback is supplied
  // — preserves existing non-interactive/test behavior. The CLI (obsync
  // sync) always supplies a callback that renders the per-file preview and
  // prompts once for the whole batch. Only consulted when there is an actual
  // move plan to reconcile (non-dry-run, reconcileCategoryChanges !== false)
  // — a normal sync with no category change never invokes the callback.
  let categoryMovesDeclined = false;
  if (
    categoryMoves.length > 0 &&
    !options.dryRun &&
    options.reconcileCategoryChanges !== false
  ) {
    const approved = options._confirmCategoryChanges
      ? await options._confirmCategoryChanges(
          categoryMoves.map(({ sourceName, relPath, oldDestinationPath, newDestinationPath }) => ({
            sourceName,
            relPath,
            oldDestinationPath,
            newDestinationPath,
          })),
        )
      : true;

    if (approved === false) {
      categoryMovesDeclined = true;
      categoryMoves = [];
    }
  }

  if (options.reconcileCategoryChanges === false) {
    // watch-mode (D-07): detection/audit only, no moves, no lock acquisition.
    // Leave sourceCategories UNCHANGED for changed sources so a later
    // `obsync sync` still detects and reconciles them. First-sync baseline
    // entries (set above) are kept.
    for (const sourceName of changedSources) {
      delete updatedSourceCategories[sourceName];
      // Restore the previously-persisted value (if any) so it round-trips
      // unchanged.
      const prevCategory = state.sourceCategories?.[sourceName];
      if (prevCategory !== undefined) {
        updatedSourceCategories[sourceName] = prevCategory;
      }
    }
  } else if (categoryMovesDeclined) {
    // VCAT-06 decline (D-11): skip ALL reconciliation — no lock, no moves.
    // Leave sourceCategories unchanged for changed sources (same as the
    // detect-only/watch-mode path) so the change is re-offered next sync.
    // The rest of the sync (diffSources/copy/D-70) proceeds normally.
    for (const sourceName of changedSources) {
      const prevCategory = state.sourceCategories?.[sourceName];
      if (prevCategory !== undefined) {
        updatedSourceCategories[sourceName] = prevCategory;
      } else {
        delete updatedSourceCategories[sourceName];
      }
    }
  } else if (categoryMoves.length > 0 && !options.dryRun) {
    // RECONCILE branch: acquire the PID lock around reconciliation writes
    // only (D-12 — lock the writes, not the whole runSync).
    const lockAcquire = options._lock?.acquire ?? acquireLock;
    const lockRelease = options._lock?.release ?? releaseLock;

    try {
      lockAcquire();
    } catch (err) {
      if (err instanceof LockConflictError) {
        const message = err.message;
        appendAuditEntry(
          {
            type: 'error',
            timestamp: new Date().toISOString(),
            sourceName: 'obsync-reconcile',
            sourceFile: 'category-change-reconciliation',
            message,
          },
          auditLogPath,
        );
        errorCount += 1;
        errors.push({ file: 'category-change-reconciliation', message });
        // Leave sourceCategories unchanged for changed sources — same as
        // the detect-only path, so a later sync re-detects and retries.
        for (const sourceName of changedSources) {
          const prevCategory = state.sourceCategories?.[sourceName];
          if (prevCategory !== undefined) {
            updatedSourceCategories[sourceName] = prevCategory;
          } else {
            delete updatedSourceCategories[sourceName];
          }
        }
        // Skip the reconcile block entirely.
        categoryMoves = [];
      } else {
        throw err;
      }
    }

    if (categoryMoves.length > 0) {
      try {
        // groupedMoves tracks per-source success so sourceCategories is only
        // updated for sources whose moves all succeeded.
        const sourcesWithErrors = new Set<string>();

        for (const move of categoryMoves) {
          const matchingSourceFile = allSourceFiles.find(
            (sf) => sf.sourceName === move.sourceName && sf.relPath === move.relPath,
          );
          if (!matchingSourceFile) {
            continue;
          }

          const newCategory = config.sources.find((s) => s.name === move.sourceName)!.category;
          const clone = { ...matchingSourceFile, category: newCategory };

          let copyResult;
          try {
            copyResult = await copyFile(clone, config, adapter, auditLogPath, false, 'updated');
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            appendAuditEntry(
              {
                type: 'error',
                timestamp: new Date().toISOString(),
                sourceName: move.sourceName,
                sourceFile: matchingSourceFile.absPath,
                message,
              },
              auditLogPath,
            );
            errorCount += 1;
            errors.push({ file: matchingSourceFile.absPath, message });
            sourcesWithErrors.add(move.sourceName);
            continue;
          }

          if (copyResult.status === 'error') {
            // T-08-06: copyFile's internal path-confinement check (D-19)
            // rejects a malicious category (e.g. `../../etc`) and returns
            // status='error' rather than throwing — record it the same way
            // as the throwing case above so the rejection is visible and
            // this source is excluded from the sourceCategories update.
            const message = copyResult.errorMessage ?? 'unknown error';
            appendAuditEntry(
              {
                type: 'error',
                timestamp: new Date().toISOString(),
                sourceName: move.sourceName,
                sourceFile: matchingSourceFile.absPath,
                message,
              },
              auditLogPath,
            );
            errorCount += 1;
            errors.push({ file: matchingSourceFile.absPath, message });
            sourcesWithErrors.add(move.sourceName);
            continue;
          }

          if (copyResult.status !== 'copied') {
            continue;
          }

          try {
            await adapter.deleteEntry(move.oldDestinationPath);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            appendAuditEntry(
              {
                type: 'error',
                timestamp: new Date().toISOString(),
                sourceName: move.sourceName,
                sourceFile: move.oldDestinationPath,
                message,
              },
              auditLogPath,
            );
            errorCount += 1;
            errors.push({ file: move.oldDestinationPath, message });
            sourcesWithErrors.add(move.sourceName);
            // Copy already succeeded — continue updating state for this
            // file (T-08-09: copy-then-delete means worst case is a
            // duplicate, not data loss; a re-run will retry the delete).
          }

          // D-70 carry-over: spread the old entry, overwrite destinationPath
          // and hash/syncedAt/gitRef/tags from the new copy.
          const oldEntry = state.files[move.stateKey];
          updatedFiles[move.stateKey] = {
            ...oldEntry,
            hash: copyResult.hash,
            syncedAt: now,
            gitRef: copyResult.gitRef,
            sourceName: move.sourceName,
            destinationPath: move.newDestinationPath,
            tags: copyResult.tags ?? oldEntry?.tags ?? [],
          };

          changes.push({
            type: 'moved',
            sourceName: move.sourceName,
            relPath: move.relPath,
            destinationPath: move.newDestinationPath,
            syncedAt: now,
          });
          movedCount += 1;
        }

        // Only mark a source's category as reconciled if none of its moves errored.
        for (const sourceName of changedSources) {
          if (sourcesWithErrors.has(sourceName)) {
            const prevCategory = state.sourceCategories?.[sourceName];
            if (prevCategory !== undefined) {
              updatedSourceCategories[sourceName] = prevCategory;
            } else {
              delete updatedSourceCategories[sourceName];
            }
          } else {
            const newCategory = config.sources.find((s) => s.name === sourceName)!.category;
            updatedSourceCategories[sourceName] = newCategory;
          }
        }
      } finally {
        lockRelease();
      }
    }
  } else {
    // No moves to reconcile (or dryRun) — for changed sources with zero
    // tracked files, mark the category as reconciled immediately (nothing
    // to move). For dryRun, leave sourceCategories unchanged for changed
    // sources (dryRun must not mutate persisted state semantics).
    for (const sourceName of changedSources) {
      if (options.dryRun) {
        const prevCategory = state.sourceCategories?.[sourceName];
        if (prevCategory !== undefined) {
          updatedSourceCategories[sourceName] = prevCategory;
        } else {
          delete updatedSourceCategories[sourceName];
        }
      } else {
        const newCategory = config.sources.find((s) => s.name === sourceName)!.category;
        updatedSourceCategories[sourceName] = newCategory;
      }
    }
  }

  // Step 4: Diff against state using injected sha256 hash function and
  // injected existsFn (Gap 1: re-sync files whose vault copy was deleted).
  const contentHashFn = (absPath: string): string =>
    sha256(fs.readFileSync(absPath));
  const existsFn = (p: string): boolean => fs.existsSync(p);

  // Category-change reconciliation (pre-pass above) already relocated some
  // entries' vault copies to a new destinationPath and updated updatedFiles
  // accordingly. diffSources' Gap-1 "vault copy missing -> re-sync" check
  // would otherwise compare against the now-deleted OLD destinationPath
  // (still recorded in `state`) and re-classify these files as toSync,
  // overwriting the just-carried-over state entry (AI staleness fields) via
  // an extra copyFile in the loop below. Diff against updatedFiles (which
  // already reflects any reconciled destinationPath) instead of state.files.
  const stateForDiff: StateFile = { ...state, files: updatedFiles };

  const diffResult = diffSources(allSourceFiles, stateForDiff, contentHashFn, existsFn);

  // Step 5: Run copyFile for each file that needs syncing (adapter and
  // result accumulators created above)
  for (const sourceFile of diffResult.toSync) {
    // Determine added/updated from the pre-run state snapshot BEFORE copying, so
    // copyFile can include the distinction in its file_copied audit entry.
    const preRunStateKey = toStateKey(sourceFile.sourceName, sourceFile.relPath);
    const operation: 'added' | 'updated' = preRunStateKeys.has(preRunStateKey)
      ? 'updated'
      : 'added';

    let result;
    try {
      result = await copyFile(sourceFile, config, adapter, auditLogPath, options.dryRun, operation);
    } catch (err) {
      // Outer catch for unexpected errors — SYNC-06 error isolation
      const message = err instanceof Error ? err.message : String(err);
      appendAuditEntry(
        {
          type: 'error',
          timestamp: new Date().toISOString(),
          sourceName: sourceFile.sourceName,
          sourceFile: sourceFile.absPath,
          message,
        },
        auditLogPath,
      );
      errors.push({ file: sourceFile.absPath, message });
      errorCount += 1;
      continue;
    }

    if (options.verbose) {
      process.stdout.write(`  [${result.status}] ${sourceFile.relPath}\n`);
    }

    if (result.status === 'copied') {
      copiedCount += 1;
      // changeType mirrors `operation` (computed above from preRunStateKeys before the copy)
      const stateKey = preRunStateKey;
      const changeType: 'added' | 'updated' = operation;
      if (changeType === 'added') {
        addedCount += 1;
      } else {
        updatedCount += 1;
      }
      changes.push({
        type: changeType,
        sourceName: sourceFile.sourceName,
        relPath: sourceFile.relPath,
        destinationPath: result.destinationPath,
        syncedAt: now,
      });
      // Update state for this file
      updatedFiles[stateKey] = {
        hash: result.hash,
        syncedAt: now,
        gitRef: result.gitRef,
        sourceName: sourceFile.sourceName,
        destinationPath: result.destinationPath,
        tags: result.tags ?? [],
      };
    } else if (result.status === 'error') {
      errorCount += 1;
      const msg = result.errorMessage ?? 'unknown error';
      errors.push({ file: result.sourceFile, message: msg });
    } else {
      // dry_run or skipped_toml
      skippedCount += 1;
    }
  }

  const unchangedCount = diffResult.unchanged.length;

  // Capture finishedAt immediately after copy loop — represents sync duration accurately
  const finishedAt = new Date().toISOString();

  // Reconciliation/pruning pass (Gap 2): remove state.files entries whose
  // (sourceName, relPath) -> stateKey is no longer produced by the current scan,
  // for sources that are still configured. This handles relPath changes caused by
  // scan/docs_path config changes — the old entry and its orphaned vault copy are
  // removed so the label index does not list the same logical file twice.
  //
  // D-70 extension: before deleting orphans, pair them by content hash against
  // this run's 'added' changes. A pairing is treated as a 'moved' file only when
  // it is unambiguous (exactly one orphan and exactly one new file share a hash,
  // D-70's exactly-one rule) — otherwise we fall through to the existing
  // add+delete behavior, now also recorded as a 'removed' change (D-71).
  //
  // Skipped entirely under dryRun — dry runs must not mutate the vault or state.
  if (!options.dryRun) {
    const validKeys = new Set(
      allSourceFiles.map((sf) => toStateKey(sf.sourceName, sf.relPath)),
    );
    const configuredSourceNames = new Set(config.sources.map((s) => s.name));

    // Pre-pass: identify this run's orphaned state entries (same isOrphaned
    // condition as the deletion loop below, extracted as-is) and group their
    // hashes for move-pairing.
    const orphanedByHash = new Map<string, string[]>();
    for (const [stateKey, entry] of Object.entries(updatedFiles)) {
      const isOrphaned =
        configuredSourceNames.has(entry.sourceName) &&
        !failedScanSourceNames.has(entry.sourceName) &&
        !validKeys.has(stateKey);

      if (!isOrphaned) {
        continue;
      }

      const existing = orphanedByHash.get(entry.hash) ?? [];
      existing.push(stateKey);
      orphanedByHash.set(entry.hash, existing);
    }

    // Pre-pass: group this run's 'added' changes by hash (looked up via the
    // FileStateEntry written for each added stateKey in the copy loop above).
    const addedByHash = new Map<string, SyncChange[]>();
    for (const change of changes) {
      if (change.type !== 'added') {
        continue;
      }
      const addedStateKey = toStateKey(change.sourceName, change.relPath);
      const addedEntry = updatedFiles[addedStateKey];
      if (!addedEntry) {
        continue;
      }
      const existing = addedByHash.get(addedEntry.hash) ?? [];
      existing.push(change);
      addedByHash.set(addedEntry.hash, existing);
    }

    // NOTE (RESEARCH Pitfall 2 / Assumption A1): pairing is NOT source-scoped,
    // per D-70's literal "an orphaned state entry's hash matches exactly one
    // newly-discovered file" wording — identical-content files across
    // different sources can pair as a 'moved' change. The ambiguous-fallback
    // test below (multiple same-hash pairs) bounds the blast radius: any hash
    // with more than one orphan or more than one added file falls back to
    // add+delete, never guessing.
    const movedOrphanKeys = new Set<string>();

    for (const [hash, orphanKeys] of orphanedByHash.entries()) {
      const addedMatches = addedByHash.get(hash) ?? [];
      if (orphanKeys.length !== 1 || addedMatches.length !== 1) {
        continue;
      }

      const orphanStateKey = orphanKeys[0]!;
      const addedChange = addedMatches[0]!;
      const orphanEntry = updatedFiles[orphanStateKey];
      if (!orphanEntry) {
        continue;
      }

      const newStateKey = toStateKey(addedChange.sourceName, addedChange.relPath);
      const newEntry = updatedFiles[newStateKey];
      if (!newEntry) {
        continue;
      }

      // Pattern 2: carry over AI staleness fields from the orphan to the new entry.
      updatedFiles[newStateKey] = {
        ...newEntry,
        aiSummaryHash: orphanEntry.aiSummaryHash,
        aiSummarizedAt: orphanEntry.aiSummarizedAt,
        aiGitRefAtSummary: orphanEntry.aiGitRefAtSummary,
        aiLineCountAtSummary: orphanEntry.aiLineCountAtSummary,
      };

      // Delete the old vault copy and drop the orphan entry.
      try {
        await adapter.deleteEntry(orphanEntry.destinationPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendAuditEntry(
          {
            type: 'error',
            timestamp: new Date().toISOString(),
            sourceName: orphanEntry.sourceName,
            sourceFile: orphanEntry.destinationPath,
            message,
          },
          auditLogPath,
        );
        errorCount += 1;
        errors.push({ file: orphanEntry.destinationPath, message });
      }
      delete updatedFiles[orphanStateKey];

      // Pitfall 1: reclassify the 'added' change as 'moved' — splice it out of
      // changes[], decrement addedCount/copiedCount, push a single 'moved' entry.
      const addedIndex = changes.indexOf(addedChange);
      if (addedIndex !== -1) {
        changes.splice(addedIndex, 1);
      }
      addedCount -= 1;
      copiedCount -= 1;
      changes.push({
        type: 'moved',
        sourceName: addedChange.sourceName,
        relPath: addedChange.relPath,
        destinationPath: addedChange.destinationPath,
        syncedAt: now,
      });
      movedCount += 1;

      movedOrphanKeys.add(orphanStateKey);
    }

    for (const [stateKey, entry] of Object.entries(updatedFiles)) {
      // CR-01: never prune/delete entries belonging to a source whose scan
      // failed this run — an empty/missing scan result for that source does
      // not mean its files were removed, just that we could not observe them.
      const isOrphaned =
        configuredSourceNames.has(entry.sourceName) &&
        !failedScanSourceNames.has(entry.sourceName) &&
        !validKeys.has(stateKey);

      if (!isOrphaned) {
        continue;
      }

      // Already reclassified as a move above — skip the removed-change path.
      if (movedOrphanKeys.has(stateKey)) {
        continue;
      }

      delete updatedFiles[stateKey];

      try {
        await adapter.deleteEntry(entry.destinationPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendAuditEntry(
          {
            type: 'error',
            timestamp: new Date().toISOString(),
            sourceName: entry.sourceName,
            sourceFile: entry.destinationPath,
            message,
          },
          auditLogPath,
        );
        errorCount += 1;
        errors.push({ file: entry.destinationPath, message });
      }

      changes.push({
        type: 'removed',
        sourceName: entry.sourceName,
        relPath: stateKey.slice(entry.sourceName.length + 1),
        destinationPath: entry.destinationPath,
        syncedAt: now,
      });
      removedCount += 1;
    }
  }

  // Per-file AI Activity entries (AUDIT-02 surfacing — Plan 04). Populated
  // below only when the AI step runs and files are summarized; remains
  // empty for noAi, no-eligible-files, or fail-closed runs.
  const aiSummaries: Array<{ sourceName: string; relPath: string }> = [];

  // AI summarization step (AI-01/AI-04/AI-06/AUDIT-02/REDACT-02 — Phase 3 Plan 03).
  //
  // Runs after reconciliation and before generators (D-40), and only for
  // non-dry-run syncs. Gated on:
  //   - !options.noAi (AI-09/D-41 — run-wide skip; CLI wiring lands in Plan 04)
  //   - config.ai present and config.ai.backend !== 'none'
  //   - at least one file copied this run from an ai_summary:true source
  //
  // For each eligible file: re-read the just-written vault copy (frontmatter +
  // body already merged by copyFile), compute bodyHash = sha256(body) — a
  // body-only hash, NOT result.hash/entry.hash which include frontmatter — and
  // pass that SAME bodyHash as both evaluateTrigger's currentContentHash (AI-06
  // gate) and processAiSummary's contentHash (persisted as aiSummaryHash), so a
  // frontmatter-only edit on a future run cannot falsely re-trigger inference.
  if (!options.dryRun && !options.noAi && config.ai && config.ai.backend !== 'none') {
    const aiEligibleSourceNames = new Set(
      config.sources.filter((s) => s.ai_summary === true).map((s) => s.name),
    );
    // D-74: ai_ignore excludes matching files from AI summarization ONLY —
    // the file is already present in changes[] and synced normally; this
    // filter only removes it from the AI inference queue.
    const aiEligibleChanges = changes.filter((c) => {
      if (!aiEligibleSourceNames.has(c.sourceName)) {
        return false;
      }
      const sourceConfig = config.sources.find((s) => s.name === c.sourceName);
      if (sourceConfig?.ai_ignore && shouldIgnore(c.relPath, sourceConfig.ai_ignore)) {
        return false;
      }
      return true;
    });

    if (aiEligibleChanges.length > 0) {
      const createProvider = options._createAiProvider ?? createAiProvider;
      const provider = createProvider(config.ai);

      if (!provider) {
        const reason = getMissingApiKeyReason(config.ai);
        const message = reason
          ? `AI backend '${config.ai.backend}' unreachable — ${reason}`
          : `AI backend '${config.ai.backend}' has no provider implementation`;
        appendAuditEntry(
          {
            type: 'error',
            timestamp: new Date().toISOString(),
            sourceName: 'obsync-ai',
            sourceFile: 'createAiProvider',
            message,
          },
          auditLogPath,
        );
        errorCount += 1;
        errors.push({ file: 'obsync-ai', message });
      } else {
        // NOTE: the isAvailable()-false fail-closed warning path (AI-05) and the
        // --no-ai CLI flag are finalized in Plan 04. For this plan, a false
        // health check is recorded as a single run-level error and the queue is
        // skipped — no per-file jobs are enqueued, no summarize() calls happen.
        const available = await provider.isAvailable();

        if (!available) {
          // D-39 fail-closed: a single run-level error is logged and ALL AI
          // jobs for this run are skipped. The rest of runSync (generators,
          // writeState, return) proceeds normally — runSync never aborts and
          // never falls back to any other backend.
          const unavailableMessage = `AI backend '${config.ai.backend}' unreachable — skipping AI summarization for this run`;
          appendAuditEntry(
            {
              type: 'error',
              timestamp: new Date().toISOString(),
              sourceName: 'obsync-ai',
              sourceFile: 'isAvailable',
              message: unavailableMessage,
            },
            auditLogPath,
          );
          errorCount += 1;
          errors.push({ file: 'obsync-ai', message: unavailableMessage });
          process.stdout.write(`[obsync] warning: ${unavailableMessage}\n`);
        } else {
          // AI-07/D-40: reuse the caller-provided queue (e.g. watch's
          // session-long instance) when given, so inference stays serialized
          // across debounce cycles; otherwise create a fresh per-run queue.
          const aiQueue = options.aiQueue ?? new AiInferenceQueue();
          const stateUpdates: Array<{
            stateKey: string;
            sourceName: string;
            relPath: string;
            result: Awaited<ReturnType<typeof processAiSummary>>;
          }> = [];

          for (const change of aiEligibleChanges) {
            const stateKey = toStateKey(change.sourceName, change.relPath);
            const fileEntry = updatedFiles[stateKey];
            if (!fileEntry) {
              continue;
            }

            // Re-read the vault copy just written by copyFile — frontmatter
            // already merged, body already frontmatter-stripped (D-34).
            let vaultContent: string;
            try {
              vaultContent = fs.readFileSync(change.destinationPath, 'utf-8');
            } catch {
              continue;
            }
            const parsed = mergeFrontmatter(vaultContent, {
              obsync_source: change.sourceName,
              obsync_hash: fileEntry.hash,
              obsync_synced_at: fileEntry.syncedAt,
              obsync_git_ref: fileEntry.gitRef,
            });
            if (parsed.skipped) {
              continue;
            }

            const body = parsed.body;
            // bodyHash = sha256(body) — body-only hash, NOT fileEntry.hash
            // (which is sha256 over the full file including frontmatter).
            const bodyHash = sha256(body);
            const currentLineCount = body.split('\n').length;

            const stateEntry = state.files[stateKey];

            const due = evaluateTrigger({
              gitRef: fileEntry.gitRef,
              frontmatter: parsed.mergedData,
              mtimeMs: Date.now(),
              currentLineCount,
              currentContentHash: bodyHash,
              stateEntry,
              now: Date.now(),
            });

            if (!due) {
              continue;
            }

            aiQueue.enqueue({
              run: async () => {
                const result = await processAiSummary({
                  body,
                  mergedFrontmatter: parsed.mergedData,
                  destinationPath: change.destinationPath,
                  sourceName: change.sourceName,
                  sourceFile: change.destinationPath,
                  gitRef: fileEntry.gitRef,
                  contentHash: bodyHash,
                  config: { ai: config.ai as NonNullable<ObsyncConfig['ai']> },
                  provider,
                  adapter,
                  auditLogPath,
                });
                stateUpdates.push({ stateKey, sourceName: change.sourceName, relPath: change.relPath, result });
              },
            });
          }

          await aiQueue.drain();

          // Merge state updates from successful jobs into updatedFiles before writeState,
          // and record per-file AI Activity entries (counts/source names only, AUDIT-02).
          for (const { stateKey, sourceName, relPath, result } of stateUpdates) {
            if (result.status === 'summarized' && result.stateUpdate) {
              const existing = updatedFiles[stateKey];
              if (existing) {
                updatedFiles[stateKey] = { ...existing, ...result.stateUpdate };
              }
              aiSummaries.push({ sourceName, relPath });
            } else if (result.status === 'error') {
              errorCount += 1;
              errors.push({ file: result.destinationPath, message: result.errorMessage ?? 'AI summarization error' });
            }
          }
        }
      }
    }
  }

  // Step 7: Build updated state (syncCount incremented after each successful non-dry-run)
  const updatedState: StateFile = {
    version: '1',
    updatedAt: new Date().toISOString(),
    syncCount: (state.syncCount ?? 0) + 1,
    sourceCategories: updatedSourceCategories,
    files: updatedFiles,
  };

  // Step 8: Persist state only if not a dry run
  if (!options.dryRun) {
    writeState(updatedState);

    // Call generators after state is written; each generator is isolated so errors
    // do not abort the sync run or prevent the sync_complete audit entry.
    const result: SyncResult = {
      copiedCount,
      addedCount,
      updatedCount,
      movedCount,
      removedCount,
      skippedCount,
      unchangedCount,
      errorCount,
      errors,
      changes,
      aiSummaries,
    };

    let changelogFilename = '';
    try {
      const changelogResult = await generateChangelog(config, result, now, finishedAt, adapter);
      changelogFilename = changelogResult.filename;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendAuditEntry(
        {
          type: 'error',
          timestamp: new Date().toISOString(),
          sourceName: 'obsync-generator',
          sourceFile: 'generateChangelog',
          message,
        },
        auditLogPath,
      );
      errorCount += 1;
      errors.push({ file: 'generateChangelog', message });
    }

    try {
      await generateDashboard(config, result, updatedState.syncCount ?? 1, changelogFilename, adapter);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendAuditEntry(
        {
          type: 'error',
          timestamp: new Date().toISOString(),
          sourceName: 'obsync-generator',
          sourceFile: 'generateDashboard',
          message,
        },
        auditLogPath,
      );
      errorCount += 1;
      errors.push({ file: 'generateDashboard', message });
    }

    try {
      const indexPageCount = await generateIndexPages(config, updatedState, adapter);
      process.stdout.write(`Generated ${indexPageCount} index page(s).\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendAuditEntry(
        {
          type: 'error',
          timestamp: new Date().toISOString(),
          sourceName: 'obsync-generator',
          sourceFile: 'generateIndexPages',
          message,
        },
        auditLogPath,
      );
      errorCount += 1;
      errors.push({ file: 'generateIndexPages', message });
    }
  }

  // Step 9: Log sync complete
  appendAuditEntry(
    {
      type: 'sync_complete',
      timestamp: new Date().toISOString(),
      sourceCount: config.sources.length,
      copiedCount,
      skippedCount: skippedCount + unchangedCount,
      errorCount,
    },
    auditLogPath,
  );

  // Step 10: Return result
  return {
    copiedCount,
    addedCount,
    updatedCount,
    movedCount,
    removedCount,
    skippedCount,
    unchangedCount,
    errorCount,
    errors,
    changes,
    aiSummaries,
  };
}
