import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import matter from 'gray-matter';
import { ObsidianAdapter } from '../../../src/adapters/obsidian';
import type { VaultEntry } from '../../../src/adapters/interface';

/**
 * Unit tests for ObsidianAdapter.writeEntry.
 *
 * Tests verify:
 *   - Directory creation and correct file content with YAML frontmatter
 *   - Path confinement: throws when destinationPath is outside vaultRoot
 *   - Atomic write: no .obsync.tmp file remains after writeEntry
 *   - YAML frontmatter in output is parseable and matches mergedFrontmatter
 */

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-test-'));
}

function makeEntry(destinationPath: string, overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    destinationPath,
    mergedFrontmatter: {
      title: 'Test Document',
      obsync_source: 'test-source',
      obsync_hash: 'abc123',
      obsync_synced_at: '2026-06-09T00:00:00.000Z',
      obsync_git_ref: null,
    },
    body: '# Test Document\n\nSome content here.\n',
    metadata: {
      sourceFile: '/some/source/file.md',
      hash: 'abc123',
      gitRef: null,
      syncedAt: '2026-06-09T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('ObsidianAdapter', () => {
  let vaultDir: string;
  let adapter: ObsidianAdapter;

  beforeEach(() => {
    vaultDir = makeTmpDir();
    adapter = new ObsidianAdapter(vaultDir);
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('creates directory structure and file with correct ---\\nyaml\\n---\\nbody content', async () => {
    const destPath = path.join(vaultDir, 'category', 'source', 'doc.md');
    const entry = makeEntry(destPath);

    await adapter.writeEntry(entry);

    expect(fs.existsSync(destPath)).toBe(true);
    const content = fs.readFileSync(destPath, 'utf-8');
    expect(content).toContain('---');
    expect(content).toContain('title: Test Document');
    expect(content).toContain('obsync_source: test-source');
    expect(content).toContain('# Test Document');
    // Check structure: starts with --- frontmatter block
    expect(content.startsWith('---\n')).toBe(true);
    // Body appears after closing ---
    const parts = content.split('---\n');
    // parts[0] = '' (before first ---), parts[1] = yaml, parts[2] = body
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts[2]).toContain('# Test Document');
  });

  it('throws with "path confinement" when destinationPath is outside vaultRoot', async () => {
    const outsidePath = path.join(os.tmpdir(), 'outside', 'file.md');
    const entry = makeEntry(outsidePath);

    await expect(adapter.writeEntry(entry)).rejects.toThrow('path confinement');
  });

  it('no .obsync.tmp file remains after successful writeEntry', async () => {
    const destPath = path.join(vaultDir, 'doc.md');
    const entry = makeEntry(destPath);

    await adapter.writeEntry(entry);

    const tmpPath = destPath + '.obsync.tmp';
    expect(fs.existsSync(destPath)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it('YAML frontmatter in output is parseable and equals mergedFrontmatter', async () => {
    const destPath = path.join(vaultDir, 'parsed.md');
    const entry = makeEntry(destPath);

    await adapter.writeEntry(entry);

    const content = fs.readFileSync(destPath, 'utf-8');
    const parsed = matter(content);
    expect(parsed.data['title']).toBe('Test Document');
    expect(parsed.data['obsync_source']).toBe('test-source');
    expect(parsed.data['obsync_hash']).toBe('abc123');
    // gray-matter parses ISO timestamp strings as Date objects — convert to ISO string for comparison
    const syncedAt = parsed.data['obsync_synced_at'];
    const syncedAtStr = syncedAt instanceof Date ? syncedAt.toISOString() : String(syncedAt);
    expect(syncedAtStr).toBe('2026-06-09T00:00:00.000Z');
    // obsync_git_ref: null — yaml serializes as null
    expect(parsed.data['obsync_git_ref']).toBeNull();
  });

  describe('deleteEntry', () => {
    it('removes an existing file at a path under the vault root', async () => {
      const destPath = path.join(vaultDir, 'category', 'source', 'doc.md');
      const entry = makeEntry(destPath);
      await adapter.writeEntry(entry);
      expect(fs.existsSync(destPath)).toBe(true);

      await adapter.deleteEntry(destPath);

      expect(fs.existsSync(destPath)).toBe(false);
    });

    it('is idempotent — resolves without throwing for a non-existent path', async () => {
      const destPath = path.join(vaultDir, 'never-existed.md');
      expect(fs.existsSync(destPath)).toBe(false);

      await expect(adapter.deleteEntry(destPath)).resolves.toBeUndefined();
    });

    it('throws "path confinement violation" for a path outside vaultRoot and does not unlink anything', async () => {
      const outsidePath = path.join(os.tmpdir(), 'outside-delete-test', 'file.md');
      fs.mkdirSync(path.dirname(outsidePath), { recursive: true });
      fs.writeFileSync(outsidePath, 'do not delete me', 'utf-8');

      try {
        await expect(adapter.deleteEntry(outsidePath)).rejects.toThrow('path confinement violation');
        expect(fs.existsSync(outsidePath)).toBe(true);
      } finally {
        fs.rmSync(path.dirname(outsidePath), { recursive: true, force: true });
      }
    });

    it('is async and returns a Promise<void>', () => {
      const destPath = path.join(vaultDir, 'promise-check.md');
      const result = adapter.deleteEntry(destPath);

      expect(result).toBeInstanceOf(Promise);
      return result;
    });
  });
});
