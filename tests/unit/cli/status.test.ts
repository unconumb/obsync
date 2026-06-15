import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for buildStatusCommand (src/cli/commands/status.ts).
 *
 * These tests mock the dependencies (readState, scanSource, diffSources, loadConfig)
 * to keep tests isolated from filesystem and config.
 *
 * TDD RED: tests written before implementation — all fail until status.ts is implemented.
 */

// Mock all dependencies before importing the module under test
vi.mock('../../../src/state/store', () => ({
  readState: vi.fn(),
}));

vi.mock('../../../src/sync/scanner', () => ({
  scanSource: vi.fn(),
}));

vi.mock('../../../src/sync/differ', () => ({
  diffSources: vi.fn(),
}));

vi.mock('../../../src/config/loader', () => ({
  loadConfig: vi.fn(),
  ConfigLoadError: class ConfigLoadError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ConfigLoadError';
    }
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn((p: string) => Buffer.from(`content-of-${p}`)),
  };
});

import { readState } from '../../../src/state/store';
import { scanSource } from '../../../src/sync/scanner';
import { diffSources } from '../../../src/sync/differ';
import { loadConfig, ConfigLoadError } from '../../../src/config/loader';

const mockReadState = vi.mocked(readState);
const mockScanSource = vi.mocked(scanSource);
const mockDiffSources = vi.mocked(diffSources);
const mockLoadConfig = vi.mocked(loadConfig);

// Capture console.log and process.exit without running the real ones
interface TestActionResult {
  run: () => Promise<void>;
  logs: string[];
  state: { exitCode: number | null };
}

function buildTestAction(args: string[], configPath?: string): TestActionResult {
  const logs: string[] = [];
  const state: { exitCode: number | null } = { exitCode: null };

  const run = async () => {
    const originalLog = console.log;
    const originalError = console.error;
    const originalExit = process.exit;

    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    console.error = (...a: unknown[]) => { logs.push('[stderr] ' + a.join(' ')); };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).exit = (code: number) => { state.exitCode = code; throw new Error(`EXIT:${code}`); };

    try {
      // Build and invoke the command
      const { buildStatusCommand } = await import('../../../src/cli/commands/status');
      const cmd = buildStatusCommand();
      const argv = ['node', 'obsync', 'status', '--config', configPath ?? 'test.yml', ...args];
      await cmd.parseAsync(argv);
    } catch (err) {
      // ignore EXIT throws
      if (!(err instanceof Error && err.message.startsWith('EXIT:'))) {
        throw err;
      }
    } finally {
      console.log = originalLog;
      console.error = originalError;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process as any).exit = originalExit;
    }
  };

  return { run, logs, state };
}

