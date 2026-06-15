import { Command } from 'commander';
import * as path from 'path';
import chokidar from 'chokidar';
import { loadConfig, ConfigLoadError } from '../../config/loader';
import { runSync, type SyncResult } from '../../sync/engine';
import { getScanRoot } from '../../sync/scanner';
import { AiInferenceQueue } from '../../ai/queue';
import { startStatusServer } from '../../service/status-server';
import { writeStatusFile, removeStatusFile, readStatusFile } from '../../status/store';
import { buildStatusPayload } from '../../status/build';
import { computePendingCountBySource } from '../../status/pending';
import { isProcessRunning } from '../../utils/lock';
import type { StatusPayload } from '../../status/types';

/**
 * buildWatchCommand — CLI command that watches source folders and syncs on change.
 *
 * Behavior:
 *   - Runs a full sync on startup (identical to obsync sync, including generators)
 *   - Watches all configured source paths using chokidar
 *   - On 'change' or 'add' event: runs full runSync and prints per-change line
 *   - On SIGINT: awaits watcher.close(), prints exit message, calls process.exit(0)
 *
 * Console contract (UI-SPEC §7):
 *   - Startup: "Watching {N} source{s}... (Ctrl-C to stop)\n"
 *   - Per-change success: "Changed: {filename} — synced.\n"
 *   - Per-change error: "Changed: {filename} — error: {message}\n"
 *   - Exit: "obsync watch stopped.\n"
 *
 * Requirements: STATE-03, STATE-04, STATE-05, STATE-06
 */
