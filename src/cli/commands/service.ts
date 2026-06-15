/**
 * service.ts — `obsync install-service` / `uninstall-service` / `service status` (D-58/D-59/D-06).
 *
 * Three-way platform dispatcher (D-06):
 *  - darwin: writes the shared exec -a Obsync wrapper script (D-01), then
 *    generates/installs a launchd KeepAlive agent whose ProgramArguments[0]
 *    points at the wrapper script instead of the node binary directly, so
 *    `ps`/Activity Monitor show "Obsync" (D-57/D-59/D-60).
 *  - linux: writes the same wrapper script, generates/installs a
 *    `systemd --user` unit (XPLAT-06) whose ExecStart is the wrapper script,
 *    and best-effort enables linger so the unit survives logout (D-03).
 *  - win32/unsupported: prints an informational message and returns without
 *    a non-zero exit (D-06) — service management is not yet available there.
 */

import { Command } from 'commander';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, ConfigLoadError } from '../../config/loader';
import {
  buildPlistXml,
  resolveBinaryPaths,
  writePlistAtomic,
  defaultLogPaths,
  ensureLogsDir,
} from '../../service/plist';
import { getServiceStatus, installService, uninstallService } from '../../service/launchctl';
import * as systemd from '../../service/systemd';
import { buildWrapperScript, wrapperScriptPath, writeWrapperAtomic } from '../../service/wrapper';

/** launchd label for the obsync watch agent (D-57/D-59). */
export const LABEL = 'com.obsync.watch';

/**
 * UNSUPPORTED_PLATFORM_MESSAGE — printed to stdout (NOT stderr) for
 * win32/unsupported platforms (D-06). Informational, not an error — the
 * command returns with exit code 0 so packaging-smoke (D-10) can skip these
 * commands on Windows without failing.
 */
export const UNSUPPORTED_PLATFORM_MESSAGE =
  'obsync: service management is not yet supported on this platform. ' +
  'Run `obsync watch` directly in a terminal to sync continuously.';

type Platform = 'darwin' | 'linux' | 'win32' | 'unsupported';

/**
 * currentPlatform — three-way platform dispatch (D-06), mirroring the
 * `process.platform` branch in src/health/checks.ts.
 *
 * @returns 'darwin' | 'linux' | 'win32' | 'unsupported'.
 */
export function currentPlatform(): Platform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'win32';
  return 'unsupported';
}

/**
 * plistPath — absolute path to the obsync watch agent's plist file under
 * the current user's LaunchAgents directory.
 */
export function plistPath(): string {
  return path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
}

/**
 * getUid — `process.getuid()`, narrowed to a non-undefined function.
 *
 * `process.getuid` is typed as optional in @types/node (it does not exist
 * on Windows); this helper is only reachable on the darwin branch, where
 * the platform is always darwin and `process.getuid` is always defined.
 *
 * A defensive runtime check converts a hypothetical `process.getuid ===
 * undefined` into a clear error message instead of an opaque
 * `TypeError: process.getuid is not a function`.
 */
function getUid(): number {
  if (typeof process.getuid !== 'function') {
    throw new Error('process.getuid is unavailable on this platform (expected darwin).');
  }
  return process.getuid();
}

/**
 * writeWrapperScript — write the shared `exec -a Obsync` wrapper script
 * (D-01) to its fixed location, resolving node/entry/config paths.
 *
 * Called on BOTH the darwin and linux install paths so the background
 * watch process shows "Obsync" instead of "node" in `ps`/Activity Monitor.
 *
 * @param configPath - The resolved (absolute) path to obsync.yml.
 */
function writeWrapperScript(configPath: string): void {
  const { nodePath, obsyncEntryPath } = resolveBinaryPaths();
  const script = buildWrapperScript({ nodePath, obsyncEntryPath, configPath });
  writeWrapperAtomic(wrapperScriptPath(), script);
}

/**
 * enableLingerBestEffort — best-effort `loginctl enable-linger` (D-03/T-11-07).
 *
 * `loginctl enable-linger` lets the systemd --user unit keep running after
 * the user logs out. It typically requires sudo/polkit on most distros
 * (A4), so this is wrapped in try/catch: failure never blocks install
 * success, and prints a doc pointer recommending the manual `sudo`
 * invocation instead.
 */
