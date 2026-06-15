import type { SourceFile } from './scanner';
import type { StateFile } from '../state/types';
import { toStateKey } from '../utils/paths';

/**
 * Result of diffSources — splits discovered files into those that need syncing
 * and those that are unchanged since last sync.
 */
export interface DiffResult {
  /** Files that are new or whose content hash has changed since last sync. */
  toSync: SourceFile[];
  /** Files whose content hash matches the stored state — no sync needed (SYNC-02). */
  unchanged: SourceFile[];
}

/**
 * Classify discovered source files into toSync and unchanged by comparing
 * the stored hash in state against the current content hash.
 *
 * Design decisions:
 * - contentHashFn is injected (not imported directly from hash.ts) to keep
 *   diffSources a pure function over its inputs — no filesystem coupling in
 *   unit tests (Plan 07 wires readFileSync + sha256 as the real contentHashFn).
 * - existsFn is injected (Plan 02-05) to keep diffSources a pure function —
 *   engine.ts wires fs.existsSync as the real existsFn. Used to check whether
 *   a previously-synced file's vault copy (entry.destinationPath) still exists.
 *   If the source content is unchanged but the vault copy is missing (e.g. the
 *   user deleted it), the file is routed to toSync so it gets re-copied —
 *   vault self-healing (closes Test 6 / Gap 1).
 * - Uses toStateKey to normalize path separators cross-platform (T-05-04).
 * - If contentHashFn throws (e.g. file unreadable), the file is placed in
 *   toSync with a console.warn — single file failure does not abort (SYNC-06).
 *
 * Idempotency (SYNC-02): Running diffSources twice on unchanged files always
 * produces the same unchanged list — no mtime or wall-clock comparison.
 */
export function diffSources(
  sourceFiles: SourceFile[],
  state: StateFile,
  contentHashFn: (absPath: string) => string,
  existsFn: (path: string) => boolean,
): DiffResult {
  const toSync: SourceFile[] = [];
  const unchanged: SourceFile[] = [];

  for (const sourceFile of sourceFiles) {
    const stateKey = toStateKey(sourceFile.sourceName, sourceFile.relPath);
    const entry = state.files[stateKey];

    if (entry == null) {
      // File not yet tracked in state — always sync
      toSync.push(sourceFile);
      continue;
    }

    // Compute current hash; fall back to toSync on any error (SYNC-06)
    let currentHash: string;
    try {
      currentHash = contentHashFn(sourceFile.absPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[obsync] hash error for "${sourceFile.absPath}": ${message} — scheduling for sync\n`,
      );
      toSync.push(sourceFile);
      continue;
    }

    if (entry.hash === currentHash) {
      // Hash matches, but the vault copy may have been deleted — re-sync if missing
      if (existsFn(entry.destinationPath)) {
        unchanged.push(sourceFile);
      } else {
        toSync.push(sourceFile);
      }
    } else {
      toSync.push(sourceFile);
    }
  }

  return { toSync, unchanged };
}
