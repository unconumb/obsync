import { describe, it, expect } from 'vitest';
import { StatusPayloadSchema, StatusFileSchema, type StatusPayload } from './types';

const validPayload: StatusPayload = {
  sync: {
    state: 'idle',
    lastSyncAt: '2026-06-13T12:00:00.000Z',
    counts: {
      added: 1,
      updated: 2,
      moved: 0,
      removed: 0,
      unchanged: 5,
      errors: 0,
    },
    errors: [],
  },
  ai: {
    backend: 'ollama',
    queueDepth: 0,
  },
  sources: [{ name: 'project1', pendingCount: 0 }],
  vault: { path: '/Users/x/Vault' },
};

describe('StatusPayloadSchema', () => {
  it('parses a fully-populated valid object and returns the same shape', () => {
    const result = StatusPayloadSchema.parse(validPayload);
    expect(result).toEqual(validPayload);
  });

  it('rejects a negative count', () => {
    const invalid = {
      ...validPayload,
      sync: {
        ...validPayload.sync,
        counts: { ...validPayload.sync.counts, added: -1 },
      },
    };
    const result = StatusPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown sync.state value', () => {
    const invalid = {
      ...validPayload,
      sync: { ...validPayload.sync, state: 'paused' },
    };
    const result = StatusPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown ai.backend value', () => {
    const invalid = {
      ...validPayload,
      ai: { ...validPayload.ai, backend: 'gemini' },
    };
    const result = StatusPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects a payload missing the vault field', () => {
    const { vault: _vault, ...invalid } = validPayload;
    const result = StatusPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('accepts a payload with vault.path set', () => {
    const result = StatusPayloadSchema.safeParse({
      ...validPayload,
      vault: { path: '/Users/x/Vault' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects vault.path === "" (min(1) constraint)', () => {
    const invalid = {
      ...validPayload,
      vault: { path: '' },
    };
    const result = StatusPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  // sync_now-missing-config fix (Plan 10-03 Task 3): configPath is additive
  // and optional (no version bump), mirroring the vault.path precedent.
  it('accepts a payload with configPath set', () => {
    const result = StatusPayloadSchema.safeParse({
      ...validPayload,
      configPath: '/Users/x/obsync.yml',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a payload omitting configPath (backward compatible)', () => {
    const result = StatusPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.configPath).toBeUndefined();
    }
  });

  it('rejects configPath === "" (min(1) constraint)', () => {
    const invalid = {
      ...validPayload,
      configPath: '',
    };
    const result = StatusPayloadSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});

describe('StatusFileSchema', () => {
  it('accepts a StatusPayload object extended with pid/port/updatedAt', () => {
    const fileObj = {
      ...validPayload,
      pid: 12345,
      port: 4848,
      updatedAt: '2026-06-13T12:00:00.000Z',
    };
    const result = StatusFileSchema.safeParse(fileObj);
    expect(result.success).toBe(true);
  });

  it('rejects an object missing pid', () => {
    const fileObj = {
      ...validPayload,
      port: 4848,
      updatedAt: '2026-06-13T12:00:00.000Z',
    };
    const result = StatusFileSchema.safeParse(fileObj);
    expect(result.success).toBe(false);
  });
});
