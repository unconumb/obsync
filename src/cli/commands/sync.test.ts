import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { buildSyncCommand } from './sync';
import { runSync } from '../../sync/engine';
import { loadConfig } from '../../config/loader';
import { writeStatusFile, readStatusFile } from '../../status/store';
import { computePendingCountBySource } from '../../status/pending';
import { isProcessRunning } from '../../utils/lock';
import type { ObsyncConfig } from '../../config/types';
import type { SyncResult } from '../../sync/engine';

/**
 * Unit tests for src/cli/commands/sync.ts
 *
 * Focus: command structure, the --no-ai → noAi derivation (AI-09), and
 * status.json writes around runSync (sync-now-does-not-update-status fix).
 * Full runSync integration is covered by src/sync/engine.test.ts.
 */

vi.mock('../../config/loader', () => ({
  loadConfig: vi.fn(),
  ConfigLoadError: class ConfigLoadError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ConfigLoadError';
    }
  },
}));

vi.mock('../../sync/engine', () => ({
  runSync: vi.fn(),
}));

vi.mock('../../status/store', () => ({
  writeStatusFile: vi.fn(),
  readStatusFile: vi.fn(() => null),
}));

vi.mock('../../status/pending', () => ({
  computePendingCountBySource: vi.fn(() => new Map()),
}));

vi.mock('../../utils/lock', async () => {
  const actual = await vi.importActual<typeof import('../../utils/lock')>('../../utils/lock');
  return {
    ...actual,
    isProcessRunning: vi.fn(() => false),
  };
});

describe('buildSyncCommand — command structure', () => {
  it('returns a Command with name "sync"', () => {
    const cmd = buildSyncCommand();
    expect(cmd.name()).toBe('sync');
  });

  it('command has --no-ai option', () => {
    const cmd = buildSyncCommand();
    const noAiOption = cmd.options.find((o) => o.long === '--no-ai');
    expect(noAiOption).toBeDefined();
  });

  it('command retains --dry-run and --verbose options', () => {
    const cmd = buildSyncCommand();
    expect(cmd.options.find((o) => o.long === '--dry-run')).toBeDefined();
    expect(cmd.options.find((o) => o.long === '--verbose')).toBeDefined();
  });
});

describe('buildSyncCommand — --no-ai → noAi derivation (AI-09)', () => {
  it('commander defaults options.ai to true when --no-ai is not passed (noAi=false)', () => {
    const cmd = buildSyncCommand();
    cmd.parseOptions(['--config', 'obsync.yml']);
    const opts = cmd.opts() as { ai: boolean };
    expect(opts.ai).toBe(true);
    expect(opts.ai === false).toBe(false);
  });

  it('commander sets options.ai to false when --no-ai is passed (noAi=true)', () => {
    const cmd = buildSyncCommand();
    cmd.parseOptions(['--no-ai', '--config', 'obsync.yml']);
    const opts = cmd.opts() as { ai: boolean };
    expect(opts.ai).toBe(false);
    expect(opts.ai === false).toBe(true);
  });
});

describe('WR-02: exit code reflects errorCount', () => {
  const baseConfig: ObsyncConfig = {
    vault: { path: '/vault' },
    sources: [],
    ignore: [],
  };

  function makeSyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
    return {
      copiedCount: 0,
      addedCount: 0,
      updatedCount: 0,
      movedCount: 0,
      removedCount: 0,
      skippedCount: 0,
      unchangedCount: 0,
      errorCount: 0,
      errors: [],
      changes: [],
      aiSummaries: [],
      ...overrides,
    };
  }

  // Mutable state object captures the exit code passed to process.exit.
  // A destructured primitive would snapshot the value before the mocked
  // implementation runs (Phase 1 Plan 08 decision, STATE.md).
  let exitState: { code: number | undefined };

  beforeEach(() => {
    exitState = { code: undefined };
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitState.code = code;
      return undefined as never;
    }) as typeof process.exit);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    vi.mocked(loadConfig).mockReturnValue(baseConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(runSync).mockReset();
  });

  it('exits with code 1 when runSync resolves with errorCount > 0', async () => {
    vi.mocked(runSync).mockResolvedValue(
      makeSyncResult({
        errorCount: 2,
        errors: [
          { file: '/source/a.md', message: 'permission denied' },
          { file: '/source/b.md', message: 'read error' },
        ],
      }),
    );

    const cmd = buildSyncCommand();
    await cmd.parseAsync(['node', 'sync']);

    expect(exitState.code).toBe(1);
  });

  it('exits with code 0 when runSync resolves with errorCount === 0', async () => {
    vi.mocked(runSync).mockResolvedValue(makeSyncResult({ errorCount: 0, errors: [] }));

    const cmd = buildSyncCommand();
    await cmd.parseAsync(['node', 'sync']);

    expect(exitState.code).toBe(0);
  });
});

