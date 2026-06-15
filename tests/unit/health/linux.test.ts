import { describe, it, expect } from 'vitest';
import { checkInotifyLimit } from '../../../src/health/linux';

describe('checkInotifyLimit', () => {
  it('returns null when file count is under 80% of the limit', () => {
    const result = checkInotifyLimit(100, { _readFileSync: () => '8192\n' });
    expect(result).toBeNull();
  });

  it('warns when file count exceeds 80% of the limit', () => {
    const result = checkInotifyLimit(7000, { _readFileSync: () => '8192\n' });
    expect(result).toContain('inotify watch limit');
  });

  it('returns null silently when /proc read throws (D-49)', () => {
    const result = checkInotifyLimit(100, {
      _readFileSync: () => {
        throw new Error('ENOENT');
      },
    });
    expect(result).toBeNull();
  });

  it('returns null for malformed /proc content', () => {
    const result = checkInotifyLimit(100, { _readFileSync: () => 'not-a-number' });
    expect(result).toBeNull();
  });

  it('returns null when /proc reports a zero limit', () => {
    const result = checkInotifyLimit(100, { _readFileSync: () => '0' });
    expect(result).toBeNull();
  });

  it('returns null when /proc reports a negative limit', () => {
    const result = checkInotifyLimit(100, { _readFileSync: () => '-1' });
    expect(result).toBeNull();
  });

  it('warning message includes the actual fileCount and limit', () => {
    const result = checkInotifyLimit(7000, { _readFileSync: () => '8192\n' });
    expect(result).toContain('7000');
    expect(result).toContain('8192');
  });
});
