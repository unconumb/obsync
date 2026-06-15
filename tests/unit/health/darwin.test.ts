import { describe, it, expect } from 'vitest';
import { checkMacFda } from '../../../src/health/darwin';

describe('checkMacFda', () => {
  it('returns null when source path is under home and not in a protected folder', () => {
    expect(
      checkMacFda([{ name: 'thornode', path: '/Users/testuser/Dev/thornode' }], '/Users/testuser'),
    ).toBeNull();
  });

  it('warns when source path is outside home directory', () => {
    const result = checkMacFda(
      [{ name: 'ext', path: '/Volumes/External/notes' }],
      '/Users/testuser',
    );
    expect(result).toContain('Full Disk Access');
  });

  it('warns when source path is under ~/Desktop', () => {
    const result = checkMacFda(
      [{ name: 'desk', path: '/Users/testuser/Desktop/notes' }],
      '/Users/testuser',
    );
    expect(result).toContain('Full Disk Access');
  });

  it('warns when source path is under ~/Documents', () => {
    const result = checkMacFda(
      [{ name: 'docs', path: '/Users/testuser/Documents/notes' }],
      '/Users/testuser',
    );
    expect(result).toContain('Full Disk Access');
  });

  it('warns when source path is under ~/Downloads', () => {
    const result = checkMacFda(
      [{ name: 'dl', path: '/Users/testuser/Downloads/notes' }],
      '/Users/testuser',
    );
    expect(result).toContain('Full Disk Access');
  });

  it('warns when source path is under ~/Library/Mobile Documents (iCloud Drive)', () => {
    const result = checkMacFda(
      [{ name: 'icloud', path: '/Users/testuser/Library/Mobile Documents/iCloud~md~obsidian/notes' }],
      '/Users/testuser',
    );
    expect(result).toContain('Full Disk Access');
  });

  it('warns when source path equals ~/Desktop exactly (strict-under edge case)', () => {
    const result = checkMacFda([{ name: 'desk', path: '/Users/testuser/Desktop' }], '/Users/testuser');
    expect(result).toContain('Full Disk Access');
  });

  it('warning message names the source and includes the remediation path', () => {
    const result = checkMacFda(
      [{ name: 'ext', path: '/Volumes/External/notes' }],
      '/Users/testuser',
    );
    expect(result).toContain('ext');
    expect(result).toContain('/Volumes/External/notes');
    expect(result).toContain('System Settings > Privacy & Security > Full Disk Access');
  });

  it('returns null for an empty sources array', () => {
    expect(checkMacFda([], '/Users/testuser')).toBeNull();
  });
});
