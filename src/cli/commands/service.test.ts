import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import {
  buildInstallServiceCommand,
  buildUninstallServiceCommand,
  buildServiceCommand,
  currentPlatform,
  UNSUPPORTED_PLATFORM_MESSAGE,
} from './service';
import type { ObsyncConfig } from '../../config/types';

vi.mock('../../config/loader', () => ({
  loadConfig: vi.fn(),
  ConfigLoadError: class ConfigLoadError extends Error {},
}));

vi.mock('../../service/plist', () => ({
  buildPlistXml: vi.fn(() => '<plist></plist>'),
  resolveBinaryPaths: vi.fn(() => ({ nodePath: '/usr/bin/node', obsyncEntryPath: '/usr/lib/obsync/index.js' })),
  writePlistAtomic: vi.fn(),
  defaultLogPaths: vi.fn(() => ({ stdout: '/tmp/watch.out.log', stderr: '/tmp/watch.err.log' })),
  ensureLogsDir: vi.fn(),
}));

vi.mock('../../service/launchctl', () => ({
  getServiceStatus: vi.fn(() => 'not-loaded'),
  installService: vi.fn(),
  uninstallService: vi.fn(),
}));

vi.mock('../../service/systemd', () => ({
  UNIT_NAME: 'obsync-watch.service',
  buildSystemdUnit: vi.fn(() => '[Unit]\n'),
  writeSystemdUnitAtomic: vi.fn(),
  systemdUnitPath: vi.fn(() => '/home/user/.config/systemd/user/obsync-watch.service'),
  getServiceStatus: vi.fn(() => 'not-loaded'),
  installService: vi.fn(),
  uninstallService: vi.fn(),
}));

