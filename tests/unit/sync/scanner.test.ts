import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanSource, getScanRoot } from '../../../src/sync/scanner';
import type { ScanOptions } from '../../../src/sync/scanner';
import type { Source } from '../../../src/config/types';

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    name: 'test-source',
    path: '/tmp/test', // will be overridden in each test
    category: 'Projects',
    scan: 'scattered',
    ai_summary: false,
    ignore: [],
    labels: [],
    ...overrides,
  };
}

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-scanner-'));
}

describe('scanSource', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scans all .md files in a flat directory', () => {
    const tmpDir = createTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# readme');
      fs.writeFileSync(path.join(tmpDir, 'notes.md'), '# notes');

      const source = makeSource({ path: tmpDir });
      const results = scanSource(source, []);

      expect(results).toHaveLength(2);
      expect(results.map((f) => f.relPath).sort()).toEqual(['notes.md', 'readme.md']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips non-.md files', () => {
    const tmpDir = createTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# readme');
      fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'script.ts'), 'export {}');

      const source = makeSource({ path: tmpDir });
      const results = scanSource(source, []);

      expect(results).toHaveLength(1);
      expect(results[0].relPath).toBe('readme.md');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('applies source ignore pattern and skips node_modules/', () => {
    const tmpDir = createTmpDir();
    try {
      fs.mkdirSync(path.join(tmpDir, 'node_modules'));
      fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.md'), '# pkg');
      fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# readme');

      const source = makeSource({ path: tmpDir, ignore: ['node_modules/'] });
      const results = scanSource(source, []);

      expect(results).toHaveLength(1);
      expect(results[0].relPath).toBe('readme.md');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips symlinks', () => {
    const tmpDir = createTmpDir();
    try {
      const realFile = path.join(tmpDir, 'real.md');
      const symlinkFile = path.join(tmpDir, 'link.md');
      fs.writeFileSync(realFile, '# real');
      fs.symlinkSync(realFile, symlinkFile);

      const source = makeSource({ path: tmpDir });
      const results = scanSource(source, []);

      const relPaths = results.map((f) => f.relPath);
      expect(relPaths).toContain('real.md');
      expect(relPaths).not.toContain('link.md');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('scan:docs mode scans only the docs_path subfolder', () => {
    const tmpDir = createTmpDir();
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'));
      fs.writeFileSync(path.join(tmpDir, 'docs', 'guide.md'), '# guide');
      fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# readme at root');

      const source = makeSource({
        path: tmpDir,
        scan: 'docs',
        docs_path: 'docs',
      });
      const results = scanSource(source, []);

      expect(results).toHaveLength(1);
      expect(results[0].relPath).toBe('guide.md');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('emits console.warn on case collision and still returns the first file', () => {
    // Use injected _readdirSync to simulate two entries with case-colliding names
    // without relying on filesystem case sensitivity (avoids macOS vs Linux differences).
    const tmpDir = '/fake/scan/root';

    const fakeEntry1 = {
      name: 'Note.md',
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      parentPath: tmpDir,
    } as unknown as fs.Dirent;

    const fakeEntry2 = {
      name: 'note.md',
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      parentPath: tmpDir,
    } as unknown as fs.Dirent;

    const opts: ScanOptions = {
      _readdirSync: () => [fakeEntry1, fakeEntry2],
      _lstatSync: () => ({ isSymbolicLink: () => false }),
    };

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    const source = makeSource({ path: tmpDir });
    const results = scanSource(source, [], opts);

    // Should have warned about the case collision
    expect(stderrChunks.some((c) => c.includes('[obsync] case collision'))).toBe(true);

    // First file should still be returned; second is dropped
    expect(results).toHaveLength(1);
    expect(results[0].relPath).toBe('Note.md');

    vi.restoreAllMocks();
  });
});

describe('getScanRoot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scan: scattered returns source.path', () => {
    const source = makeSource({ path: '/tmp/proj', scan: 'scattered' });
    expect(getScanRoot(source)).toBe('/tmp/proj');
  });

  it('scan: docs with docs_path returns path.join(source.path, docs_path)', () => {
    const source = makeSource({ path: '/tmp/proj', scan: 'docs', docs_path: 'docs' });
    expect(getScanRoot(source)).toBe(path.join('/tmp/proj', 'docs'));
  });

  it('scan: docs without docs_path defensively returns source.path', () => {
    const source = makeSource({ path: '/tmp/proj', scan: 'docs' });
    expect(getScanRoot(source)).toBe('/tmp/proj');
  });

  it('scan: docs with a docs_path that escapes source.path via ".." falls back to source.path and warns', () => {
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    const source = makeSource({ path: '/tmp/proj', scan: 'docs', docs_path: '../../etc' });
    expect(getScanRoot(source)).toBe('/tmp/proj');
    expect(stderrChunks.some((c) => c.includes('escapes source path'))).toBe(true);
  });

  it('scan: docs with a deeply-traversing docs_path that escapes source.path falls back to source.path and warns', () => {
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    const source = makeSource({ path: '/tmp/proj', scan: 'docs', docs_path: '../../../../etc/passwd' });
    expect(getScanRoot(source)).toBe('/tmp/proj');
    expect(stderrChunks.some((c) => c.includes('escapes source path'))).toBe(true);
  });

  it('scan: docs with a nested docs_path that stays under source.path is unaffected', () => {
    const source = makeSource({ path: '/tmp/proj', scan: 'docs', docs_path: 'a/b/c' });
    expect(getScanRoot(source)).toBe(path.join('/tmp/proj', 'a/b/c'));
  });
});

describe('scanSource — scan failure surfacing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when readdirSync fails (scan root unreadable/missing)', () => {
    const source = makeSource({ path: '/nonexistent/scan/root' });
    const opts: ScanOptions = {
      _readdirSync: () => {
        throw new Error('EACCES: permission denied');
      },
    };

    expect(() => scanSource(source, [], opts)).toThrow(/permission denied/);
  });
});
