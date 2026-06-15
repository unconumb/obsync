import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildStatusCommand } from './status';
import { readStatusFile } from '../../status/store';
import { isProcessRunning } from '../../utils/lock';
import { readState } from '../../state/store';
import { diffSources } from '../../sync/differ';
import { StatusPayloadSchema } from '../../status/types';
import type { ObsyncConfig } from '../../config/types';
import type { StateFile } from '../../state/types';

vi.mock('../../config/loader', () => ({
  loadConfig: vi.fn(),
  ConfigLoadError: class ConfigLoadError extends Error {},
}));

vi.mock('../../state/store', async () => {
  const actual = await vi.importActual<typeof import('../../state/store')>('../../state/store');
  return {
    ...actual,
    readState: vi.fn(),
  };
});

vi.mock('../../sync/scanner', async () => {
  const actual = await vi.importActual<typeof import('../../sync/scanner')>('../../sync/scanner');
  return {
    ...actual,
    scanSource: vi.fn(() => []),
  };
});

vi.mock('../../sync/differ', () => ({
  diffSources: vi.fn(() => ({ toSync: [], unchanged: [] })),
}));

vi.mock('../../status/store', () => ({
  readStatusFile: vi.fn(() => null),
  writeStatusFile: vi.fn(),
  removeStatusFile: vi.fn(),
  getStatusPath: vi.fn(() => '/tmp/status.json'),
}));

vi.mock('../../utils/lock', async () => {
  const actual = await vi.importActual<typeof import('../../utils/lock')>('../../utils/lock');
  return {
    ...actual,
    isProcessRunning: vi.fn(() => false),
  };
});

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

const populatedState: StateFile = {
  version: '1',
  updatedAt: '2026-06-13T12:00:00.000Z',
  files: {
    'test-source:note.md': {
      sourceName: 'test-source',
      destinationPath: 'Docs/test-source/note.md',
      hash: 'abc123',
      syncedAt: '2026-06-13T12:00:00.000Z',
      gitRef: null,
    },
  },
};

const emptyState: StateFile = {
  version: '1',
  updatedAt: null as unknown as string,
  files: {},
};

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  const { loadConfig } = await import('../../config/loader');
  vi.mocked(loadConfig).mockReturnValue(baseConfig);
  vi.mocked(readState).mockReturnValue(populatedState);
  vi.mocked(diffSources).mockReturnValue({ toSync: [], unchanged: [] } as unknown as ReturnType<typeof diffSources>);
  vi.mocked(readStatusFile).mockReturnValue(null);
  vi.mocked(isProcessRunning).mockReturnValue(false);

  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

describe('buildStatusCommand — --json flag (STATUS-03)', () => {
  it('command has --json option', () => {
    const cmd = buildStatusCommand();
    const jsonOption = cmd.options.find((o) => o.long === '--json');
    expect(jsonOption).toBeDefined();
  });

  it('prints a StatusPayloadSchema-conforming JSON payload with zero counts and populated sources[].pendingCount', async () => {
    vi.mocked(diffSources).mockReturnValue({
      toSync: [{ sourceName: 'test-source', relativePath: 'pending.md' }],
      unchanged: [],
    } as unknown as ReturnType<typeof diffSources>);

    const cmd = buildStatusCommand();
    await cmd.parseAsync(['node', 'obsync', 'status', '--json']);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(printed);

    const result = StatusPayloadSchema.safeParse(parsed);
    expect(result.success).toBe(true);

    expect(parsed.sync.counts).toEqual({
      added: 0,
      updated: 0,
      moved: 0,
      removed: 0,
      unchanged: 0,
      errors: 0,
    });
    expect(parsed.sync.state).toBe('idle');
    expect(parsed.sources).toEqual([{ name: 'test-source', pendingCount: 1 }]);
    expect(parsed.watchActive).toBe(false);
  });

  it('with a live status.json pid (isProcessRunning true) -> watchActive:true and watchPid', async () => {
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
      port: 5000,
      updatedAt: new Date().toISOString(),
    });
    vi.mocked(isProcessRunning).mockReturnValue(true);

    const cmd = buildStatusCommand();
    await cmd.parseAsync(['node', 'obsync', 'status', '--json']);

    const printed = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(printed);

    expect(parsed.watchActive).toBe(true);
    expect(parsed.watchPid).toBe(4242);
  });

  it('with a dead status.json pid (isProcessRunning false) -> watchActive:false and no watchPid', async () => {
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
      port: 5000,
      updatedAt: new Date().toISOString(),
    });
    vi.mocked(isProcessRunning).mockReturnValue(false);

    const cmd = buildStatusCommand();
    await cmd.parseAsync(['node', 'obsync', 'status', '--json']);

    const printed = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(printed);

    expect(parsed.watchActive).toBe(false);
    expect(parsed.watchPid).toBeUndefined();
  });

  it('--json with empty state (no sync history) still returns valid JSON, not the text message', async () => {
    vi.mocked(readState).mockReturnValue(emptyState);

    const cmd = buildStatusCommand();
    await cmd.parseAsync(['node', 'obsync', 'status', '--json']);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(printed);

    const result = StatusPayloadSchema.safeParse(parsed);
    expect(result.success).toBe(true);
    expect(parsed.sources).toEqual([{ name: 'test-source', pendingCount: 0 }]);
  });
});

describe('buildStatusCommand — obsync status (no --json) output unchanged (D-16)', () => {
  it('prints the plain-text "Last sync:" / "Sources:" report', async () => {
    const cmd = buildStatusCommand();
    await cmd.parseAsync(['node', 'obsync', 'status']);

    const lines = logSpy.mock.calls.map((c) => c[0] as string);
    expect(lines.some((l) => l.startsWith('Last sync:'))).toBe(true);
    expect(lines).toContain('Sources:');
    expect(lines.some((l) => l.includes('files tracked'))).toBe(true);
  });

  it('with no sync history (no --json) prints the friendly message and exits 0', async () => {
    vi.mocked(readState).mockReturnValue(emptyState);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const cmd = buildStatusCommand();
    await cmd.parseAsync(['node', 'obsync', 'status']);

    expect(logSpy).toHaveBeenCalledWith('No sync history found. Run obsync sync to start.');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
