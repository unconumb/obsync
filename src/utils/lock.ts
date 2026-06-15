/**
 * lock.ts — PID-based lock file for category-change reconciliation (VCAT-07).
 *
 * D-12/D-13: a hand-rolled lock guarding the category-change pre-pass's
 * copy-then-delete writes in `runSync`. Writes the current process's PID to
 * `sync.lock`; on conflict, probes liveness via `process.kill(pid, 0)`
 * [CITED: https://nodejs.org/api/process.html#processkillpid-signal —
 * "process.kill() ... can be used to test for the existence of a process"].
 *
 * `getLockPath` replicates `getStateDir`'s `OBSYNC_STATE_DIR` env override
 * (src/state/store.ts) exactly, for the same test-isolation reasons.
 *
 * Uses synchronous `fs` to match the atomic-write conventions in
 * src/state/store.ts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * getLockPath — absolute path to the sync lock file.
 *
 * Returns `${OBSYNC_STATE_DIR}/sync.lock` when the env var is set (test
 * isolation, mirrors getStateDir), else `~/.obsync/sync.lock`.
 */
export function getLockPath(): string {
  return process.env['OBSYNC_STATE_DIR']
    ? path.join(process.env['OBSYNC_STATE_DIR'], 'sync.lock')
    : path.join(os.homedir(), '.obsync', 'sync.lock');
}

/**
 * LockConflictError — thrown by acquireLock when a live process already
 * holds the lock (fail closed, D-13).
 */
export class LockConflictError extends Error {}

/**
 * isProcessRunning — liveness probe via `process.kill(pid, 0)`.
 *
 * ESRCH = no such process -> not running (stale lock, safe to clear).
 * Any other error (notably EPERM — process exists but owned by another
 * user/elevated context) is intentionally treated as "running" (fail
 * closed) — see 08-RESEARCH.md Pitfall 2. This means a stuck lock from a
 * different user's process can never be auto-cleared, which is the
 * accepted residual risk for a single-user personal CLI tool.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * acquireLock — write this process's PID to the lock file (D-12/D-13).
 *
 * If the lock file already exists:
 *   - if the recorded PID is not a finite number, or
 *     `process.kill(otherPid, 0)` throws ESRCH (process not running),
 *     the lock is stale — remove it and proceed.
 *   - otherwise the other process is running -> throw LockConflictError
 *     (fail closed, T-08-01: never pass an unvalidated PID to process.kill
 *     without the Number.isFinite guard).
 *
 * Creates the lock directory (recursive) if it does not exist.
 *
 * @throws {LockConflictError} if a live process already holds the lock.
 */
export function acquireLock(): void {
  const lockPath = getLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  if (fs.existsSync(lockPath)) {
    const raw = fs.readFileSync(lockPath, 'utf-8').trim();
    const otherPid = Number.parseInt(raw, 10);
    if (Number.isFinite(otherPid) && isProcessRunning(otherPid)) {
      throw new LockConflictError(
        `sync.lock held by running process ${otherPid} — refusing category-change reconciliation`,
      );
    }
    // Stale or garbage lock — remove and proceed.
    fs.unlinkSync(lockPath);
  }

  fs.writeFileSync(lockPath, String(process.pid), 'utf-8');
}

/**
 * releaseLock — remove the lock file if present (no-op if absent).
 */
export function releaseLock(): void {
  const lockPath = getLockPath();
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath);
  }
}
