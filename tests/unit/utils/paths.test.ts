import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { expandHome, isUnder, toStateKey } from '../../../src/utils/paths';

describe('expandHome', () => {
  it('expands ~/foo to an absolute path starting with homedir', () => {
    const result = expandHome('~/foo');
    expect(result.startsWith(os.homedir())).toBe(true);
    expect(result).toBe(`${os.homedir()}/foo`);
  });

  it('returns absolute paths unchanged', () => {
    expect(expandHome('/absolute/path')).toBe('/absolute/path');
  });

  it('expands bare ~ to homedir', () => {
    const result = expandHome('~');
    expect(result.startsWith(os.homedir())).toBe(true);
  });
});

describe('isUnder', () => {
  it('returns true when target is strictly under base', () => {
    expect(isUnder('/vault', '/vault/sub/file.md')).toBe(true);
  });

  it('returns false when target equals base (not strictly under)', () => {
    expect(isUnder('/vault', '/vault')).toBe(false);
  });

  it('returns false for path traversal attempts (../../etc/passwd)', () => {
    expect(isUnder('/vault', '/vault/../etc/passwd')).toBe(false);
  });

  it('returns false when target is in a sibling directory', () => {
    expect(isUnder('/vault', '/other/path')).toBe(false);
  });

  it('returns false for prefix collision (/vault vs /vault2)', () => {
    expect(isUnder('/vault', '/vault2/file.md')).toBe(false);
  });

  it('returns true for direct child files', () => {
    expect(isUnder('/vault', '/vault/file.md')).toBe(true);
  });
});

describe('toStateKey', () => {
  it('builds key with forward slashes for cross-platform consistency', () => {
    const key = toStateKey('thornode', 'docs/README.md');
    expect(key).toBe('thornode/docs/README.md');
  });

  it('builds key for flat path (no subdirectory)', () => {
    const key = toStateKey('myrepo', 'CONTRIBUTING.md');
    expect(key).toBe('myrepo/CONTRIBUTING.md');
  });
});
