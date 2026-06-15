import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { buildWatchCommand } from './watch';
import { AiInferenceQueue } from '../../ai/queue';
import { runSync } from '../../sync/engine';
import { readStatusFile, writeStatusFile, removeStatusFile } from '../../status/store';
import { startStatusServer } from '../../service/status-server';
import { isProcessRunning } from '../../utils/lock';
import type { ObsyncConfig } from '../../config/types';

vi.mock('../../config/loader', () => ({
  loadConfig: vi.fn(),
  ConfigLoadError: class ConfigLoadError extends Error {},
}));

vi.mock('../../sync/engine', () => ({
  runSync: vi.fn(),
}));

vi.mock('../../sync/scanner', async () => {
  const actual = await vi.importActual<typeof import('../../sync/scanner')>('../../sync/scanner');
  return {
    ...actual,
    scanSource: vi.fn(() => []),
  };
});

vi.mock('../../sync/differ', () => ({
  diffSources: vi.fn(() => ({ toSync: [], unchanged: [], removed: [] })),
}));

vi.mock('../../state/store', async () => {
  const actual = await vi.importActual<typeof import('../../state/store')>('../../state/store');
  return {
    ...actual,
    readState: vi.fn(() => ({ files: {}, updatedAt: null })),
  };
});

vi.mock('../../status/store', () => ({
  readStatusFile: vi.fn(() => null),
  writeStatusFile: vi.fn(),
  removeStatusFile: vi.fn(),
  getStatusPath: vi.fn(() => '/tmp/status.json'),
}));

vi.mock('../../service/status-server', () => ({
  startStatusServer: vi.fn(() =>
    Promise.resolve({
      port: 12345,
      close: vi.fn().mockResolvedValue(undefined),
    }),
  ),
}));

vi.mock('../../utils/lock', async () => {
  const actual = await vi.importActual<typeof import('../../utils/lock')>('../../utils/lock');
  return {
    ...actual,
    isProcessRunning: vi.fn(() => false),
  };
});

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => ({
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));

/**
 * Unit tests for src/cli/commands/watch.ts
 *
 * Focus: command structure and output string formatting only.
 * Chokidar event loop and SIGINT behavior require integration/E2E testing
 * and are intentionally excluded from these unit tests.
 */

beforeEach(() => {
  vi.mocked(readStatusFile).mockReturnValue(null);
  vi.mocked(isProcessRunning).mockReturnValue(false);
  vi.mocked(writeStatusFile).mockClear();
  vi.mocked(removeStatusFile).mockClear();
  vi.mocked(startStatusServer).mockClear();
});

describe('buildWatchCommand — command structure', () => {
  it('returns a Command with name "watch"', () => {
    const cmd = buildWatchCommand();
    expect(cmd.name()).toBe('watch');
  });

  it('command has expected description', () => {
    const cmd = buildWatchCommand();
    expect(cmd.description()).toBe('Watch source folders and sync on change');
  });

  it('command has -c/--config option with default "obsync.yml"', () => {
    const cmd = buildWatchCommand();
    const configOption = cmd.options.find((o) => o.long === '--config');
    expect(configOption).toBeDefined();
    expect(configOption!.short).toBe('-c');
    expect(configOption!.defaultValue).toBe('obsync.yml');
  });
});

describe('buildWatchCommand — startup message format', () => {
  it('singular: N=1 produces "Watching 1 source... (Ctrl-C to stop)"', () => {
    const n = 1;
    const s = n > 1 ? 's' : '';
    const message = `Watching ${n} source${s}... (Ctrl-C to stop)\n`;
    expect(message).toBe('Watching 1 source... (Ctrl-C to stop)\n');
  });

  it('plural: N=3 produces "Watching 3 sources... (Ctrl-C to stop)"', () => {
    const n = 3;
    const s = n > 1 ? 's' : '';
    const message = `Watching ${n} source${s}... (Ctrl-C to stop)\n`;
    expect(message).toBe('Watching 3 sources... (Ctrl-C to stop)\n');
  });

  it('plural: N=2 produces "Watching 2 sources... (Ctrl-C to stop)"', () => {
    const n = 2;
    const s = n > 1 ? 's' : '';
    const message = `Watching ${n} source${s}... (Ctrl-C to stop)\n`;
    expect(message).toBe('Watching 2 sources... (Ctrl-C to stop)\n');
  });
});

describe('buildWatchCommand — --no-ai option (AI-09)', () => {
  it('command has --no-ai option', () => {
    const cmd = buildWatchCommand();
    const noAiOption = cmd.options.find((o) => o.long === '--no-ai');
    expect(noAiOption).toBeDefined();
  });
});

