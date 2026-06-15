/**
 * plist.ts — launchd plist generation, escaping, and atomic write (D-59/D-60).
 *
 * Generates the static-shape KeepAlive launchd plist for `obsync watch`
 * (D-57), with all dynamic path/string values XML-escaped (T-05-08) and
 * written atomically (mkdir + tmp-write + rename, no chmod — plist is not
 * a secret).
 *
 * macOS-only (D-58) — this module performs no platform checks itself; the
 * CLI command (Plan 05) is responsible for gating invocation to darwin.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Parameters for buildPlistXml — all dynamic values are XML-escaped before
 * insertion into the template.
 */
export interface PlistParams {
  label: string;
  nodePath: string;
  obsyncEntryPath: string;
  configPath: string;
  workingDir: string;
  stdoutPath: string;
  stderrPath: string;
}

/**
 * escapeXml — escape XML-special characters for safe insertion into plist
 * string values (T-05-08).
 *
 * Order matters: '&' must be escaped FIRST, otherwise the '&' produced by
 * escaping '<'/'>' would itself be re-escaped (double-escaping).
 *
 * @param s - Raw string value (e.g. a filesystem path).
 * @returns The string with `&`, `<`, `>` replaced by their XML entities.
 */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * buildPlistXml — generate the full launchd plist XML for `obsync watch`.
 *
 * Produces a KeepAlive (D-57), RunAtLoad agent with ProgramArguments =
 * [nodePath, obsyncEntryPath, 'watch', '--config', configPath] and
 * StandardOutPath/StandardErrorPath set to the D-60 log paths. Every
 * dynamic value is passed through escapeXml() before insertion.
 *
 * @param params - Resolved label, binary paths, config path, working
 *   directory, and log paths.
 * @returns The complete plist XML document as a string.
 */
export function buildPlistXml(params: PlistParams): string {
  const label = escapeXml(params.label);
  const nodePath = escapeXml(params.nodePath);
  const obsyncEntryPath = escapeXml(params.obsyncEntryPath);
  const configPath = escapeXml(params.configPath);
  const workingDir = escapeXml(params.workingDir);
  const stdoutPath = escapeXml(params.stdoutPath);
  const stderrPath = escapeXml(params.stderrPath);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${obsyncEntryPath}</string>
    <string>watch</string>
    <string>--config</string>
    <string>${configPath}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${workingDir}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${stdoutPath}</string>

  <key>StandardErrorPath</key>
  <string>${stderrPath}</string>
</dict>
</plist>
`;
}

/**
 * resolveBinaryPaths — resolve the absolute paths to insert into
 * ProgramArguments[0] and ProgramArguments[1].
 *
 * `nodePath` is `process.execPath` (the running node binary — works
 * regardless of homebrew/nvm/fnm/volta install location, per RESEARCH
 * Anti-Patterns).
 *
 * `obsyncEntryPath` is `fs.realpathSync(process.argv[1])` — for a
 * globally-installed `obsync` CLI, `process.argv[1]` is the path to the
 * invoked script (often a homebrew/npm symlink); `realpathSync` follows
 * the symlink to the real `dist/cli/index.js` (RESEARCH A3 assumption —
 * the CLI command in Plan 05 should verify the resolved path ends in
 * `.js`, not a shell shim, before writing the plist).
 *
 * @returns The resolved node binary path and obsync entry script path.
 */
export function resolveBinaryPaths(): { nodePath: string; obsyncEntryPath: string } {
  return {
    nodePath: process.execPath,
    obsyncEntryPath: fs.realpathSync(process.argv[1]),
  };
}

/**
 * writePlistAtomic — write plist content to disk atomically.
 *
 * Creates the parent directory (e.g. `~/Library/LaunchAgents/`) if it does
 * not exist (Pitfall 2), then writes to a `.obsync.tmp` sibling file and
 * renames it into place. No chmod is applied — a launchd plist is not a
 * secret (unlike obsync.yml's 0600 permissions).
 *
 * @param plistPath - Absolute path where the plist should be written.
 * @param content - The plist XML content (from buildPlistXml).
 */
export function writePlistAtomic(plistPath: string, content: string): void {
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const tmpPath = `${plistPath}.obsync.tmp`;
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, plistPath);
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
 * defaultLogPaths — D-60 default StandardOutPath/StandardErrorPath for the
 * `obsync watch` launchd agent, co-located with state.json/audit.log under
 * `~/.obsync/`.
 *
 * Does NOT create the logs directory itself — `writePlistAtomic` only
 * ensures the LaunchAgents directory exists. Callers that need the logs
 * directory to exist before launchd starts (so StandardOutPath/StandardErrorPath
 * can be opened) should mkdir it explicitly; this function is pure aside
 * from the `os.homedir()` default.
 *
 * `homeDir` is dependency-injected (default `os.homedir()`) per the
 * codebase convention (src/health/darwin.ts checkMacFda).
 *
 * @param homeDir - The user's home directory; defaults to `os.homedir()`.
 * @returns Absolute paths for the watch stdout/stderr log files.
 */
export function defaultLogPaths(homeDir: string = os.homedir()): {
  stdout: string;
  stderr: string;
} {
  const logsDir = path.join(homeDir, '.obsync', 'logs');
  return {
    stdout: path.join(logsDir, 'watch.out.log'),
    stderr: path.join(logsDir, 'watch.err.log'),
  };
}

/**
 * ensureLogsDir — create the `~/.obsync/logs/` directory (D-60) so launchd
 * can open StandardOutPath/StandardErrorPath on first run.
 *
 * @param homeDir - The user's home directory; defaults to `os.homedir()`.
 */
export function ensureLogsDir(homeDir: string = os.homedir()): void {
  fs.mkdirSync(path.join(homeDir, '.obsync', 'logs'), { recursive: true });
}
