/**
 * launchctl.ts — launchctl lifecycle wrappers (D-59).
 *
 * Dependency-injected wrappers around `launchctl bootstrap`/`bootout`/`print`
 * (modern launchd domain-targeted syntax — RESEARCH Pattern 1). All wrappers
 * accept an injectable `execFn` (default `child_process.execFileSync`) so
 * they unit-test without spawning real processes (T-05-10: argv arrays only,
 * never a shell command string — no shell interpolation).
 *
 * macOS-only (D-58) — this module performs no platform checks itself; the
 * CLI command (Plan 05) is responsible for gating invocation to darwin.
 */

import { execFileSync } from 'child_process';

type ExecFn = typeof execFileSync;

/**
 * getServiceStatus — query launchd for the current state of a launch agent.
 *
 * Returns:
 *  - 'not-loaded' if `launchctl print gui/<uid>/<label>` throws (non-zero
 *    exit — the agent is not registered with launchd)
 *  - 'running' if the output contains `state = running`
 *  - 'loaded-not-running' otherwise (agent is registered but not actively running)
 *
 * VERIFY: 'state = running' string confirmed live against launchctl print on
 * Darwin 25.3.0 in Plan 05 human-verify (Open Question 1).
 *
 * @param label - The launchd label (e.g. 'com.obsync.watch').
 * @param uid - The numeric user id (gui/<uid> domain target).
 * @param execFn - Injectable execFileSync-shaped function (default: real execFileSync).
 */
export function getServiceStatus(
  label: string,
  uid: number,
  execFn: ExecFn = execFileSync,
): 'running' | 'loaded-not-running' | 'not-loaded' {
  try {
    const output = execFn('launchctl', ['print', `gui/${uid}/${label}`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }) as unknown as string;
    return output.includes('state = running') ? 'running' : 'loaded-not-running';
  } catch {
    return 'not-loaded';
  }
}

/**
 * bootstrapService — load (register + start) the launch agent at plistPath
 * into the gui/<uid> domain.
 *
 * @param uid - The numeric user id (gui/<uid> domain target).
 * @param plistPath - Absolute path to the plist file.
 * @param execFn - Injectable execFileSync-shaped function (default: real execFileSync).
 */
export function bootstrapService(uid: number, plistPath: string, execFn: ExecFn = execFileSync): void {
  execFn('launchctl', ['bootstrap', `gui/${uid}`, plistPath], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * bootoutService — unload (stop + unregister) the launch agent identified by
 * label from the gui/<uid> domain.
 *
 * @param uid - The numeric user id (gui/<uid> domain target).
 * @param label - The launchd label (e.g. 'com.obsync.watch').
 * @param execFn - Injectable execFileSync-shaped function (default: real execFileSync).
 */
export function bootoutService(uid: number, label: string, execFn: ExecFn = execFileSync): void {
  execFn('launchctl', ['bootout', `gui/${uid}/${label}`], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * installService — idempotent install (Pitfall 3).
 *
 * Calls bootoutService FIRST, swallowing any error ("no such process" is
 * expected and harmless on first install — the agent isn't loaded yet),
 * THEN calls bootstrapService. This makes re-running install-service safe
 * after editing obsync.yml or the plist.
 *
 * launchd's domain teardown after `bootout` is asynchronous: an immediate
 * `bootstrap` can fail with "Bootstrap failed: 5: Input/output error" while
 * the prior instance is still unregistering (live-verified, Plan 05
 * checkpoint). Retry bootstrap with a short delay to absorb this race.
 *
 * @param uid - The numeric user id (gui/<uid> domain target).
 * @param label - The launchd label (e.g. 'com.obsync.watch').
 * @param plistPath - Absolute path to the plist file.
 * @param execFn - Injectable execFileSync-shaped function (default: real execFileSync).
 */
const BOOTSTRAP_RETRY_ATTEMPTS = 3;
const BOOTSTRAP_RETRY_DELAY_SECONDS = '0.5';

export function installService(
  uid: number,
  label: string,
  plistPath: string,
  execFn: ExecFn = execFileSync,
): void {
  try {
    bootoutService(uid, label, execFn);
  } catch {
    // Expected on first install — "no such process" / not yet loaded.
  }

  for (let attempt = 1; attempt <= BOOTSTRAP_RETRY_ATTEMPTS; attempt++) {
    try {
      bootstrapService(uid, plistPath, execFn);
      return;
    } catch (err) {
      if (attempt === BOOTSTRAP_RETRY_ATTEMPTS) throw err;
      execFn('sleep', [BOOTSTRAP_RETRY_DELAY_SECONDS], { encoding: 'utf-8', stdio: 'ignore' });
    }
  }
}

/**
 * uninstallService — unload the launch agent (alias for bootoutService).
 *
 * @param uid - The numeric user id (gui/<uid> domain target).
 * @param label - The launchd label (e.g. 'com.obsync.watch').
 * @param execFn - Injectable execFileSync-shaped function (default: real execFileSync).
 */
export function uninstallService(uid: number, label: string, execFn: ExecFn = execFileSync): void {
  bootoutService(uid, label, execFn);
}
