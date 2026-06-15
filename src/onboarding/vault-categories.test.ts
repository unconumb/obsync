import { describe, it, expect } from 'vitest';
import type * as fs from 'fs';
import { scanVaultCategories } from './vault-categories';

/**
 * Minimal Dirent-like fixture builder for injected _readdirSync.
 */
function dirent(name: string, isDir: boolean): fs.Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
  } as unknown as fs.Dirent;
}

const PARA_DEFAULTS = ['00-inbox', '01-projects', '02-areas', '03-resources', '04-archive'];

describe('scanVaultCategories', () => {
  it('returns PARA_DEFAULTS when vaultPath does not exist', () => {
    const result = scanVaultCategories('/no/such/vault', {
      _existsSync: () => false,
      _readdirSync: () => {
        throw new Error('should not be called');
      },
    });
    expect(result).toEqual(PARA_DEFAULTS);
  });

  it('returns PARA_DEFAULTS when vaultPath exists but has zero non-hidden depth-1 dirs', () => {
    const result = scanVaultCategories('/vault', {
      _existsSync: () => true,
      _readdirSync: () => [dirent('.obsidian', true), dirent('_index', true), dirent('readme.md', false)],
    });
    expect(result).toEqual(PARA_DEFAULTS);
  });

  it('returns top-level dirs plus depth-2 subfolders using path.posix.join', () => {
    const result = scanVaultCategories('/vault', {
      _existsSync: () => true,
      _readdirSync: (dir: string) => {
        if (dir === '/vault') {
          return [dirent('02-areas', true)];
        }
        if (dir === '/vault/02-areas') {
          return [dirent('sysadmin', true), dirent('godot', true)];
        }
        return [];
      },
    });
    expect(result).toEqual(['02-areas', '02-areas/sysadmin', '02-areas/godot']);
  });

  it('excludes _-prefixed and dotfile directories at both depth levels', () => {
    const result = scanVaultCategories('/vault', {
      _existsSync: () => true,
      _readdirSync: (dir: string) => {
        if (dir === '/vault') {
          return [dirent('02-areas', true), dirent('_dashboard', true), dirent('.git', true)];
        }
        if (dir === '/vault/02-areas') {
          return [dirent('sysadmin', true), dirent('_index', true), dirent('.hidden', true)];
        }
        return [];
      },
    });
    expect(result).toEqual(['02-areas', '02-areas/sysadmin']);
  });

  it('excludes non-directory entries at both depth levels', () => {
    const result = scanVaultCategories('/vault', {
      _existsSync: () => true,
      _readdirSync: (dir: string) => {
        if (dir === '/vault') {
          return [dirent('02-areas', true), dirent('notes.md', false)];
        }
        if (dir === '/vault/02-areas') {
          return [dirent('sysadmin', true), dirent('file.md', false)];
        }
        return [];
      },
    });
    expect(result).toEqual(['02-areas', '02-areas/sysadmin']);
  });

  it('includes top-level folder even when it has no depth-2 subfolders', () => {
    const result = scanVaultCategories('/vault', {
      _existsSync: () => true,
      _readdirSync: (dir: string) => {
        if (dir === '/vault') {
          return [dirent('01-projects', true)];
        }
        if (dir === '/vault/01-projects') {
          return [];
        }
        return [];
      },
    });
    expect(result).toEqual(['01-projects']);
  });
});