export function buildWatchCommand(): Command {
  const cmd = new Command('watch');

  cmd
    .description('Watch source folders and sync on change')
    .option('-c, --config <path>', 'Path to obsync.yml', 'obsync.yml')
    .option('--no-ai', 'Disable AI summarization for this watch session')
    .action(async (options: { config: string; ai: boolean }) => {
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

      // Commander maps `--no-ai` to options.ai === false (default true when
      // the flag is not passed). Derived once at startup and threaded into
      // EVERY runSync call for the session — initial sync AND every
      // debounced change (Pitfall 4: per-invocation, not per-cycle).
      const noAi = options.ai === false;

      // sync_now-missing-config fix (Plan 10-03 Task 3): resolved absolute
      // config path, surfaced on StatusPayload.configPath so the widget's
      // "Sync Now" can pass `--config <configPath>` to the spawned
      // `obsync sync`, loading the SAME config this watch process uses.
      const resolvedConfigPath = path.resolve(options.config);

      // AI-07/D-40: a single AiInferenceQueue is created once at watch
      // startup and reused across the initial sync and every debounce
      // cycle, keeping inference serialized across rapid saves for the
      // entire session.
      const aiQueue = new AiInferenceQueue();

      // D-13: startup conflict check — a live prior `obsync watch` process's
      // status.json means a second server must not bind. Dead/garbage/absent
      // status.json -> proceed (the upcoming writeStatus will overwrite it).
      const priorStatus = readStatusFile();
      const priorPidLooksValid =
        !!priorStatus && Number.isFinite(priorStatus.pid) && priorStatus.pid > 0;
      if (priorPidLooksValid && isProcessRunning(priorStatus!.pid)) {
        process.stderr.write(
          `obsync: another watch process (pid ${priorStatus.pid}) is already running\n`,
        );
        process.exit(1);
        return;
      }

      // Pitfall 4: sync-state + last-result tracking, set before/after each
      // runSync call (initial AND every debounced change). syncState reflects
      // the MOST RECENT sync result — transient, not sticky.
      let syncState: 'idle' | 'syncing' | 'error' = 'syncing';
      let lastSyncResult: SyncResult | null = null;
      let lastSyncAt: string | null = null;

      // poller-clobbers-fresh-sync-status fix (Plan 10-04): tracks this
      // process's own last status.json write so /status responses carry an
      // updatedAt the widget's poller can compare against the on-disk
      // status.json's updatedAt (which may be newer if a separate one-shot
      // `obsync sync` ran since this watch process last synced).
      let lastWrittenUpdatedAt: string | null = null;

      /** currentPayload — fresh StatusPayload via the single D-05 producer. */
      const currentPayload = (): StatusPayload =>
        buildStatusPayload({
          config,
          lastSyncResult,
          lastSyncAt,
          syncState,
          aiQueue,
          pendingCountBySource: computePendingCountBySource(config),
          configPath: resolvedConfigPath,
          updatedAt: lastWrittenUpdatedAt ?? undefined,
        });

      /**
       * writeStatus — wraps currentPayload() into the on-disk StatusFile
       * envelope (pid/port/updatedAt) and persists it (D-08, D-10).
       */
      const writeStatus = (port: number): void => {
        const updatedAt = new Date().toISOString();
        lastWrittenUpdatedAt = updatedAt;
        writeStatusFile({
          ...currentPayload(),
          pid: process.pid,
          port,
          updatedAt,
        });
      };

      // Step 1: Initial full sync (includes generator calls)
      try {
        syncState = 'syncing';
        const result = await runSync(config, {
          dryRun: false,
          verbose: false,
          noAi,
          aiQueue,
          reconcileCategoryChanges: false,
        });
        lastSyncResult = result;
        lastSyncAt = new Date().toISOString();
        syncState = result.errorCount > 0 ? 'error' : 'idle';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`obsync: error during initial sync: ${msg}\n`);
        process.exit(1);
        return;
      }

      // D-06: watch.ts is the only command that starts/stops the status
      // server, started AFTER the initial sync resolves so the first
      // status.json write (below) can include the bound port (D-08).
      const statusServer = await startStatusServer(() => currentPayload());
      writeStatus(statusServer.port);

      // Step 2: Build source paths to watch
      // Scoped to getScanRoot(s) — for scan: docs sources this is the docs_path
      // subdirectory, so file changes elsewhere under the source root do not
      // trigger watch events (matches scanSource's scan confinement).
      const sourcePaths = config.sources.map((s) => getScanRoot(s));
      const n = sourcePaths.length;

      // Step 3: Create chokidar watcher
      // awaitWriteFinish debounces rapid saves (T-02-09 / STATE-05)
      const watcher = chokidar.watch(sourcePaths, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 2000,
          pollInterval: 100,
        },
      });

      // Step 4: Print startup message after watcher is ready
      watcher.on('ready', () => {
        const s = n > 1 ? 's' : '';
        process.stdout.write(`Watching ${n} source${s}... (Ctrl-C to stop)\n`);
      });

      // Step 5: Handler for file change and add events
      const handleChange = async (filePath: string): Promise<void> => {
        const filename = path.basename(filePath);
        try {
          syncState = 'syncing';
          writeStatus(statusServer.port);
          const result = await runSync(config, {
            dryRun: false,
            verbose: false,
            noAi,
            aiQueue,
            reconcileCategoryChanges: false,
          });
          lastSyncResult = result;
          lastSyncAt = new Date().toISOString();
          syncState = result.errorCount > 0 ? 'error' : 'idle';
          writeStatus(statusServer.port);
          process.stdout.write(`Changed: ${filename} — synced.\n`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          syncState = 'error';
          writeStatus(statusServer.port);
          process.stdout.write(`Changed: ${filename} — error: ${message}\n`);
        }
      };

      watcher.on('change', handleChange);

      // 'add' events also trigger sync (new files in source dirs, per must_haves)
      watcher.on('add', handleChange);

      // Step 6: SIGINT handler — clean shutdown (STATE-06)
      process.on('SIGINT', () => {
        void (async () => {
          try {
            await watcher.close();
          } catch {
            // best-effort close; still report stop and exit
          }
          // Pitfall 2: remove status.json BEFORE closing the server — a
          // consumer should see ENOENT (clean "no status") rather than
          // ECONNREFUSED to a port status.json still advertises.
          removeStatusFile();
          await statusServer.close();
          process.stdout.write('obsync watch stopped.\n');
          process.exit(0);
        })();
      });
    });

  return cmd;
}