describe('sync-now-does-not-update-status fix: status.json writes around runSync', () => {
  const baseConfig: ObsyncConfig = {
    vault: { path: '/vault' },
    sources: [],
    ignore: [],
  };

  function makeSyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
    return {
      copiedCount: 0,
      addedCount: 1,
      updatedCount: 0,
      movedCount: 0,
      removedCount: 0,
      skippedCount: 0,
      unchangedCount: 0,
      errorCount: 0,
      errors: [],
      changes: [],
      aiSummaries: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    vi.mocked(loadConfig).mockReturnValue(baseConfig);
    vi.mocked(readStatusFile).mockReturnValue(null);
    vi.mocked(isProcessRunning).mockReturnValue(false);
    vi.mocked(writeStatusFile).mockClear();
    vi.mocked(computePendingCountBySource).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(runSync).mockReset();
  });

  it('writes status.json twice: "syncing" before runSync, then idle/error with counts after', async () => {
    vi.mocked(runSync).mockResolvedValue(makeSyncResult({ errorCount: 0 }));

    const cmd = buildSyncCommand();
    await cmd.parseAsync(['node', 'sync']);

    expect(writeStatusFile).toHaveBeenCalledTimes(2);
    const writes = vi.mocked(writeStatusFile).mock.calls.map((c) => c[0]);
    expect(writes[0]?.sync.state).toBe('syncing');
    expect(writes[1]?.sync.state).toBe('idle');
    expect(writes[1]?.sync.counts.added).toBe(1);
  });

  // sync_now-missing-config fix (Plan 10-03 Task 3): status.json's
  // configPath is this run's own resolved --config path, so the NEXT
  // `obsync sync` invocation (e.g. the widget's "Sync Now") knows which
  // config to pass via --config.
  it('writes status.json with configPath resolved from --config on both writes', async () => {
    vi.mocked(runSync).mockResolvedValue(makeSyncResult({ errorCount: 0 }));

    const cmd = buildSyncCommand();
    await cmd.parseAsync(['node', 'sync', '--config', 'custom.yml']);

    const writes = vi.mocked(writeStatusFile).mock.calls.map((c) => c[0]);
    expect(writes[0]?.configPath).toBe(path.resolve('custom.yml'));
    expect(writes[1]?.configPath).toBe(path.resolve('custom.yml'));
  });

  it('writes "error" state when runSync resolves with errorCount > 0', async () => {
    vi.mocked(runSync).mockResolvedValue(makeSyncResult({ errorCount: 1 }));

    const cmd = buildSyncCommand();
    await cmd.parseAsync(['node', 'sync']);

    const writes = vi.mocked(writeStatusFile).mock.calls.map((c) => c[0]);
    expect(writes[1]?.sync.state).toBe('error');
  });

  it('skips status.json writes entirely for --dry-run', async () => {
    vi.mocked(runSync).mockResolvedValue(makeSyncResult({ errorCount: 0 }));

    const cmd = buildSyncCommand();
    await cmd.parseAsync(['node', 'sync', '--dry-run']);

    expect(writeStatusFile).not.toHaveBeenCalled();
  });

  it('uses its own pid and port 0 when no obsync watch is running', async () => {
    vi.mocked(readStatusFile).mockReturnValue(null);
    vi.mocked(runSync).mockResolvedValue(makeSyncResult({ errorCount: 0 }));

    const cmd = buildSyncCommand();
    await cmd.parseAsync(['node', 'sync']);

    const writes = vi.mocked(writeStatusFile).mock.calls.map((c) => c[0]);
    expect(writes[0]?.pid).toBe(process.pid);
    expect(writes[0]?.port).toBe(0);
  });

  it('preserves pid/port from a live obsync watch process', async () => {
    vi.mocked(readStatusFile).mockReturnValue({
      sync: {
        state: 'idle',
        lastSyncAt: null,
        counts: { added: 0, updated: 0, moved: 0, removed: 0, unchanged: 0, errors: 0 },
        errors: [],
      },
      ai: { backend: 'none', queueDepth: 0 },
      sources: [],
      vault: { path: '/vault' },
      pid: 4242,
      port: 54321,
      updatedAt: new Date().toISOString(),
    });
    vi.mocked(isProcessRunning).mockReturnValue(true);
    vi.mocked(runSync).mockResolvedValue(makeSyncResult({ errorCount: 0 }));

    const cmd = buildSyncCommand();
    await cmd.parseAsync(['node', 'sync']);

    const writes = vi.mocked(writeStatusFile).mock.calls.map((c) => c[0]);
    expect(writes[0]?.pid).toBe(4242);
    expect(writes[0]?.port).toBe(54321);
    expect(writes[1]?.pid).toBe(4242);
    expect(writes[1]?.port).toBe(54321);
  });
});
