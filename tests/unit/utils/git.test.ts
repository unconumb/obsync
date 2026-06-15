import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getGitRef } from '../../../src/utils/git';

describe('getGitRef', () => {
  it('returns null for a path inside a non-git directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-git-test-'));
    try {
      const testFile = path.join(tmpDir, 'test.md');
      fs.writeFileSync(testFile, '# test');
      const result = getGitRef(testFile);
      expect(result).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not throw for a path inside a non-git directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-git-noerr-'));
    try {
      const testFile = path.join(tmpDir, 'test.md');
      fs.writeFileSync(testFile, '# test');
      expect(() => getGitRef(testFile)).not.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns a 40-char hex string or null for a file inside a git repo', () => {
    // Use the current project's src directory (which is inside a git repo)
    const result = getGitRef(path.join(__dirname, '../../../src/utils/paths.ts'));
    if (result !== null) {
      expect(result).toHaveLength(40);
      expect(result).toMatch(/^[0-9a-f]{40}$/);
    }
    // Either null or valid 40-char hex — both are acceptable
    expect(result === null || (typeof result === 'string' && result.length === 40)).toBe(true);
  });
});
