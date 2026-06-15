import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { inferCategory, detectName, detectScan } from './detect';

describe('inferCategory', () => {
  const homeDir = '/Users/testuser';

  it('returns 02-areas for a path under ~/Dev/Personal', () => {
    const sourcePath = path.join(homeDir, 'Dev', 'Personal', 'obsync');
    expect(inferCategory(sourcePath, homeDir)).toBe('02-areas');
  });

  it('returns 02-areas for the ~/Dev/Personal root itself', () => {
    const sourcePath = path.join(homeDir, 'Dev', 'Personal');
    expect(inferCategory(sourcePath, homeDir)).toBe('02-areas');
  });

  it('returns 01-projects for a path under ~/work', () => {
    const sourcePath = path.join(homeDir, 'work', 'client-project');
    expect(inferCategory(sourcePath, homeDir)).toBe('01-projects');
  });

  it('returns 01-projects for a path under ~/Dev/Work', () => {
    const sourcePath = path.join(homeDir, 'Dev', 'Work', 'client-project');
    expect(inferCategory(sourcePath, homeDir)).toBe('01-projects');
  });

  it('returns 02-areas for an infra/runbook-named folder outside ~/work', () => {
    const sourcePath = path.join(homeDir, 'misc', 'thornode-infra');
    expect(inferCategory(sourcePath, homeDir)).toBe('02-areas');
  });

  it('returns 02-areas for anything else', () => {
    const sourcePath = path.join(homeDir, 'Documents', 'random-notes');
    expect(inferCategory(sourcePath, homeDir)).toBe('02-areas');
  });

  it('does not classify as 01-projects when only an ancestor segment (not under ~/work or ~/Dev/Work) matches', () => {
    // homeDir itself contains "work" (e.g. a "coworking" username segment), but the
    // candidate path is not actually under ~/work or ~/Dev/Work — should default.
    const workyHomeDir = '/Users/coworking-space';
    const sourcePath = path.join(workyHomeDir, 'Dev', 'random-notes');
    expect(inferCategory(sourcePath, workyHomeDir)).toBe('02-areas');
  });
});

describe('detectName', () => {
  it('returns the folder basename of the path', () => {
    expect(detectName('/Users/testuser/Dev/Personal/obsync')).toBe('obsync');
  });

  it('strips a trailing slash before computing basename', () => {
    expect(detectName('/Users/testuser/Dev/Personal/obsync/')).toBe('obsync');
  });

  it('handles relative paths by resolving them first', () => {
    const resolved = path.basename(path.resolve('./my-project'));
    expect(detectName('./my-project')).toBe(resolved);
  });
});

describe('detectScan', () => {
  it('returns "docs" when the folder contains a docs/ subdir', () => {
    const existsFn = (p: string) => p.endsWith('/docs');
    expect(detectScan('/Users/testuser/project2', existsFn)).toBe('docs');
  });

  it('returns "docs" when the folder contains a .planning/ subdir', () => {
    const existsFn = (p: string) => p.endsWith('/.planning');
    expect(detectScan('/Users/testuser/obsync', existsFn)).toBe('docs');
  });

  it('returns "scattered" when neither docs/ nor .planning/ exist', () => {
    const existsFn = () => false;
    expect(detectScan('/Users/testuser/thornode', existsFn)).toBe('scattered');
  });
});
