import * as fs from 'fs';
import { Command } from 'commander';
import { loadConfig, ConfigLoadError } from '../../config/loader';
import { readState } from '../../state/store';
import { scanSource } from '../../sync/scanner';
import { diffSources } from '../../sync/differ';
import { sha256 } from '../../utils/hash';
import { buildStatusPayload } from '../../status/build';
import { readStatusFile } from '../../status/store';
import { isProcessRunning } from '../../utils/lock';
import { AiInferenceQueue } from '../../ai/queue';

/**
 * buildStatusCommand — constructs the `obsync status` CLI command.
 *
 * Status is read-only: no state mutations, no vault writes.
 * Reads state.json, scans current sources, diffs against state to compute
 * pending changes, and prints a formatted report to stdout.
 *
 * SYNC-09: shows last sync time, per-source file counts, and pending changes.
 */
export function buildStatusCommand(): Command {
  const cmd = new Command('status');

  cmd
    .description('Show last sync time, file counts, and pending changes')
    .option('-c, --config <path>', 'Path to obsync.yml', 'obsync.yml')
    .option('--json', 'Output status as JSON (STATUS-03)')
    .action((options: { config: string; json?: boolean }) => {
      // Step 1: Load config — catch ConfigLoadError, print to stderr, exit 1
      let config: ReturnType<typeof loadConfig>;
      try {
        config = loadConfig(options.config);
      } catch (err) {
        if (err instanceof ConfigLoadError) {
          console.error(`[obsync] config error: ${err.message}`);
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[obsync] unexpected error loading config: ${msg}`);
        }
        process.exit(1);
        return;
      }

      // Step 2: Read state — always returns a StateFile (empty if no prior sync)
      const state = readState();

      // Step 3: If no files in state (no prior sync), print friendly message
      // and exit 0 — D-16: this plain-text early-return is unchanged for the
      // no-flag path. For --json, fall through so an empty-state call still
      // returns a valid JSON payload (sources from config with pendingCount,
      // watchActive probe) instead of this text message.
      if (Object.keys(state.files).length === 0 && !options.json) {
        console.log('No sync history found. Run obsync sync to start.');
        process.exit(0);
        return;
      }

      // Step 4: Format last sync time (D-16: plain-text only — --json has its
      // own lastSyncAt field in the payload, computed below).
      if (!options.json) {
        const lastSyncTime = state.updatedAt
          ? new Date(state.updatedAt).toLocaleString()
          : 'unknown';

        console.log(`Last sync: ${lastSyncTime}`);
        console.log('');
      }

      // Step 5: Count tracked files per source
      const trackedCountBySource = new Map<string, number>();
      for (const source of config.sources) {
        trackedCountBySource.set(source.name, 0);
      }
      for (const entry of Object.values(state.files)) {
        const current = trackedCountBySource.get(entry.sourceName) ?? 0;
        trackedCountBySource.set(entry.sourceName, current + 1);
      }

      // Step 6: Scan current sources to find pending changes.
      // status is read-only and non-destructive, so a source whose scan root
      // is temporarily unreadable is treated as "0 files for this source"
      // rather than aborting the whole command (CR-01: scanSource now throws
      // on scan failure so the sync engine can avoid mass-pruning).
      const allSourceFiles = config.sources.flatMap((source) => {
        try {
          return scanSource(source, config.ignore);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[obsync] warning: failed to scan source "${source.name}": ${message}`);
          return [];
        }
      });

      // Step 7: Diff to compute pending files (synchronous readFileSync for status)
      const hashFn = (absPath: string): string =>
        sha256(fs.readFileSync(absPath));
      const existsFn = (p: string): boolean => fs.existsSync(p);

      const diffResult = diffSources(allSourceFiles, state, hashFn, existsFn);

      // Step 8: Compute pending count per source
      const pendingCountBySource = new Map<string, number>();
      for (const source of config.sources) {
        pendingCountBySource.set(source.name, 0);
      }
      for (const sf of diffResult.toSync) {
        const current = pendingCountBySource.get(sf.sourceName) ?? 0;
        pendingCountBySource.set(sf.sourceName, current + 1);
      }

      // --json branch (STATUS-03/D-15/D-16): additive, early-return.
      // D-14: counts are always recomputed via the live scan+diff above —
      // never trusted from a stale status.json.
      if (options.json) {
        const payload = buildStatusPayload({
          config,
          lastSyncResult: null, // Open Question 1: one-shot has no fresh SyncResult; counts zero via build.ts fallbacks
          lastSyncAt: state.updatedAt ?? null,
          syncState: 'idle',
          aiQueue: new AiInferenceQueue(), // empty queue, size 0
          pendingCountBySource,
        });

        // D-15: probe any existing status.json's pid for watch liveness.
        const statusFile = readStatusFile();
        const statusPidLooksValid =
          !!statusFile && Number.isFinite(statusFile.pid) && statusFile.pid > 0;
        let watchActive = false;
        let watchPid: number | undefined;
        if (statusPidLooksValid && isProcessRunning(statusFile!.pid)) {
          watchActive = true;
          watchPid = statusFile!.pid;
        }

        console.log(
          JSON.stringify(
            { ...payload, watchActive, ...(watchPid !== undefined ? { watchPid } : {}) },
            null,
            2,
          ),
        );
        return;
      }

      // Step 9: Print per-source report
      console.log('Sources:');
      for (const source of config.sources) {
        const tracked = trackedCountBySource.get(source.name) ?? 0;
        const pending = pendingCountBySource.get(source.name) ?? 0;
        console.log(`  ${source.name}: ${tracked} files tracked, ${pending} pending`);
      }
      console.log('');

      // Step 10: Print totals
      if (diffResult.toSync.length > 0) {
        console.log(`${diffResult.toSync.length} file(s) pending sync`);
      } else {
        console.log('All files up to date.');
      }
    });

  return cmd;
}