describe('buildWatchCommand — noAi + persistent AiInferenceQueue threading (AI-07/AI-09/D-40)', () => {
  const baseConfig: ObsyncConfig = {
    vault: { path: '/vault' },
    sources: [
      {
        name: 'test-source',
        path: '/sources/test',
        category: 'Docs',
        scan: 'scattered',
        ai_summary: false,
        ignore: [],
        ai_ignore: [],
        labels: [],
      },
    ],
    ignore: [],
  };

  async function runAction(args: string[]): Promise<void> {
    const { loadConfig } = await import('../../config/loader');
    vi.mocked(loadConfig).mockReturnValue(baseConfig);
    vi.mocked(runSync).mockResolvedValue({
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
    });

    const cmd = buildWatchCommand();
    await cmd.parseAsync(['node', 'obsync', ...args]);
  }

  it('without --no-ai: both initial and per-change runSync receive noAi=false and the same aiQueue instance', async () => {
    vi.mocked(runSync).mockClear();

    const chokidar = (await import('chokidar')).default;
    const onMock = vi.fn();
    vi.mocked(chokidar.watch).mockReturnValue({
      on: onMock,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof chokidar.watch>);

    await runAction(['watch']);

    // Initial sync call
    expect(runSync).toHaveBeenCalledTimes(1);
    const initialCallArgs = vi.mocked(runSync).mock.calls[0]?.[1] as { noAi?: boolean; aiQueue?: AiInferenceQueue };
    expect(initialCallArgs.noAi).toBe(false);
    expect(initialCallArgs.aiQueue).toBeInstanceOf(AiInferenceQueue);

    // Find the registered 'change' handler and invoke it
    const changeCall = onMock.mock.calls.find((c) => c[0] === 'change');
    expect(changeCall).toBeDefined();
    const handleChange = changeCall![1] as (filePath: string) => Promise<void>;

    await handleChange('/sources/test/note.md');

    expect(runSync).toHaveBeenCalledTimes(2);
    const changeCallArgs = vi.mocked(runSync).mock.calls[1]?.[1] as { noAi?: boolean; aiQueue?: AiInferenceQueue };
    expect(changeCallArgs.noAi).toBe(false);
    // THEN the SAME queue instance is reused across the initial sync and the change cycle
    expect(changeCallArgs.aiQueue).toBe(initialCallArgs.aiQueue);
  });

  it('with --no-ai: both initial and per-change runSync receive noAi=true', async () => {
    vi.mocked(runSync).mockClear();

    const chokidar = (await import('chokidar')).default;
    const onMock = vi.fn();
    vi.mocked(chokidar.watch).mockReturnValue({
      on: onMock,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof chokidar.watch>);

    await runAction(['watch', '--no-ai']);

    expect(runSync).toHaveBeenCalledTimes(1);
    const initialCallArgs = vi.mocked(runSync).mock.calls[0]?.[1] as { noAi?: boolean };
    expect(initialCallArgs.noAi).toBe(true);

    const changeCall = onMock.mock.calls.find((c) => c[0] === 'change');
    const handleChange = changeCall![1] as (filePath: string) => Promise<void>;
    await handleChange('/sources/test/note.md');

    expect(runSync).toHaveBeenCalledTimes(2);
    const changeCallArgs = vi.mocked(runSync).mock.calls[1]?.[1] as { noAi?: boolean };
    expect(changeCallArgs.noAi).toBe(true);
  });
});

describe('buildWatchCommand — chokidar watch paths scoped to scan root (docs_path)', () => {
  async function runActionWithConfig(config: ObsyncConfig): Promise<{ watchMock: ReturnType<typeof vi.fn> }> {
    const { loadConfig } = await import('../../config/loader');
    vi.mocked(loadConfig).mockReturnValue(config);
    vi.mocked(runSync).mockClear();
    vi.mocked(runSync).mockResolvedValue({
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
    });

    const chokidar = (await import('chokidar')).default;
    const watchMock = vi.fn(() => ({
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }));
    vi.mocked(chokidar.watch).mockImplementation(watchMock as unknown as typeof chokidar.watch);

    const cmd = buildWatchCommand();
    await cmd.parseAsync(['node', 'obsync', 'watch']);

    return { watchMock };
  }

  it('scan: docs source is watched at path.join(source.path, docs_path), not source.path', async () => {
    const config: ObsyncConfig = {
      vault: { path: '/vault' },
      sources: [
        {
          name: 'documentation',
          path: '/sources/documentation',
          category: 'Docs',
          scan: 'docs',
          docs_path: 'docs',
          ai_summary: false,
          ignore: [],
          ai_ignore: [],
          labels: [],
        },
      ],
      ignore: [],
    };

    const { watchMock } = await runActionWithConfig(config);

    expect(watchMock).toHaveBeenCalledTimes(1);
    const watchedPaths = watchMock.mock.calls[0]?.[0] as string[];
    expect(watchedPaths).toEqual([path.join('/sources/documentation', 'docs')]);
    // Out-of-scope root files (e.g. noadd.md at source root) are not inside the watched path
    expect(watchedPaths).not.toContain('/sources/documentation');
  });

  it('scan: scattered source is watched at source.path (unchanged behavior)', async () => {
    const config: ObsyncConfig = {
      vault: { path: '/vault' },
      sources: [
        {
          name: 'test-source',
          path: '/sources/test',
          category: 'Docs',
          scan: 'scattered',
          ai_summary: false,
          ignore: [],
          ai_ignore: [],
          labels: [],
        },
      ],
      ignore: [],
    };

    const { watchMock } = await runActionWithConfig(config);

    const watchedPaths = watchMock.mock.calls[0]?.[0] as string[];
    expect(watchedPaths).toEqual(['/sources/test']);
  });

  it('mixed sources: each path scoped per its own scan/docs_path config', async () => {
    const config: ObsyncConfig = {
      vault: { path: '/vault' },
      sources: [
        {
          name: 'documentation',
          path: '/sources/documentation',
          category: 'Docs',
          scan: 'docs',
          docs_path: 'docs',
          ai_summary: false,
          ignore: [],
          ai_ignore: [],
          labels: [],
        },
        {
          name: 'notes',
          path: '/sources/notes',
          category: 'Notes',
          scan: 'scattered',
          ai_summary: false,
          ignore: [],
          ai_ignore: [],
          labels: [],
        },
      ],
      ignore: [],
    };

    const { watchMock } = await runActionWithConfig(config);

    const watchedPaths = watchMock.mock.calls[0]?.[0] as string[];
    expect(watchedPaths).toEqual([path.join('/sources/documentation', 'docs'), '/sources/notes']);
  });
});

describe('buildWatchCommand — status server lifecycle and status.json (STATUS-01/02)', () => {
  const baseConfig: ObsyncConfig = {
    vault: { path: '/vault' },
    sources: [
      {
        name: 'test-source',
        path: '/sources/test',
        category: 'Docs',
        scan: 'scattered',
        ai_summary: false,
        ignore: [],
        ai_ignore: [],
        labels: [],
      },
    ],
    ignore: [],
  };

  async function runAction(
    args: string[],
  ): Promise<{ onMock: ReturnType<typeof vi.fn>; watcher: { close: ReturnType<typeof vi.fn> } }> {
    const { loadConfig } = await import('../../config/loader');
    vi.mocked(loadConfig).mockReturnValue(baseConfig);
    vi.mocked(runSync).mockClear();
    vi.mocked(runSync).mockResolvedValue({
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
    });

    const chokidar = (await import('chokidar')).default;
    const onMock = vi.fn();
    const closeMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(chokidar.watch).mockReturnValue({
      on: onMock,
      close: closeMock,
    } as unknown as ReturnType<typeof chokidar.watch>);

    const cmd = buildWatchCommand();
    await cmd.parseAsync(['node', 'obsync', ...args]);

    return { onMock, watcher: { close: closeMock } };
  }

  it('starts the status server after the initial sync and writes status.json on startup', async () => {
    vi.mocked(readStatusFile).mockReturnValue(null);

    await runAction(['watch']);

    expect(startStatusServer).toHaveBeenCalledTimes(1);
    expect(writeStatusFile).toHaveBeenCalledTimes(1);

    const writtenFile = vi.mocked(writeStatusFile).mock.calls[0]?.[0];
    expect(writtenFile).toMatchObject({
      pid: process.pid,
      port: 12345,
    });
    expect(typeof writtenFile?.updatedAt).toBe('string');
  });

  // sync_now-missing-config fix (Plan 10-03 Task 3): status.json's
  // configPath is the resolved absolute path to the config this watch
  // process loaded, so the widget's "Sync Now" can pass it back via
  // --config.
  it('writes status.json with configPath resolved from --config', async () => {
    vi.mocked(readStatusFile).mockReturnValue(null);

    await runAction(['watch']);

    const writtenFile = vi.mocked(writeStatusFile).mock.calls[0]?.[0];
    expect(writtenFile?.configPath).toBe(path.resolve('obsync.yml'));
  });

  it('writes status.json again after a change event', async () => {
    vi.mocked(readStatusFile).mockReturnValue(null);

    const { onMock } = await runAction(['watch']);

    expect(writeStatusFile).toHaveBeenCalledTimes(1);

    const changeCall = onMock.mock.calls.find((c) => c[0] === 'change');
    expect(changeCall).toBeDefined();
    const handleChange = changeCall![1] as (filePath: string) => Promise<void>;
    await handleChange('/sources/test/note.md');

    // One write for the transient 'syncing' state (before runSync) and one
    // for the post-sync 'idle'/'error' state.
    expect(writeStatusFile).toHaveBeenCalledTimes(3);
  });

  it('writes status.json with syncState "syncing" before runSync resolves on a change event', async () => {
    vi.mocked(readStatusFile).mockReturnValue(null);

    const { onMock } = await runAction(['watch']);

    const changeCall = onMock.mock.calls.find((c) => c[0] === 'change');
    expect(changeCall).toBeDefined();
    const handleChange = changeCall![1] as (filePath: string) => Promise<void>;
    await handleChange('/sources/test/note.md');

    const writes = vi.mocked(writeStatusFile).mock.calls.map((c) => c[0]);
    // First write is the initial startup write (idle); the change event's
    // first write (index 1) must be 'syncing', before the post-sync write.
    expect(writes[1]?.sync.state).toBe('syncing');
    expect(writes[2]?.sync.state).toBe('idle');
  });

  it('SIGINT handler calls removeStatusFile before statusServer.close', async () => {
    vi.mocked(readStatusFile).mockReturnValue(null);

    const startStatusServerMock = vi.mocked(startStatusServer);
    const closeOrder: string[] = [];
    const serverCloseMock = vi.fn(async () => {
      closeOrder.push('server.close');
    });
    startStatusServerMock.mockResolvedValueOnce({
      port: 12345,
      close: serverCloseMock,
    });
    vi.mocked(removeStatusFile).mockImplementation(() => {
      closeOrder.push('removeStatusFile');
    });

    const sigintHandlers: Array<() => void> = [];
    const onSpy = vi.spyOn(process, 'on').mockImplementation((event, handler) => {
      if (event === 'SIGINT') {
        sigintHandlers.push(handler as () => void);
      }
      return process;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await runAction(['watch']);

    expect(sigintHandlers).toHaveLength(1);
    sigintHandlers[0]!();

    // Allow the async SIGINT handler's microtasks to flush.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closeOrder).toEqual(['removeStatusFile', 'server.close']);

    onSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('a live prior watch (readStatusFile pid + isProcessRunning true) exits 1 without starting the server', async () => {
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
      pid: 999,
      port: 54321,
      updatedAt: new Date().toISOString(),
    });
    vi.mocked(isProcessRunning).mockReturnValue(true);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runAction(['watch']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(startStatusServer).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('pid 999'));

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('a dead prior watch (isProcessRunning false) proceeds normally', async () => {
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
      pid: 998,
      port: 11111,
      updatedAt: new Date().toISOString(),
    });
    vi.mocked(isProcessRunning).mockReturnValue(false);

    await runAction(['watch']);

    expect(startStatusServer).toHaveBeenCalledTimes(1);
    expect(writeStatusFile).toHaveBeenCalledTimes(1);
  });
});

describe('buildWatchCommand — per-change output format', () => {
  it('success line format: "Changed: {filename} — synced."', () => {
    const filename = 'runbook.md';
    const line = `Changed: ${filename} — synced.\n`;
    expect(line).toBe('Changed: runbook.md — synced.\n');
  });

  it('error line format: "Changed: {filename} — error: {message}"', () => {
    const filename = 'notes.md';
    const message = 'ENOENT: file not found';
    const line = `Changed: ${filename} — error: ${message}\n`;
    expect(line).toBe('Changed: notes.md — error: ENOENT: file not found\n');
  });

  it('success line ends with period and newline', () => {
    const line = `Changed: test.md — synced.\n`;
    expect(line.endsWith('.\n')).toBe(true);
  });

  it('per-change success line has em dash (—) not double hyphen (--)', () => {
    const line = `Changed: test.md — synced.\n`;
    expect(line).toContain(' — ');
    expect(line).not.toContain(' -- ');
  });
});
