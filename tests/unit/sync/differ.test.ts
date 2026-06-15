import { describe, it, expect, vi } from 'vitest';
import { diffSources } from '../../../src/sync/differ';
import type { SourceFile } from '../../../src/sync/scanner';
import type { StateFile } from '../../../src/state/types';
import { toStateKey } from '../../../src/utils/paths';

function makeSourceFile(overrides: Partial<SourceFile> = {}): SourceFile {
  return {
    sourceName: 'test-source',
    sourcePath: '/src/test-source',
    absPath: '/src/test-source/readme.md',
    relPath: 'readme.md',
    category: 'Projects',
    labels: [],
    aiSummary: false,
    ...overrides,
  };
}

function makeEmptyState(): StateFile {
  return { version: '1', updatedAt: new Date().toISOString(), files: {} };
}

describe('diffSources', () => {
  it('file not in state appears in toSync', () => {
    const file = makeSourceFile();
    const state = makeEmptyState();
    const hashFn = vi.fn().mockReturnValue('aaa');

    const result = diffSources([file], state, hashFn);

    expect(result.toSync).toHaveLength(1);
    expect(result.unchanged).toHaveLength(0);
    expect(result.toSync[0]).toBe(file);
  });

  it('file in state with matching hash AND existing destination appears in unchanged', () => {
    const file = makeSourceFile();
    const hash = 'abc123';
    const state = makeEmptyState();
    const key = toStateKey(file.sourceName, file.relPath);
    state.files[key] = {
      hash,
      syncedAt: new Date().toISOString(),
      gitRef: null,
      sourceName: file.sourceName,
      destinationPath: '/vault/Projects/test-source/readme.md',
    };

    const hashFn = vi.fn().mockReturnValue(hash);
    const existsFn = vi.fn().mockReturnValue(true);

    const result = diffSources([file], state, hashFn, existsFn);

    expect(result.unchanged).toHaveLength(1);
    expect(result.toSync).toHaveLength(0);
    expect(result.unchanged[0]).toBe(file);
  });

  it('file in state with matching hash but missing destination (vault copy deleted) appears in toSync', () => {
    const file = makeSourceFile();
    const hash = 'abc123';
    const state = makeEmptyState();
    const key = toStateKey(file.sourceName, file.relPath);
    state.files[key] = {
      hash,
      syncedAt: new Date().toISOString(),
      gitRef: null,
      sourceName: file.sourceName,
      destinationPath: '/vault/Projects/test-source/readme.md',
    };

    const hashFn = vi.fn().mockReturnValue(hash);
    const existsFn = vi.fn().mockReturnValue(false);

    const result = diffSources([file], state, hashFn, existsFn);

    expect(result.toSync).toHaveLength(1);
    expect(result.unchanged).toHaveLength(0);
    expect(result.toSync[0]).toBe(file);
  });

  it('existsFn is called with entry.destinationPath, not the source absPath', () => {
    const file = makeSourceFile();
    const hash = 'abc123';
    const destinationPath = '/vault/Projects/test-source/readme.md';
    const state = makeEmptyState();
    const key = toStateKey(file.sourceName, file.relPath);
    state.files[key] = {
      hash,
      syncedAt: new Date().toISOString(),
      gitRef: null,
      sourceName: file.sourceName,
      destinationPath,
    };

    const hashFn = vi.fn().mockReturnValue(hash);
    const existsFn = vi.fn().mockReturnValue(true);

    diffSources([file], state, hashFn, existsFn);

    expect(existsFn).toHaveBeenCalledWith(destinationPath);
    expect(existsFn).not.toHaveBeenCalledWith(file.absPath);
  });

  it('file in state with different hash appears in toSync regardless of existsFn', () => {
    const file = makeSourceFile();
    const storedHash = 'old-hash';
    const currentHash = 'new-hash';
    const state = makeEmptyState();
    const key = toStateKey(file.sourceName, file.relPath);
    state.files[key] = {
      hash: storedHash,
      syncedAt: new Date().toISOString(),
      gitRef: null,
      sourceName: file.sourceName,
      destinationPath: '/vault/Projects/test-source/readme.md',
    };

    const hashFn = vi.fn().mockReturnValue(currentHash);
    const existsFn = vi.fn().mockReturnValue(true);

    const result = diffSources([file], state, hashFn, existsFn);

    expect(result.toSync).toHaveLength(1);
    expect(result.unchanged).toHaveLength(0);
  });

  it('file not in state appears in toSync, existsFn not consulted', () => {
    const file = makeSourceFile();
    const state = makeEmptyState();
    const hashFn = vi.fn().mockReturnValue('aaa');
    const existsFn = vi.fn().mockReturnValue(true);

    const result = diffSources([file], state, hashFn, existsFn);

    expect(result.toSync).toHaveLength(1);
    expect(result.unchanged).toHaveLength(0);
    expect(existsFn).not.toHaveBeenCalled();
  });

  it('two files — one changed, one unchanged — both correctly categorized', () => {
    const changedFile = makeSourceFile({ relPath: 'changed.md', absPath: '/src/changed.md' });
    const unchangedFile = makeSourceFile({ relPath: 'unchanged.md', absPath: '/src/unchanged.md' });
    const state = makeEmptyState();

    const unchangedKey = toStateKey(unchangedFile.sourceName, unchangedFile.relPath);
    state.files[unchangedKey] = {
      hash: 'stable-hash',
      syncedAt: new Date().toISOString(),
      gitRef: null,
      sourceName: unchangedFile.sourceName,
      destinationPath: '/vault/Projects/test-source/unchanged.md',
    };

    const hashFn = vi.fn().mockImplementation((absPath: string) => {
      if (absPath === changedFile.absPath) return 'new-hash';
      return 'stable-hash'; // unchanged file returns same hash as stored
    });
    const existsFn = vi.fn().mockReturnValue(true);

    const result = diffSources([changedFile, unchangedFile], state, hashFn, existsFn);

    expect(result.toSync).toHaveLength(1);
    expect(result.toSync[0]).toBe(changedFile);
    expect(result.unchanged).toHaveLength(1);
    expect(result.unchanged[0]).toBe(unchangedFile);
  });

  it('contentHashFn throws for one file — that file appears in toSync, other is still processed', () => {
    const errorFile = makeSourceFile({ relPath: 'error.md', absPath: '/src/error.md' });
    const okFile = makeSourceFile({ relPath: 'ok.md', absPath: '/src/ok.md' });
    const state = makeEmptyState();

    const hashFn = vi.fn().mockImplementation((absPath: string) => {
      if (absPath === errorFile.absPath) throw new Error('ENOENT: file not found');
      return 'ok-hash';
    });
    const existsFn = vi.fn().mockReturnValue(true);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = diffSources([errorFile, okFile], state, hashFn, existsFn);

    // Error file goes to toSync (not in state either, but even if it were, error → toSync)
    expect(result.toSync.some((f) => f.relPath === 'error.md')).toBe(true);
    // ok file is processed — not in state so also toSync, but processed without error
    expect(result.toSync.some((f) => f.relPath === 'ok.md')).toBe(true);

    warnSpy.mockRestore();
  });

  it('empty sourceFiles returns empty toSync and unchanged', () => {
    const state = makeEmptyState();
    const hashFn = vi.fn();
    const existsFn = vi.fn().mockReturnValue(true);

    const result = diffSources([], state, hashFn, existsFn);

    expect(result.toSync).toHaveLength(0);
    expect(result.unchanged).toHaveLength(0);
    expect(hashFn).not.toHaveBeenCalled();
  });

  it('empty state — all files appear in toSync', () => {
    const files = [
      makeSourceFile({ relPath: 'a.md', absPath: '/src/a.md' }),
      makeSourceFile({ relPath: 'b.md', absPath: '/src/b.md' }),
    ];
    const state = makeEmptyState();
    const hashFn = vi.fn().mockReturnValue('some-hash');
    const existsFn = vi.fn().mockReturnValue(true);

    const result = diffSources(files, state, hashFn, existsFn);

    expect(result.toSync).toHaveLength(2);
    expect(result.unchanged).toHaveLength(0);
  });
});
