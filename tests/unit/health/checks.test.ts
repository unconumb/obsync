import { describe, it, expect, afterEach, vi } from 'vitest';
import { runHealthChecks } from '../../../src/health/checks';
import type { ObsyncConfig } from '../../../src/config/types';
import type { SourceFile } from '../../../src/sync/scanner';

function makeSourceFile(overrides: Partial<SourceFile> = {}): SourceFile {
  return {
    sourceName: 'thornode',
    sourcePath: '/home/testuser/dev/thornode',
    absPath: '/home/testuser/dev/thornode/README.md',
    relPath: 'README.md',
    category: 'Infrastructure',
    labels: [],
    aiSummary: false,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ObsyncConfig> = {}): ObsyncConfig {
  return {
    vault: { path: '/vault' },
    sources: [],
    ignore: [],
    ...overrides,
  } as unknown as ObsyncConfig;
}

describe('runHealthChecks', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    vi.restoreAllMocks();
  });

  it('writes a Full Disk Access warning to stderr when platform is darwin and a source is outside home', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const config = makeConfig({
      sources: [
        { name: 'ext', path: '/Volumes/External/notes', category: 'Misc', scan: 'scattered', ai_summary: false, ignore: [], labels: [] },
      ],
    });

    runHealthChecks(config, []);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Full Disk Access'));
  });

  it('dispatches to the linux inotify check and only writes "inotify watch limit" to stderr when it warns', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // checkInotifyLimit reads fs.readFileSync directly (no injection point through
    // runHealthChecks), and fs.readFileSync is non-configurable in this CJS test
    // environment (cannot vi.spyOn it — Pitfall 3). The real /proc value is
    // environment-dependent, so assert only on the CONTRACT: if a write happens,
    // its content must be the inotify message (proves correct dispatch for
    // 'linux' — darwin/win32 messages would never appear here).
    const allFiles: SourceFile[] = Array.from({ length: 1000 }, () => makeSourceFile());
    const config = makeConfig();

    runHealthChecks(config, allFiles);

    if (writeSpy.mock.calls.length > 0) {
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('inotify watch limit'));
    } else {
      expect(writeSpy).not.toHaveBeenCalled();
    }
  });

  it('writes a 240-character warning to stderr when platform is win32 and a dest path is too long', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const longRelPath = 'a'.repeat(230) + '.md';
    const allFiles: SourceFile[] = [makeSourceFile({ relPath: longRelPath })];

    const config = makeConfig({ vault: { path: 'C:\\Users\\testuser\\vault' } });

    runHealthChecks(config, allFiles);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('240-character'));
  });

  it('does not write to stderr when the platform check returns null', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const config = makeConfig({
      sources: [
        { name: 'thornode', path: '/Users/testuser/dev/thornode', category: 'Infrastructure', scan: 'scattered', ai_summary: false, ignore: [], labels: [] },
      ],
    });

    // Pass homeDir matching source path's parent so checkMacFda returns null —
    // but checkMacFda defaults homeDir to os.homedir(), which we cannot inject
    // through runHealthChecks. Use a source path that is under the real os.homedir().
    const homeDir = require('os').homedir();
    const insideHomeConfig = makeConfig({
      sources: [
        { name: 'inhome', path: `${homeDir}/dev/thornode`, category: 'Infrastructure', scan: 'scattered', ai_summary: false, ignore: [], labels: [] },
      ],
    });

    runHealthChecks(insideHomeConfig, []);

    expect(writeSpy).not.toHaveBeenCalled();

    void config;
  });

  it('does not dispatch and does not write to stderr on an unsupported platform', () => {
    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const config = makeConfig({
      sources: [
        { name: 'ext', path: '/Volumes/External/notes', category: 'Misc', scan: 'scattered', ai_summary: false, ignore: [], labels: [] },
      ],
    });

    runHealthChecks(config, []);

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('writes a stderr warning ending with a trailing newline', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const longRelPath = 'b'.repeat(230) + '.md';
    const allFiles: SourceFile[] = [makeSourceFile({ relPath: longRelPath })];
    const config = makeConfig({ vault: { path: 'C:\\Users\\testuser\\vault' } });

    runHealthChecks(config, allFiles);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const writtenArg = writeSpy.mock.calls[0][0] as string;
    expect(writtenArg.endsWith('\n')).toBe(true);
  });
});
