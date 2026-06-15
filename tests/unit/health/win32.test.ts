import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { checkWindowsPathLength } from '../../../src/health/win32';
import { buildDestPath } from '../../../src/sync/copier';
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

const VAULT_ROOT = path.join('C:', 'Users', 'testuser', 'vault');

describe('checkWindowsPathLength', () => {
  it('returns null when all destination paths are under 240 chars', () => {
    const files = [makeSourceFile()];
    expect(checkWindowsPathLength(files, VAULT_ROOT)).toBeNull();
  });

  it('returns null for an empty files array', () => {
    expect(checkWindowsPathLength([], VAULT_ROOT)).toBeNull();
  });

  it('warns when the longest destination path exceeds 240 chars', () => {
    const longRelPath = 'a'.repeat(230) + '.md';
    const files = [makeSourceFile({ relPath: longRelPath })];
    const result = checkWindowsPathLength(files, VAULT_ROOT);
    expect(result).toContain('exceeding the 240-character safe limit');
  });

  it('warns naming the longest path among multiple files, including its length', () => {
    const longRelPath = 'b'.repeat(230) + '.md';
    const shortFile = makeSourceFile({ relPath: 'README.md' });
    const longFile = makeSourceFile({ relPath: longRelPath, sourceName: 'project2' });
    const files = [shortFile, longFile];

    const result = checkWindowsPathLength(files, VAULT_ROOT);
    const expectedDest = buildDestPath(longFile, VAULT_ROOT);

    expect(result).toContain(expectedDest);
    expect(result).toContain(String(expectedDest.length));
  });
});