describe('buildStatusCommand — unit tests', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('prints "No sync history found" when state has no files', async () => {
    mockLoadConfig.mockReturnValue({
      vault: { path: '/tmp/vault' },
      sources: [{ name: 'my-source', path: '/tmp/src', category: 'Docs', scan: 'scattered', ai_summary: false, ignore: [], labels: [] }],
      ignore: [],
    } as ReturnType<typeof loadConfig>);

    mockReadState.mockReturnValue({
      version: '1',
      updatedAt: new Date().toISOString(),
      files: {},
    });

    const { run, logs } = buildTestAction([]);
    await run();

    const output = logs.join('\n');
    expect(output).toContain('No sync history found');
  });

  it('prints "Last sync:" with human-readable timestamp when state has files', async () => {
    const syncTime = '2026-06-09T12:00:00.000Z';

    mockLoadConfig.mockReturnValue({
      vault: { path: '/tmp/vault' },
      sources: [{ name: 'my-source', path: '/tmp/src', category: 'Docs', scan: 'scattered', ai_summary: false, ignore: [], labels: [] }],
      ignore: [],
    } as ReturnType<typeof loadConfig>);

    mockReadState.mockReturnValue({
      version: '1',
      updatedAt: syncTime,
      files: {
        'my-source::notes.md': {
          hash: 'abc123',
          syncedAt: syncTime,
          gitRef: null,
          sourceName: 'my-source',
          destinationPath: '/tmp/vault/Docs/my-source/notes.md',
        },
      },
    });

    mockScanSource.mockReturnValue([]);
    mockDiffSources.mockReturnValue({ toSync: [], unchanged: [] });

    const { run, logs } = buildTestAction([]);
    await run();

    const output = logs.join('\n');
    expect(output).toContain('Last sync:');
  });

  it('shows per-source file count matching state entries for that source', async () => {
    const syncTime = '2026-06-09T12:00:00.000Z';

    mockLoadConfig.mockReturnValue({
      vault: { path: '/tmp/vault' },
      sources: [
        { name: 'source-a', path: '/tmp/a', category: 'Docs', scan: 'scattered', ai_summary: false, ignore: [], labels: [] },
        { name: 'source-b', path: '/tmp/b', category: 'Docs', scan: 'scattered', ai_summary: false, ignore: [], labels: [] },
      ],
      ignore: [],
    } as ReturnType<typeof loadConfig>);

    mockReadState.mockReturnValue({
      version: '1',
      updatedAt: syncTime,
      files: {
        'source-a::file1.md': { hash: 'h1', syncedAt: syncTime, gitRef: null, sourceName: 'source-a', destinationPath: '/v/a1' },
        'source-a::file2.md': { hash: 'h2', syncedAt: syncTime, gitRef: null, sourceName: 'source-a', destinationPath: '/v/a2' },
        'source-b::file3.md': { hash: 'h3', syncedAt: syncTime, gitRef: null, sourceName: 'source-b', destinationPath: '/v/b1' },
      },
    });

    mockScanSource.mockReturnValue([]);
    mockDiffSources.mockReturnValue({ toSync: [], unchanged: [] });

    const { run, logs } = buildTestAction([]);
    await run();

    const output = logs.join('\n');
    expect(output).toContain('source-a');
    expect(output).toContain('2 files tracked');
    expect(output).toContain('source-b');
    expect(output).toContain('1 files tracked');
  });

  it('shows pending count matching diffResult.toSync.length', async () => {
    const syncTime = '2026-06-09T12:00:00.000Z';
    const source = { name: 'proj', path: '/tmp/proj', category: 'Docs', scan: 'scattered' as const, ai_summary: false, ignore: [], labels: [] };

    mockLoadConfig.mockReturnValue({
      vault: { path: '/tmp/vault' },
      sources: [source],
      ignore: [],
    } as ReturnType<typeof loadConfig>);

    mockReadState.mockReturnValue({
      version: '1',
      updatedAt: syncTime,
      files: {
        'proj::readme.md': { hash: 'h1', syncedAt: syncTime, gitRef: null, sourceName: 'proj', destinationPath: '/v/readme.md' },
      },
    });

    // Two pending files
    const pendingFile = { sourceName: 'proj', sourcePath: '/tmp/proj', absPath: '/tmp/proj/new.md', relPath: 'new.md', category: 'Docs', labels: [], aiSummary: false };
    mockScanSource.mockReturnValue([pendingFile]);
    mockDiffSources.mockReturnValue({ toSync: [pendingFile, pendingFile], unchanged: [] });

    const { run, logs } = buildTestAction([]);
    await run();

    const output = logs.join('\n');
    expect(output).toContain('2 file(s) pending sync');
  });

  it('shows "All files up to date" when no pending changes', async () => {
    const syncTime = '2026-06-09T12:00:00.000Z';
    const source = { name: 'proj', path: '/tmp/proj', category: 'Docs', scan: 'scattered' as const, ai_summary: false, ignore: [], labels: [] };

    mockLoadConfig.mockReturnValue({
      vault: { path: '/tmp/vault' },
      sources: [source],
      ignore: [],
    } as ReturnType<typeof loadConfig>);

    mockReadState.mockReturnValue({
      version: '1',
      updatedAt: syncTime,
      files: {
        'proj::readme.md': { hash: 'h1', syncedAt: syncTime, gitRef: null, sourceName: 'proj', destinationPath: '/v/readme.md' },
      },
    });

    mockScanSource.mockReturnValue([]);
    mockDiffSources.mockReturnValue({ toSync: [], unchanged: [] });

    const { run, logs } = buildTestAction([]);
    await run();

    const output = logs.join('\n');
    expect(output).toContain('All files up to date');
  });

  it('prints error to stderr and exits 1 when config is invalid', async () => {
    mockLoadConfig.mockImplementation(() => {
      throw new ConfigLoadError('Config file not found');
    });

    const { run, logs, state } = buildTestAction([]);
    await run();

    const output = logs.join('\n');
    expect(output).toContain('[stderr]');
    expect(state.exitCode).toBe(1);
  });
});
