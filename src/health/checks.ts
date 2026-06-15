import { checkMacFda } from './darwin';
import { checkInotifyLimit } from './linux';
import { checkWindowsPathLength } from './win32';
import type { ObsyncConfig } from '../config/types';
import type { SourceFile } from '../sync/scanner';

/**
 * runHealthChecks — XPLAT-03/04/05 orchestrator.
 *
 * Dispatches to exactly one platform-specific check based on
 * `process.platform`, using the shared scanner output (`allFiles`) per
 * D-46/D-52. This is the ONLY file in the codebase that branches on
 * `process.platform` for health checks, and the ONLY place a health-check
 * warning reaches `process.stderr.write` (D-43, D-45 — plain "Warning: ..."
 * format, with no additional prefix).
 *
 * Non-throwing and non-exiting by construction (D-44) — never blocks sync.
 * Each underlying checkX function is itself non-throwing by construction.
 *
 * @param config - Validated, path-expanded ObsyncConfig.
 * @param allFiles - Shared scanner output from the current sync run (D-46/D-52).
 */
export function runHealthChecks(config: ObsyncConfig, allFiles: SourceFile[]): void {
  let warning: string | null = null;

  if (process.platform === 'darwin') {
    warning = checkMacFda(config.sources);
  } else if (process.platform === 'linux') {
    warning = checkInotifyLimit(allFiles.length);
  } else if (process.platform === 'win32') {
    warning = checkWindowsPathLength(allFiles, config.vault.path);
  }

  if (warning) {
    process.stderr.write(`${warning}\n`);
  }
}
