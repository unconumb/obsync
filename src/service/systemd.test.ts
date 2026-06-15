import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildSystemdUnit,
  writeSystemdUnitAtomic,
  systemdUnitPath,
  getServiceStatus,
  installService,
  uninstallService,
  defaultLogPaths,
  ensureLogsDir,
  UNIT_NAME,
  type SystemdUnitParams,
} from './systemd';

type ExecFn = typeof execFileSync;

const baseParams: SystemdUnitParams = {
  description: 'obsync watch agent',
  execStart: '/Users/testuser/.obsync/bin/obsync-watch',
  workingDirectory: '/Users/testuser/project',
  stdoutPath: '/Users/testuser/.obsync/logs/watch.out.log',
  stderrPath: '/Users/testuser/.obsync/logs/watch.err.log',
};

const UNIT_PATH = '/Users/testuser/.config/systemd/user/obsync-watch.service';

describe('UNIT_NAME', () => {
  it('is obsync-watch.service', () => {
    expect(UNIT_NAME).toBe('obsync-watch.service');
  });
});

describe('buildSystemdUnit', () => {
  it('contains [Unit], [Service], [Install] sections with correct directives', () => {
    const unit = buildSystemdUnit(baseParams);

    expect(unit).toContain('[Unit]');
    expect(unit).toContain(`Description=${baseParams.description}`);
    expect(unit).toContain('[Service]');
    expect(unit).toContain('Type=simple');
    expect(unit).toContain(`ExecStart=${baseParams.execStart}`);
    expect(unit).toContain(`WorkingDirectory=${baseParams.workingDirectory}`);
    expect(unit).toContain('Restart=always');
    expect(unit).toContain(`StandardOutput=append:${baseParams.stdoutPath}`);
    expect(unit).toContain(`StandardError=append:${baseParams.stderrPath}`);
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('does not use Restart=on-failure (D-04 locked)', () => {
    const unit = buildSystemdUnit(baseParams);
    expect(unit).not.toContain('on-failure');
  });

  it('does not use journald logging (D-05 locked)', () => {
    const unit = buildSystemdUnit(baseParams);
    expect(unit).not.toContain('StandardOutput=journal');
    expect(unit).not.toContain('StandardError=journal');
  });
});

describe('systemdUnitPath', () => {
  it('returns ~/.config/systemd/user/obsync-watch.service under the given homeDir', () => {
    expect(systemdUnitPath('/Users/testuser')).toBe(
      path.join('/Users/testuser', '.config', 'systemd', 'user', UNIT_NAME),
    );
  });

  it('defaults to os.homedir() when homeDir is not provided', () => {
    expect(systemdUnitPath()).toBe(path.join(os.homedir(), '.config', 'systemd', 'user', UNIT_NAME));
  });
});

describe('writeSystemdUnitAtomic', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-systemd-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the parent directory if it does not exist', () => {
    const unitPath = path.join(tmpDir, 'nested', 'systemd', 'user', UNIT_NAME);
    const content = buildSystemdUnit(baseParams);

    writeSystemdUnitAtomic(unitPath, content);

    expect(fs.existsSync(unitPath)).toBe(true);
    expect(fs.readFileSync(unitPath, 'utf-8')).toBe(content);
  });

  it('does not leave a .obsync.tmp file behind on success', () => {
    const unitPath = path.join(tmpDir, UNIT_NAME);
    writeSystemdUnitAtomic(unitPath, buildSystemdUnit(baseParams));

    expect(fs.existsSync(`${unitPath}.obsync.tmp`)).toBe(false);
  });

  it('overwrites an existing unit file', () => {
    const unitPath = path.join(tmpDir, UNIT_NAME);
    writeSystemdUnitAtomic(unitPath, 'old content');
    writeSystemdUnitAtomic(unitPath, 'new content');

    expect(fs.readFileSync(unitPath, 'utf-8')).toBe('new content');
  });

  it('does not set the executable bit (unlike writeWrapperAtomic)', () => {
    const unitPath = path.join(tmpDir, UNIT_NAME);
    writeSystemdUnitAtomic(unitPath, buildSystemdUnit(baseParams));

    const mode = fs.statSync(unitPath).mode;
    expect(mode & 0o111).toBe(0);
  });
});

describe('getServiceStatus', () => {
  it('returns "not-loaded" when execFn throws', () => {
    const execFn = vi.fn(() => {
      throw new Error('Unit obsync-watch.service could not be found.');
    }) as unknown as ExecFn;

    expect(getServiceStatus(execFn)).toBe('not-loaded');
  });

  it('returns "running" when systemctl is-active returns "active"', () => {
    const execFn = vi.fn(() => 'active\n') as unknown as ExecFn;
    expect(getServiceStatus(execFn)).toBe('running');
  });

  it('returns "loaded-not-running" when output is not "active"', () => {
    const execFn = vi.fn(() => 'inactive\n') as unknown as ExecFn;
    expect(getServiceStatus(execFn)).toBe('loaded-not-running');
  });

  it('calls execFn with systemctl --user is-active obsync-watch.service', () => {
    const execFn = vi.fn(() => 'active\n') as unknown as ExecFn;

    getServiceStatus(execFn);

    expect(execFn).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'is-active', UNIT_NAME],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });
});

describe('installService', () => {
  it('calls daemon-reload BEFORE enable --now (Pitfall 2)', () => {
    const calls: string[][] = [];
    const execFn = vi.fn((cmd: string, args: readonly string[]) => {
      calls.push([cmd, ...args]);
      return '';
    }) as unknown as ExecFn;

    installService(UNIT_PATH, execFn);

    expect(calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', UNIT_NAME],
    ]);
  });

  it('runs daemon-reload before enable --now on every call, not just the first', () => {
    const calls: string[][] = [];
    const execFn = vi.fn((cmd: string, args: readonly string[]) => {
      calls.push([cmd, ...args]);
      return '';
    }) as unknown as ExecFn;

    installService(UNIT_PATH, execFn);
    installService(UNIT_PATH, execFn);

    expect(calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', UNIT_NAME],
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', UNIT_NAME],
    ]);
  });
});

describe('uninstallService', () => {
  it('calls systemctl --user disable --now obsync-watch.service', () => {
    const execFn = vi.fn(() => '') as unknown as ExecFn;

    uninstallService(execFn);

    expect(execFn).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'disable', '--now', UNIT_NAME],
      expect.any(Object),
    );
  });

  it('swallows a thrown error (unit-not-loaded expected on first uninstall)', () => {
    const execFn = vi.fn(() => {
      throw new Error('Unit obsync-watch.service not loaded.');
    }) as unknown as ExecFn;

    expect(() => uninstallService(execFn)).not.toThrow();
  });
});

describe('re-exported plist helpers', () => {
  it('re-exports defaultLogPaths from plist.ts', () => {
    const { stdout, stderr } = defaultLogPaths('/Users/testuser');
    expect(stdout).toBe(path.join('/Users/testuser', '.obsync', 'logs', 'watch.out.log'));
    expect(stderr).toBe(path.join('/Users/testuser', '.obsync', 'logs', 'watch.err.log'));
  });

  it('re-exports ensureLogsDir from plist.ts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-systemd-logs-test-'));
    try {
      ensureLogsDir(tmpDir);
      expect(fs.existsSync(path.join(tmpDir, '.obsync', 'logs'))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
