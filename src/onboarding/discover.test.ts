import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { discoverCandidates } from './discover';

/**
 * Test fixtures use injected `_readdirSync`/`_lstatSync` per the ScanOptions
 * DI convention (src/sync/scanner.ts) — no real filesystem fixtures needed.
 *
 * Layout under root '/root':
 *   /root/has-md/notes.md
 *   /root/has-md/sub/deep.md
 *   /root/no-md/readme.txt
 *   /root/already-source/notes.md   (excluded — existing source path)
 *   /root/symlinked-dir -> elsewhere (excluded — symlink, not followed)
 *   /root/has-md-but-symlink-only/link.md -> elsewhere (symlink .md, not counted)
 *   /root/ignored-dir/notes.md       (excluded by global ignore pattern)
 *   /root/not-a-dir.md (file, not a directory — skipped from candidates)
 */

interface FakeEntry {
  name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}

function fakeDirent(name: string, type: 'dir' | 'file' | 'symlink-dir' | 'symlink-file'): FakeEntry {
  return {
    name,
    isDirectory: () => type === 'dir',
    isFile: () => type === 'file',
    isSymbolicLink: () => type === 'symlink-dir' || type === 'symlink-file',
  };
}

/**
 * Builds a fake filesystem tree as a map from absolute dir path -> entries.
 * Used by both _readdirSync (top-level listing) and the recursive .md scan.
 */
function buildFsTree(): Map<string, FakeEntry[]> {
  const tree = new Map<string, FakeEntry[]>();

  tree.set('/root', [
    fakeDirent('has-md', 'dir'),
    fakeDirent('no-md', 'dir'),
    fakeDirent('already-source', 'dir'),
    fakeDirent('symlinked-dir', 'symlink-dir'),
    fakeDirent('has-md-but-symlink-only', 'dir'),
    fakeDirent('ignored-dir', 'dir'),
    fakeDirent('not-a-dir.md', 'file'),
  ]);

  tree.set('/root/has-md', [fakeDirent('notes.md', 'file'), fakeDirent('sub', 'dir')]);
  tree.set('/root/has-md/sub', [fakeDirent('deep.md', 'file')]);

  tree.set('/root/no-md', [fakeDirent('readme.txt', 'file')]);

  tree.set('/root/already-source', [fakeDirent('notes.md', 'file')]);

  tree.set('/root/has-md-but-symlink-only', [fakeDirent('link.md', 'symlink-file')]);

  tree.set('/root/ignored-dir', [fakeDirent('notes.md', 'file')]);

  return tree;
}

function makeOpts(tree: Map<string, FakeEntry[]>) {
  const _readdirSync = (root: string, _opts: Record<string, unknown>): unknown[] => {
    const recursive = (_opts as { recursive?: boolean }).recursive === true;
    if (!recursive) {
      return tree.get(root) ?? [];
    }
    // Recursive: flatten the tree under `root`, attaching parentPath.
    const results: (FakeEntry & { parentPath: string })[] = [];
    const queue = [root];
    while (queue.length > 0) {
      const dir = queue.shift() as string;
      const entries = tree.get(dir) ?? [];
      for (const entry of entries) {
        results.push({ ...entry, parentPath: dir });
        if (entry.isDirectory()) {
          queue.push(path.join(dir, entry.name));
        }
      }
    }
    return results;
  };

  const _lstatSync = (p: string): Pick<fs.Stats, 'isSymbolicLink'> => {
    const isSymlink = p.includes('symlinked-dir') || p.endsWith('link.md');
    return { isSymbolicLink: () => isSymlink };
  };

  return { _readdirSync, _lstatSync };
}

describe('discoverCandidates', () => {
  it('returns immediate subdirectories that contain at least one .md file', () => {
    const tree = buildFsTree();
    const opts = makeOpts(tree);

    const candidates = discoverCandidates('/root', [], [], opts);
    const names = candidates.map((c) => c.name);

    expect(names).toContain('has-md');
  });

  it('excludes a subdirectory with no .md files', () => {
    const tree = buildFsTree();
    const opts = makeOpts(tree);

    const candidates = discoverCandidates('/root', [], [], opts);
    const names = candidates.map((c) => c.name);

    expect(names).not.toContain('no-md');
  });

  it('excludes a subdirectory whose resolved path equals an existing source path', () => {
    const tree = buildFsTree();
    const opts = makeOpts(tree);

    const candidates = discoverCandidates('/root', ['/root/already-source'], [], opts);
    const names = candidates.map((c) => c.name);

    expect(names).not.toContain('already-source');
  });

  it('does not follow symlinked subdirectories', () => {
    const tree = buildFsTree();
    const opts = makeOpts(tree);

    const candidates = discoverCandidates('/root', [], [], opts);
    const names = candidates.map((c) => c.name);

    expect(names).not.toContain('symlinked-dir');
  });

  it('does not count a symlinked .md file as a match', () => {
    const tree = buildFsTree();
    const opts = makeOpts(tree);

    const candidates = discoverCandidates('/root', [], [], opts);
    const names = candidates.map((c) => c.name);

    expect(names).not.toContain('has-md-but-symlink-only');
  });

  it('respects global ignore patterns', () => {
    const tree = buildFsTree();
    const opts = makeOpts(tree);

    const candidates = discoverCandidates('/root', [], ['ignored-dir/'], opts);
    const names = candidates.map((c) => c.name);

    expect(names).not.toContain('ignored-dir');
  });

  it('skips entries that are files (not directories) at the root level', () => {
    const tree = buildFsTree();
    const opts = makeOpts(tree);

    const candidates = discoverCandidates('/root', [], [], opts);
    const names = candidates.map((c) => c.name);

    expect(names).not.toContain('not-a-dir.md');
  });

  it('finds a .md file nested in a subdirectory (recursive, early-exit)', () => {
    const tree = new Map<string, FakeEntry[]>();
    tree.set('/root', [fakeDirent('proj', 'dir')]);
    tree.set('/root/proj', [fakeDirent('a', 'dir'), fakeDirent('b', 'dir')]);
    tree.set('/root/proj/a', []);
    tree.set('/root/proj/b', [fakeDirent('deep.md', 'file')]);

    const opts = makeOpts(tree);

    const candidates = discoverCandidates('/root', [], [], opts);
    const names = candidates.map((c) => c.name);

    expect(names).toContain('proj');
  });
});
