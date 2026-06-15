/**
 * wrapper.ts — `exec -a Obsync` wrapper-script generation and atomic write (D-01).
 *
 * Generates a small `#!/bin/bash` wrapper script that re-execs the node
 * process under the argv[0] "Obsync" (via `exec -a`), so `ps`/Activity
 * Monitor show "Obsync" instead of "node" for the background watch agent.
 * Written atomically (mkdir + tmp-write + rename) with the executable bit
 * set (mode 0o755), since this script is invoked directly by
 * launchd/systemd.
 *
 * Cross-platform (D-01) — consumed by both the launchd (Plan 02 darwin
 * path) and systemd (Plan 02 linux path) service installers.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Parameters for buildWrapperScript — all dynamic values are
 * current-user-controlled filesystem paths (process.execPath /
 * fs.realpathSync(process.argv[1]) / path.resolve), double-quoted in the
 * generated script for space/word-split safety (T-11-01).
 */
export interface WrapperParams {
  nodePath: string;
  obsyncEntryPath: string;
  configPath: string;
}

/**
 * buildWrapperScript — generate the `exec -a Obsync` wrapper script body.
 *
 * Uses `#!/bin/bash` (NOT `#!/bin/sh` — Pitfall 3 / Assumption A2): `exec -a`
 * is a bash/zsh builtin extension and is unverified under `dash` (Debian/
 * Ubuntu's `/bin/sh`). All four dynamic values are double-quoted.
 *
 * @param params - Resolved node binary path, obsync entry script path, and
 *   config file path.
 * @returns The complete wrapper script source as a string.
 */
export function buildWrapperScript(params: WrapperParams): string {
  return `#!/bin/bash
exec -a "Obsync" "${params.nodePath}" "${params.obsyncEntryPath}" watch --config "${params.configPath}"
`;
}

/**
 * wrapperScriptPath — the fixed install location for the wrapper script.
 *
 * @param homeDir - The user's home directory; defaults to `os.homedir()`.
 * @returns Absolute path to `~/.obsync/bin/obsync-watch`.
 */
export function wrapperScriptPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.obsync', 'bin', 'obsync-watch');
}

/**
 * writeWrapperAtomic — write the wrapper script to disk atomically with the
 * executable bit set.
 *
 * Creates the parent directory (e.g. `~/.obsync/bin/`) if it does not
 * exist, then writes to a `.obsync.tmp` sibling file with mode 0o755 and
 * renames it into place. Mirrors `writePlistAtomic` (plist.ts) but adds the
 * `{ mode: 0o755 }` write option — the wrapper MUST be executable, unlike a
 * plist or systemd unit file.
 *
 * @param scriptPath - Absolute path where the wrapper script should be written.
 * @param content - The wrapper script content (from buildWrapperScript).
 */
export function writeWrapperAtomic(scriptPath: string, content: string): void {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });

  const tmpPath = `${scriptPath}.obsync.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, { mode: 0o755 });
    fs.renameSync(tmpPath, scriptPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore — tmp may not exist */
    }
    throw err;
  }
}
