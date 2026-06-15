import { describe, it, expect } from 'vitest';
import { buildStatusPayload } from './build';
import { StatusPayloadSchema } from './types';
import { AiInferenceQueue } from '../ai/queue';
import type { ObsyncConfig } from '../config/types';
import type { SyncResult } from '../sync/engine';

function makeConfig(overrides: Partial<ObsyncConfig> = {}): ObsyncConfig {
  return {
    vault: { path: '/tmp/vault' },
    sources: [
      {
        name: 'source-a',
        path: '/tmp/source-a',
        category: '01-projects',
        scan: 'scattered',
        ai_summary: false,
        ignore: [],
        ai_ignore: [],
        labels: [],
      },
      {
        name: 'source-b',
        path: '/tmp/source-b',
        category: '02-areas',
        scan: 'scattered',
        ai_summary: false,
        ignore: [],
        ai_ignore: [],
        labels: [],
      },
    ],
    ignore: [],
    ...overrides,
  } as ObsyncConfig;
}

function makeSyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    copiedCount: 0,
    addedCount: 1,
    updatedCount: 2,
    movedCount: 3,
    removedCount: 4,
    skippedCount: 0,
    unchangedCount: 5,
    errorCount: 1,
    errors: [{ file: 'a.md', message: 'boom' }],
    changes: [],
    ...overrides,
  } as SyncResult;
}

describe('buildStatusPayload', () => {
  it('maps a populated SyncResult, error state, queue size 3, and two sources', () => {
    const config = makeConfig();
    const lastSyncResult = makeSyncResult();
    const pendingCountBySource = new Map<string, number>([['source-a', 2]]);

    // Stub object with a size getter for the size-3 case.
    const aiQueue = { size: 3 } as unknown as AiInferenceQueue;

    const result = buildStatusPayload({
      config,
      lastSyncResult,
      lastSyncAt: '2026-06-13T00:00:00.000Z',
      syncState: 'error',
      aiQueue,
      pendingCountBySource,
    });

    expect(result.sync.counts).toEqual({
      added: 1,
      updated: 2,
      moved: 3,
      removed: 4,
      unchanged: 5,
      errors: 1,
    });
    expect(result.sync.errors).toEqual([{ file: 'a.md', message: 'boom' }]);
    expect(result.sync.state).toBe('error');
    expect(result.ai.queueDepth).toBe(3);
    expect(result.sources).toEqual([
      { name: 'source-a', pendingCount: 2 },
      { name: 'source-b', pendingCount: 0 },
    ]);
    expect(result.vault.path).toBe(config.vault.path);

    expect(() => StatusPayloadSchema.parse(result)).not.toThrow();
  });

  it('zeroes all counts and errors for the one-shot --json case (lastSyncResult: null)', () => {
    const config = makeConfig();
    const aiQueue = new AiInferenceQueue();

    const result = buildStatusPayload({
      config,
      lastSyncResult: null,
      lastSyncAt: null,
      syncState: 'idle',
      aiQueue,
      pendingCountBySource: new Map(),
    });

    expect(result.sync.counts).toEqual({
      added: 0,
      updated: 0,
      moved: 0,
      removed: 0,
      unchanged: 0,
      errors: 0,
    });
    expect(result.sync.errors).toEqual([]);
    expect(result.sync.state).toBe('idle');
    expect(result.vault.path).toBe(config.vault.path);
    expect(() => StatusPayloadSchema.parse(result)).not.toThrow();
  });

  it('defaults ai.backend to none when config.ai is undefined', () => {
    const config = makeConfig();
    const aiQueue = new AiInferenceQueue();

    const result = buildStatusPayload({
      config,
      lastSyncResult: null,
      lastSyncAt: null,
      syncState: 'idle',
      aiQueue,
      pendingCountBySource: new Map(),
    });

    expect(result.ai.backend).toBe('none');
    expect(() => StatusPayloadSchema.parse(result)).not.toThrow();
  });

  // sync_now-missing-config fix (Plan 10-03 Task 3): configPath is additive
  // and optional — present only when the caller supplies it.
  it('includes configPath when supplied', () => {
    const config = makeConfig();
    const aiQueue = new AiInferenceQueue();

    const result = buildStatusPayload({
      config,
      lastSyncResult: null,
      lastSyncAt: null,
      syncState: 'idle',
      aiQueue,
      pendingCountBySource: new Map(),
      configPath: '/Users/testuser/obsync.yml',
    });

    expect(result.configPath).toBe('/Users/testuser/obsync.yml');
    expect(() => StatusPayloadSchema.parse(result)).not.toThrow();
  });

  it('omits configPath when not supplied', () => {
    const config = makeConfig();
    const aiQueue = new AiInferenceQueue();

    const result = buildStatusPayload({
      config,
      lastSyncResult: null,
      lastSyncAt: null,
      syncState: 'idle',
      aiQueue,
      pendingCountBySource: new Map(),
    });

    expect(result.configPath).toBeUndefined();
    expect('configPath' in result).toBe(false);
    expect(() => StatusPayloadSchema.parse(result)).not.toThrow();
  });
});
