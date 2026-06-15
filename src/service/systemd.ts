/**
 * systemd.ts — systemd --user unit generation + systemctl --user lifecycle
 * wrappers (XPLAT-06).
 *
 * Mirrors `launchctl.ts` (ExecFn-injected lifecycle wrappers) + `plist.ts`
 * (unit-file generation, atomic write, shared log paths) for the Linux
 * `--user` service equivalent of the macOS launchd agent. A single
 * cohesive module, since systemctl's surface (daemon-reload, enable --now,
 * disable --now, is-active) is smaller than launchd's bootstrap/bootout/
 * print trio.
 *
 * Linux-only at the CLI layer (Plan 02 is responsible for gating
 * invocation to linux) — this module performs no platform checks itself.
 *
 * Locked decisions honored:
 *  - D-03: systemd --user unit, managed via `systemctl --user`, mirroring
 *    launchd's per-user gui/<uid> domain.
 *  - D-04: Restart=always (not the more restrictive failure-only policy) —
 *    the watch agent should always be restarted on exit, matching
 *    launchd's KeepAlive semantics.
 *  - D-05: StandardOutput=append:/StandardError=append: to the shared
 *    ~/.obsync/logs paths (NOT journald) — log paths are shared with the
 *    macOS launchd agent via defaultLogPaths (plist.ts).
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type ExecFn = typeof execFileSync;

/**
 * The systemd --user unit name for the obsync watch agent.
 */
export const UNIT_NAME = 'obsync-watch.service';

/**
 * Parameters for buildSystemdUnit — interpolated values are filesystem
 * paths from resolveBinaryPaths()/path.resolve() (never contain newlines),
 * so no escaping is required for INI syntax (T-11-02).
 */
export interface SystemdUnitParams {
  description: string;
  execStart: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
}

/**
 * buildSystemdUnit — generate the full systemd --user unit file content for
 * `obsync watch`.
 *
 * Produces a `Type=simple` service with `Restart=always` (D-04, not the
 * more restrictive failure-only policy) and file-append logging via
 * `StandardOutput=append:`/`StandardError=append:` (D-05, NOT journald), enabled via
 * `WantedBy=default.target` (D-03's --user equivalent of launchd's
 * RunAtLoad).
 *
 * @param params - Resolved description, ExecStart command, working
 *   directory, and log file paths.
 * @returns The complete systemd unit file content as a string.
 */
export function buildSystemdUnit(params: SystemdUnitParams): string {
  return `[Unit]
Description=${params.description}

[Service]
Type=simple
ExecStart=${params.execStart}
WorkingDirectory=${params.workingDirectory}
Restart=always
StandardOutput=append:${params.stdoutPath}
StandardError=append:${params.stderrPath}

[Install]
WantedBy=default.target
`;
}

/**
 * systemdUnitPath — the fixed install location for the obsync-watch unit
 * file.
 *
 * @param homeDir - The user's home directory; defaults to `os.homedir()`.
 * @returns Absolute path to `~/.config/systemd/user/obsync-watch.service`.
 */
export function systemdUnitPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.config', 'systemd', 'user', UNIT_NAME);
}

/**
 * writeSystemdUnitAtomic — write the unit file to disk atomically.
 *
 * Creates the parent directory (e.g. `~/.config/systemd/user/`) if it does
 * not exist, then writes to a `.obsync.tmp` sibling file and renames it
 * into place. Mirrors `writePlistAtomic` (plist.ts) — no mode argument, a
 * systemd unit file is not executable.
 *
 * @param unitPath - Absolute path where the unit file should be written.
 * @param content - The unit file content (from buildSystemdUnit).
 */
export function writeSystemdUnitAtomic(unitPath: string, content: string): void {
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });

  const tmpPath = `${unitPath}.obsync.tmp`;
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, unitPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore — tmp may not exist */
    }
    throw err;
  }
}

/**
 * getServiceStatus — query systemd --user for the current state of the
 * obsync-watch unit.
 *
 * Returns:
 *  - 'not-loaded' if `systemctl --user is-active obsync-watch.service`
 *    throws (non-zero exit — the unit is not loaded/found)
 *  - 'running' if the output trims to `active`
 *  - 'loaded-not-running' otherwise (unit is loaded but not active)
 *
 * @param execFn - Injectable execFileSync-shaped function (default: real execFileSync).
 */
export function getServiceStatus(
  execFn: ExecFn = execFileSync,
): 'running' | 'loaded-not-running' | 'not-loaded' {
  try {
    const output = execFn('systemctl', ['--user', 'is-active', UNIT_NAME], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }) as unknown as string;
    return output.trim() === 'active' ? 'running' : 'loaded-not-running';
  } catch {
    return 'not-loaded';
  }
}

/**
 * installService — install (or re-install) the obsync-watch unit.
 *
 * Calls `systemctl --user daemon-reload` FIRST, then
 * `systemctl --user enable --now obsync-watch.service` (Pitfall 2 —
 * systemd caches unit definitions; daemon-reload MUST run before
 * enable --now on every install, not just the first).
 *
 * @param unitPath - Absolute path to the written unit file (unused by the
 *   systemctl invocations themselves — systemctl --user resolves the unit
 *   by name from ~/.config/systemd/user/ — but accepted for symmetry with
 *   the launchd installService(uid, label, plistPath, execFn) signature
 *   and to make the dependency on the unit file being written explicit).
 * @param execFn - Injectable execFileSync-shaped function (default: real execFileSync).
 */
export function installService(unitPath: string, execFn: ExecFn = execFileSync): void {
  void unitPath;

  execFn('systemctl', ['--user', 'daemon-reload'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  execFn('systemctl', ['--user', 'enable', '--now', UNIT_NAME], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * uninstallService — disable and stop the obsync-watch unit.
 *
 * Uses `disable --now` (not `stop` alone — Pitfall 1: Restart=always would
 * re-trigger a bare `stop`). Swallows a thrown error — "unit not loaded" is
 * expected and harmless on first uninstall (mirrors launchctl.ts's
 * installService bootout-swallow pattern).
 *
 * @param execFn - Injectable execFileSync-shaped function (default: real execFileSync).
 */
export function uninstallService(execFn: ExecFn = execFileSync): void {
  try {
    execFn('systemctl', ['--user', 'disable', '--now', UNIT_NAME], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Expected when the unit is not loaded (first uninstall).
  }
}

export { defaultLogPaths, ensureLogsDir } from './plist';
