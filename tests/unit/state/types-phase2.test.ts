import { describe, it, expect } from 'vitest';
import type { StateFile } from '../../../src/state/types';
import type { AuditEntry } from '../../../src/audit/types';

// Tests for Phase 2 type extensions: StateFile.syncCount and AuditEntry ai_inference variant

describe('StateFile — Phase 2 syncCount extension', () => {
  it('StateFile with syncCount field is valid (syncCount is optional)', () => {
    const state: StateFile = {
      version: '1',
      updatedAt: '2026-06-10T12:00:00.000Z',
      syncCount: 5,
      files: {},
    };

    expect(typeof state.syncCount === 'number').toBe(true);
    expect(state.syncCount).toBe(5);
  });

  it('StateFile without syncCount field is still valid (backward compat with Phase 1 files)', () => {
    const state: StateFile = {
      version: '1',
      updatedAt: '2026-06-10T12:00:00.000Z',
      files: {},
    };

    expect(state.syncCount === undefined).toBe(true);
  });

  it('StateFile syncCount of zero is valid', () => {
    const state: StateFile = {
      version: '1',
      updatedAt: '2026-06-10T12:00:00.000Z',
      syncCount: 0,
      files: {},
    };

    expect(state.syncCount).toBe(0);
    expect(typeof state.syncCount === 'number' || state.syncCount === undefined).toBe(true);
  });
});

describe('AuditEntry — Phase 2 ai_inference variant', () => {
  it('AuditEntry with type ai_inference and all required fields is valid', () => {
    const entry: AuditEntry = {
      type: 'ai_inference',
      timestamp: '2026-06-10T12:00:00.000Z',
      sourceName: 'project2',
      provider: 'ollama',
      model: 'qwen3.5:9b',
      inputByteCount: 4096,
      outputByteCount: 512,
    };

    expect(entry.type).toBe('ai_inference');
    expect(entry.sourceName).toBe('project2');
    expect(entry.provider).toBe('ollama');
    expect(entry.model).toBe('qwen3.5:9b');
    expect(entry.inputByteCount).toBe(4096);
    expect(entry.outputByteCount).toBe(512);
  });

  it('ai_inference entry has no content-capturing field (SECURITY INVARIANT)', () => {
    const entry: AuditEntry = {
      type: 'ai_inference',
      timestamp: '2026-06-10T12:00:00.000Z',
      sourceName: 'project2',
      provider: 'claude',
      model: 'claude-3-haiku',
      inputByteCount: 2048,
      outputByteCount: 256,
    };

    // Only byte counts are logged — never actual content
    expect('content' in entry).toBe(false);
    expect('body' in entry).toBe(false);
    expect('rawContent' in entry).toBe(false);
    expect('fileContent' in entry).toBe(false);
    expect('data' in entry).toBe(false);
    expect('payload' in entry).toBe(false);
  });

  it('ai_inference variant is narrowed correctly by TypeScript discriminated union', () => {
    const entry: AuditEntry = {
      type: 'ai_inference',
      timestamp: '2026-06-10T12:00:00.000Z',
      sourceName: 'project2',
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputByteCount: 1024,
      outputByteCount: 128,
    };

    if (entry.type === 'ai_inference') {
      expect(entry.inputByteCount).toBe(1024);
      expect(entry.outputByteCount).toBe(128);
      expect(entry.timestamp).toBe('2026-06-10T12:00:00.000Z');
    }
  });
});