function enableLingerBestEffort(): void {
  try {
    execFileSync('loginctl', ['enable-linger', os.userInfo().username], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    process.stderr.write(
      'obsync: could not enable linger automatically (often requires sudo). ' +
        'To keep obsync running after logout, run: sudo loginctl enable-linger $(whoami)\n',
    );
  }
}

/**
 * buildInstallServiceCommand — `obsync install-service`.
 *
 * Loads the config, writes the shared wrapper script (D-01), then installs
 * a launchd agent (darwin) or systemd --user unit (linux). win32/unsupported
 * print UNSUPPORTED_PLATFORM_MESSAGE and return (D-06).
 */
export function buildInstallServiceCommand(): Command {
  const cmd = new Command('install-service');

  cmd
    .description('Install the obsync watch background service (macOS launchd / Linux systemd --user)')
    .option('-c, --config <path>', 'Path to obsync.yml', 'obsync.yml')
    .action((options: { config: string }) => {
      try {
        loadConfig(options.config);
      } catch (err) {
        if (err instanceof ConfigLoadError) {
          process.stderr.write(`obsync: config error: ${err.message}\n`);
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`obsync: unexpected error loading config: ${msg}\n`);
        }
        process.exit(1);
        return;
      }

      const platform = currentPlatform();

      if (platform === 'win32' || platform === 'unsupported') {
        process.stdout.write(`${UNSUPPORTED_PLATFORM_MESSAGE}\n`);
        return;
      }

      const configPath = path.resolve(options.config);

      try {
        ensureLogsDir();
        const { stdout, stderr } = defaultLogPaths();
        writeWrapperScript(configPath);

        if (platform === 'darwin') {
          const xml = buildPlistXml({
            label: LABEL,
            nodePath: wrapperScriptPath(),
            obsyncEntryPath: '',
            configPath,
            workingDir: process.cwd(),
            stdoutPath: stdout,
            stderrPath: stderr,
          });

          writePlistAtomic(plistPath(), xml);
          installService(getUid(), LABEL, plistPath());

          process.stdout.write(
            `obsync: installed launchd agent ${LABEL} (${plistPath()}).\n` +
              'obsync watch is now running in the background under launchd KeepAlive.\n' +
              'After rebuilding obsync, run `obsync uninstall-service && obsync install-service` to pick up changes.\n',
          );
        } else {
          const unit = systemd.buildSystemdUnit({
            description: 'obsync watch (background sync agent)',
            execStart: wrapperScriptPath(),
            workingDirectory: process.cwd(),
            stdoutPath: stdout,
            stderrPath: stderr,
          });

          systemd.writeSystemdUnitAtomic(systemd.systemdUnitPath(), unit);
          systemd.installService(systemd.systemdUnitPath());
          enableLingerBestEffort();

          process.stdout.write(
            `obsync: installed systemd --user unit ${systemd.UNIT_NAME} (${systemd.systemdUnitPath()}).\n` +
              'obsync watch is now running in the background under systemd --user.\n' +
              'After rebuilding obsync, run `obsync uninstall-service && obsync install-service` to pick up changes.\n',
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`obsync: failed to install service: ${msg}\n`);
        process.exit(1);
      }
    });

  return cmd;
}

/**
 * buildUninstallServiceCommand — `obsync uninstall-service`.
 *
 * darwin: boots the launchd agent out (ignoring "not loaded" errors) and
 * removes the plist file. linux: disables the systemd --user unit and
 * removes the unit file. win32/unsupported: prints UNSUPPORTED_PLATFORM_MESSAGE and
 * returns (D-06).
 */
export function buildUninstallServiceCommand(): Command {
  const cmd = new Command('uninstall-service');

  cmd
    .description('Uninstall the obsync watch background service (macOS launchd / Linux systemd --user)')
    .action(() => {
      const platform = currentPlatform();

      if (platform === 'win32' || platform === 'unsupported') {
        process.stdout.write(`${UNSUPPORTED_PLATFORM_MESSAGE}\n`);
        return;
      }

      if (platform === 'darwin') {
        try {
          uninstallService(getUid(), LABEL);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!/no such process/i.test(message)) {
            process.stderr.write(`obsync: warning: failed to unload launchd agent: ${message}\n`);
          }
        }

        fs.rmSync(plistPath(), { force: true });

        process.stdout.write(`obsync: uninstalled launchd agent ${LABEL} and removed ${plistPath()}.\n`);
      } else {
        systemd.uninstallService();
        fs.rmSync(systemd.systemdUnitPath(), { force: true });

        process.stdout.write(
          `obsync: uninstalled systemd --user unit ${systemd.UNIT_NAME} and removed ${systemd.systemdUnitPath()}.\n`,
        );
      }
    });

  return cmd;
}

/**
 * buildServiceCommand — `obsync service status`.
 *
 * Reports whether the obsync watch background service is running, loaded
 * but not running, or not loaded — via launchd (darwin) or
 * systemd --user (linux). win32/unsupported print UNSUPPORTED_PLATFORM_MESSAGE (D-06).
 */
export function buildServiceCommand(): Command {
  const cmd = new Command('service').description(
    'Manage the obsync watch background service (macOS launchd / Linux systemd --user)',
  );

  cmd
    .command('status')
    .description('Show the status of the obsync watch background service')
    .action(() => {
      const platform = currentPlatform();

      if (platform === 'win32' || platform === 'unsupported') {
        process.stdout.write(`${UNSUPPORTED_PLATFORM_MESSAGE}\n`);
        return;
      }

      const status = platform === 'darwin' ? getServiceStatus(LABEL, getUid()) : systemd.getServiceStatus();
      const name = platform === 'darwin' ? LABEL : systemd.UNIT_NAME;

      switch (status) {
        case 'running':
          process.stdout.write(`obsync: ${name} is running.\n`);
          break;
        case 'loaded-not-running':
          process.stdout.write(`obsync: ${name} is loaded but not running.\n`);
          break;
        case 'not-loaded':
          process.stdout.write(`obsync: ${name} is not loaded.\n`);
          break;
      }
    });

  return cmd;
}
