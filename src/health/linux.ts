import * as fs from 'fs';

/** Path to the kernel's per-user inotify watch limit (D-48). */
const INOTIFY_LIMIT_PATH = '/proc/sys/fs/inotify/max_user_watches';

/** Warn when scanned file count exceeds this fraction of the limit (D-47). */
const WARN_THRESHOLD_RATIO = 0.8;

/**
 * Internal options for checkInotifyLimit — test injection only (Pitfall 3).
 * Avoids global `vi.mock('fs')`, which would break sibling test files.
 */
export interface InotifyCheckOptions {
  _readFileSync?: (path: string, encoding: 'utf-8') => string;
}

/**
 * checkInotifyLimit — XPLAT-04 / D-46/D-47/D-48/D-49.
 *
 * Warns when `fileCount` exceeds 80% of `/proc/sys/fs/inotify/max_user_watches`.
 * If the file can't be read (permissions, container, non-Linux), returns
 * null silently per D-49 — no warning, no debug log. Malformed or
 * non-positive limit values are also treated as "skip silently" (defensive
 * input validation).
 *
 * Pure aside from the single error-isolated `/proc` read. Never throws,
 * never calls process.exit (D-44). Does not branch on process.platform —
 * the orchestrator (Plan 02) owns dispatch.
 *
 * @param fileCount - Total number of files from the shared scanner output (D-46).
 * @param opts - Optional `_readFileSync` injection for tests.
 * @returns A one-line warning string, or null if no warning is needed.
 */
export function checkInotifyLimit(
  fileCount: number,
  opts: InotifyCheckOptions = {},
): string | null {
  const readFileSync = opts._readFileSync ?? fs.readFileSync;

  let raw: string;
  try {
    raw = readFileSync(INOTIFY_LIMIT_PATH, 'utf-8');
  } catch {
    return null; // D-49: silent skip
  }

  const limit = parseInt(raw.trim(), 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    return null; // defensive: malformed or non-positive value, skip silently
  }

  if (fileCount > limit * WARN_THRESHOLD_RATIO) {
    return (
      `Warning: ${fileCount} files exceed 80% of the inotify watch limit ` +
      `(${limit}) — 'obsync watch' may silently stop watching new files. ` +
      `Increase fs.inotify.max_user_watches in /etc/sysctl.conf.`
    );
  }

  return null;
}
