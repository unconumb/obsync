import { Command } from 'commander';
import * as path from 'path';
import { confirm, isCancel, cancel } from '@clack/prompts';
import { loadConfig, ConfigLoadError } from '../../config/loader';
import { runSync, type SyncResult } from '../../sync/engine';
import type { CategoryChangeMove } from '../../sync/engine';
import { AiInferenceQueue } from '../../ai/queue';
import { writeStatusFile, readStatusFile } from '../../status/store';
import { buildStatusPayload } from '../../status/build';
import { computePendingCountBySource } from '../../status/pending';
import { isProcessRunning } from '../../utils/lock';
import type { ObsyncConfig } from '../../config/types';

/**
 * VCAT-06 (D-10/D-11) — renders the per-file category-change move preview
 * grouped by source, then prompts once for the whole batch. Passed to
 * runSync via SyncOptions._confirmCategoryChanges; only invoked when the
 * engine has a non-empty pending move plan, so a normal sync with no
 * category change prints no preview and shows no prompt.
 *
 * Returning false routes the engine to skip ALL reconciliation for this run
 * while the rest of the sync proceeds normally (D-11) — this callback never
 * calls process.exit.
 */
async function confirmCategoryChanges(moves: ReadonlyArray<CategoryChangeMove>): Promise<boolean> {
  const movesBySource = new Map<string, CategoryChangeMove[]>();
  for (const move of moves) {
    const existing = movesBySource.get(move.sourceName) ?? [];
    existing.push(move);
    movesBySource.set(move.sourceName, existing);
  }

  process.stdout.write('\n[obsync] Category change detected — the following files will be moved:\n');
  for (const [sourceName, sourceMoves] of movesBySource) {
    process.stdout.write(`\n  ${sourceName}:\n`);
    for (const move of sourceMoves) {
      process.stdout.write(`    ${move.oldDestinationPath} -> ${move.newDestinationPath}\n`);
    }
  }
  process.stdout.write('\n');

  const proceed = await confirm({ message: 'Proceed with these moves? (y/n)' });
  if (isCancel(proceed)) {
    cancel('Aborted — category-change reconciliation skipped this run.');
    return false;
  }
  return proceed === true;
}

/**
 * resolveStatusIdentity — pid/port to write into status.json for this
 * one-shot `obsync sync` run.
 *
 * If `obsync watch` is currently running, its pid/port (from the existing
 * status.json) are preserved so status.json continues to reflect the live
 * watch process and its status server. Otherwise this one-shot process's
 * own pid is used with port 0 (no status HTTP server).
 */
function resolveStatusIdentity(): { pid: number; port: number } {
  const priorStatus = readStatusFile();
  const priorPidLooksValid =
    !!priorStatus && Number.isFinite(priorStatus.pid) && priorStatus.pid > 0;
  if (priorPidLooksValid && isProcessRunning(priorStatus!.pid)) {
    return { pid: priorStatus!.pid, port: priorStatus!.port };
  }
  return { pid: process.pid, port: 0 };
}

/**
 * writeSyncStatus — persists status.json (D-05/D-10) for this `obsync sync`
 * run, so the menu bar widget's Sync Now flow (D-09/D-11) observes the
 * transient 'syncing' state and the resulting counts.
 */
function writeSyncStatus(
  config: ObsyncConfig,
  identity: { pid: number; port: number },
  syncState: 'idle' | 'syncing' | 'error',
  lastSyncResult: SyncResult | null,
  lastSyncAt: string | null,
  configPath: string,
): void {
  writeStatusFile({
    ...buildStatusPayload({
      config,
      lastSyncResult,
      lastSyncAt,
      syncState,
      aiQueue: new AiInferenceQueue(),
      pendingCountBySource: computePendingCountBySource(config),
      configPath,
    }),
    pid: identity.pid,
    port: identity.port,
    updatedAt: new Date().toISOString(),
  });
}

export function buildSyncCommand(): Command {
  const cmd = new Command('sync');

  cmd
    .description('Copy changed .md files from all configured sources into the vault')
    .option('--dry-run', 'Show what would change without writing', false)
    .option('--verbose', 'Show per-file details', false)
    .option('--no-ai', 'Disable AI summarization for this run')
    .option('-c, --config <path>', 'Path to obsync.yml', 'obsync.yml')
    .action(async (options: { dryRun: boolean; verbose: boolean; ai: boolean; config: string }) => {
      let config;
      try {
        config = loadConfig(options.config);
      } catch (err) {
        if (err instanceof ConfigLoadError) {
          process.stderr.write(`obsync: config error: ${err.message}\n`);
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`obsync: unexpected error loading config: ${msg}\n`);
        }
        process.exit(1);
        return; // prevents fallthrough in test/mock contexts where process.exit is intercepted
      }

      if (options.dryRun) {
        process.stdout.write('[obsync] dry-run mode — no files will be written\n');
      }

      // Commander maps `--no-ai` to options.ai === false (default true when
      // the flag is not passed). noAi=true threads into runSync to skip the
      // AI step entirely (AI-09/D-41).
      const noAi = options.ai === false;

      // sync_now-missing-config fix (Plan 10-03 Task 3): this run's own
      // resolved config path, persisted to status.json's configPath so the
      // NEXT `obsync sync` invocation (e.g. the widget's "Sync Now") knows
      // which config to pass via --config.
      const resolvedConfigPath = path.resolve(options.config);

      // Persist status.json so the widget's Sync Now (D-09/D-11) observes
      // the transient 'syncing' state and the resulting counts. Skipped for
      // --dry-run, which makes no real changes.
      const statusIdentity = options.dryRun ? null : resolveStatusIdentity();
      if (statusIdentity) {
        writeSyncStatus(config, statusIdentity, 'syncing', null, null, resolvedConfigPath);
      }

      const result = await runSync(config, {
        dryRun: options.dryRun,
        verbose: options.verbose,
        noAi,
        _confirmCategoryChanges: confirmCategoryChanges,
      });

      if (statusIdentity) {
        writeSyncStatus(
          config,
          statusIdentity,
          result.errorCount > 0 ? 'error' : 'idle',
          result,
          new Date().toISOString(),
          resolvedConfigPath,
        );
      }

      const summary =
        `Sync complete: ${result.addedCount} added, ` +
        `${result.updatedCount} updated, ` +
        `${result.movedCount} moved, ` +
        `${result.removedCount} removed, ` +
        `${result.unchangedCount} unchanged, ` +
        `${result.errorCount} errors\n`;

      process.stdout.write(summary);

      if (result.errors.length > 0) {
        for (const err of result.errors) {
          process.stderr.write(`  [error] ${err.file}: ${err.message}\n`);
        }
      }

      // WR-02: report a non-zero exit code when any per-file errors occurred
      // so CI/shell callers can detect a partially-failed sync run, even
      // though the run itself completed (no uncaught exception).
      process.exit(result.errorCount > 0 ? 1 : 0);
    });

  return cmd;
}