vi.mock('../../service/wrapper', () => ({
  buildWrapperScript: vi.fn(() => '#!/bin/bash\n'),
  wrapperScriptPath: vi.fn(() => '/home/user/.obsync/bin/obsync-watch'),
  writeWrapperAtomic: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    rmSync: vi.fn(),
  };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

const baseConfig: ObsyncConfig = {
  vault: { path: '/vault' },
  sources: [],
  ignore: [],
};

const ORIGINAL_PLATFORM = process.platform;

function stubPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
let exitSpy: MockInstance<typeof process.exit>;

beforeEach(async () => {
  const { loadConfig } = await import('../../config/loader');
  vi.mocked(loadConfig).mockReturnValue(baseConfig);

  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('currentPlatform', () => {
  it('returns "darwin" when process.platform is darwin', () => {
    stubPlatform('darwin');
    expect(currentPlatform()).toBe('darwin');
  });

  it('returns "linux" when process.platform is linux', () => {
    stubPlatform('linux');
    expect(currentPlatform()).toBe('linux');
  });

  it('returns "win32" when process.platform is win32', () => {
    stubPlatform('win32');
    expect(currentPlatform()).toBe('win32');
  });

  it('returns "unsupported" for any other platform', () => {
    stubPlatform('freebsd');
    expect(currentPlatform()).toBe('unsupported');
  });
});

describe('win32 — informational message, no process.exit(1) (D-06)', () => {
  beforeEach(() => {
    stubPlatform('win32');
  });

  it('install-service prints UNSUPPORTED_PLATFORM_MESSAGE to stdout and does not call process.exit(1)', async () => {
    const cmd = buildInstallServiceCommand();
    await cmd.parseAsync(['node', 'obsync', 'install-service']);

    expect(stdoutSpy).toHaveBeenCalledWith(`${UNSUPPORTED_PLATFORM_MESSAGE}\n`);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('uninstall-service prints UNSUPPORTED_PLATFORM_MESSAGE to stdout and does not call process.exit(1)', () => {
    const cmd = buildUninstallServiceCommand();
    cmd.parse(['node', 'obsync', 'uninstall-service']);

    expect(stdoutSpy).toHaveBeenCalledWith(`${UNSUPPORTED_PLATFORM_MESSAGE}\n`);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('service status prints UNSUPPORTED_PLATFORM_MESSAGE to stdout and does not call process.exit(1)', () => {
    const cmd = buildServiceCommand();
    cmd.parse(['node', 'obsync', 'status']);

    expect(stdoutSpy).toHaveBeenCalledWith(`${UNSUPPORTED_PLATFORM_MESSAGE}\n`);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });
});

describe('linux install — systemd routing (XPLAT-06)', () => {
  beforeEach(() => {
    stubPlatform('linux');
  });

  it('writes the wrapper script and installs the systemd --user unit', async () => {
    const wrapper = await import('../../service/wrapper');
    const systemd = await import('../../service/systemd');

    const cmd = buildInstallServiceCommand();
    await cmd.parseAsync(['node', 'obsync', 'install-service']);

    expect(wrapper.writeWrapperAtomic).toHaveBeenCalled();
    expect(systemd.buildSystemdUnit).toHaveBeenCalled();
    expect(systemd.writeSystemdUnitAtomic).toHaveBeenCalled();
    expect(systemd.installService).toHaveBeenCalled();
  });

  it('best-effort runs loginctl enable-linger via execFileSync', async () => {
    const { execFileSync } = await import('child_process');

    const cmd = buildInstallServiceCommand();
    await cmd.parseAsync(['node', 'obsync', 'install-service']);

    expect(execFileSync).toHaveBeenCalledWith(
      'loginctl',
      expect.arrayContaining(['enable-linger']),
      expect.anything(),
    );
  });

  it('continues successfully even if loginctl enable-linger throws', async () => {
    const { execFileSync } = await import('child_process');
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('Interactive authentication required.');
    });

    const cmd = buildInstallServiceCommand();
    await cmd.parseAsync(['node', 'obsync', 'install-service']);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('sudo loginctl enable-linger'));
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('uninstall-service calls systemd.uninstallService and removes the unit file', async () => {
    const systemd = await import('../../service/systemd');
    const fs = await import('fs');

    const cmd = buildUninstallServiceCommand();
    await cmd.parseAsync(['node', 'obsync', 'uninstall-service']);

    expect(systemd.uninstallService).toHaveBeenCalled();
    expect(fs.rmSync).toHaveBeenCalledWith(systemd.systemdUnitPath(), { force: true });
  });

  it('service status reports systemd state', async () => {
    const systemd = await import('../../service/systemd');
    vi.mocked(systemd.getServiceStatus).mockReturnValue('running');

    const cmd = buildServiceCommand();
    await cmd.parseAsync(['node', 'obsync', 'status']);

    expect(systemd.getServiceStatus).toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('is running'));
  });
});

describe('darwin install — launchd routing (existing path) + wrapper wiring (D-01)', () => {
  beforeEach(() => {
    stubPlatform('darwin');
    Object.defineProperty(process, 'getuid', { value: () => 501, configurable: true });
  });

  it('writes the wrapper script and installs the launchd agent', async () => {
    const wrapper = await import('../../service/wrapper');
    const launchctl = await import('../../service/launchctl');
    const plist = await import('../../service/plist');

    const cmd = buildInstallServiceCommand();
    await cmd.parseAsync(['node', 'obsync', 'install-service']);

    expect(wrapper.writeWrapperAtomic).toHaveBeenCalled();
    expect(plist.writePlistAtomic).toHaveBeenCalled();
    expect(launchctl.installService).toHaveBeenCalled();
  });

  it('uninstall-service calls launchctl.uninstallService and removes the plist', async () => {
    const launchctl = await import('../../service/launchctl');
    const fs = await import('fs');

    const cmd = buildUninstallServiceCommand();
    await cmd.parseAsync(['node', 'obsync', 'uninstall-service']);

    expect(launchctl.uninstallService).toHaveBeenCalled();
    expect(fs.rmSync).toHaveBeenCalled();
  });

  it('service status reports launchd state', async () => {
    const launchctl = await import('../../service/launchctl');
    vi.mocked(launchctl.getServiceStatus).mockReturnValue('running');

    const cmd = buildServiceCommand();
    await cmd.parseAsync(['node', 'obsync', 'status']);

    expect(launchctl.getServiceStatus).toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('is running'));
  });
});

describe('install-service — config load error handling (unchanged)', () => {
  it('prints config error and exits 1 on ConfigLoadError', async () => {
    stubPlatform('darwin');
    const { loadConfig, ConfigLoadError } = await import('../../config/loader');
    vi.mocked(loadConfig).mockImplementation(() => {
      throw new ConfigLoadError('bad config');
    });

    const cmd = buildInstallServiceCommand();
    await cmd.parseAsync(['node', 'obsync', 'install-service']);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('config error'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
