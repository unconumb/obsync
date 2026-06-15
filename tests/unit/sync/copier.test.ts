import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { copyFile } from '../../../src/sync/copier';
import { ObsidianAdapter } from '../../../src/adapters/obsidian';
import type { ObsyncConfig } from '../../../src/config/types';
import type { SourceFile } from '../../../src/sync/scanner';

/**
 * Unit tests for copyFile in src/sync/copier.ts.
 *
 * Tests verify:
 *   - copyFile reads source and produces vault file with obsync_* frontmatter
 *   - dryRun=true: no vault file created, CopyResult.status='dry_run'
 *   - TOML source: CopyResult.status='skipped_toml', no vault file
 *   - Path outside vault: copyFile returns status='error', does not throw
 */

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-copier-test-'));
}

function makeConfig(vaultPath: string): ObsyncConfig {
  return {
    vault: { path: vaultPath },
    sources: [
      {
        name: 'test-source',
        path: '/tmp/source',
        category: 'Docs',
        scan: 'scattered',
        ai_summary: false,
        ignore: [],
        labels: [],
      },
    ],
    ignore: [],
  };
}

function makeSourceFile(absPath: string, overrides: Partial<SourceFile> = {}): SourceFile {
  return {
    sourceName: 'test-source',
    sourcePath: path.dirname(absPath),
    absPath,
    relPath: path.basename(absPath),
    category: 'Docs',
    labels: [],
    aiSummary: false,
    ...overrides,
  };
}

describe('copyFile', () => {
  let sourceDir: string;
  let vaultDir: string;
  let adapter: ObsidianAdapter;
  let config: ObsyncConfig;

  beforeEach(() => {
    sourceDir = makeTmpDir();
    vaultDir = makeTmpDir();
    adapter = new ObsidianAdapter(vaultDir);
    config = makeConfig(vaultDir);
  });

  afterEach(() => {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('operation="updated": file_copied audit entry has operation: "updated"', async () => {
    const srcFile = path.join(sourceDir, 'updated.md');
    fs.writeFileSync(srcFile, '# Updated Doc\n', 'utf-8');

    const sourceFile = makeSourceFile(srcFile, {
      sourcePath: sourceDir,
      relPath: 'updated.md',
    });

    const auditLogPath = path.join(makeTmpDir(), 'audit.log');

    const result = await copyFile(sourceFile, config, adapter, auditLogPath, false, 'updated');

    expect(result.status).toBe('copied');

    const lines = fs.readFileSync(auditLogPath, 'utf-8').trim().split('\n');
    const entries = lines.map((l) => JSON.parse(l) as { type: string; operation?: string });
    const fileCopied = entries.find((e) => e.type === 'file_copied');
    expect(fileCopied).toBeDefined();
    expect(fileCopied?.operation).toBe('updated');
  });

  it('operation omitted: file_copied audit entry defaults to operation: "added"', async () => {
    const srcFile = path.join(sourceDir, 'added.md');
    fs.writeFileSync(srcFile, '# Added Doc\n', 'utf-8');

    const sourceFile = makeSourceFile(srcFile, {
      sourcePath: sourceDir,
      relPath: 'added.md',
    });

    const auditLogPath = path.join(makeTmpDir(), 'audit.log');

    const result = await copyFile(sourceFile, config, adapter, auditLogPath, false);

    expect(result.status).toBe('copied');

    const lines = fs.readFileSync(auditLogPath, 'utf-8').trim().split('\n');
    const entries = lines.map((l) => JSON.parse(l) as { type: string; operation?: string });
    const fileCopied = entries.find((e) => e.type === 'file_copied');
    expect(fileCopied).toBeDefined();
    expect(fileCopied?.operation).toBe('added');
  });

  it('reads source and produces vault file with obsync_* frontmatter', async () => {
    const srcFile = path.join(sourceDir, 'readme.md');
    fs.writeFileSync(srcFile, '---\ntitle: My Doc\n---\n# Content\n', 'utf-8');

    const sourceFile = makeSourceFile(srcFile, {
      sourcePath: sourceDir,
      relPath: 'readme.md',
    });

    const result = await copyFile(sourceFile, config, adapter, undefined, false);

    expect(result.status).toBe('copied');
    expect(result.sourceFile).toBe(srcFile);

    // Vault file should exist
    const destPath = path.join(vaultDir, 'Docs', 'test-source', 'readme.md');
    expect(fs.existsSync(destPath)).toBe(true);

    const content = fs.readFileSync(destPath, 'utf-8');
    expect(content).toContain('obsync_source: test-source');
    expect(content).toContain('obsync_hash:');
    expect(content).toContain('obsync_synced_at:');
    expect(content).toContain('title: My Doc');
    expect(content).toContain('# Content');
  });

  it('dryRun=true: no vault file created, CopyResult.status=dry_run', async () => {
    const srcFile = path.join(sourceDir, 'dry.md');
    fs.writeFileSync(srcFile, '# Dry Run Doc\n', 'utf-8');

    const sourceFile = makeSourceFile(srcFile, {
      sourcePath: sourceDir,
      relPath: 'dry.md',
    });

    const result = await copyFile(sourceFile, config, adapter, undefined, true);

    expect(result.status).toBe('dry_run');

    const destPath = path.join(vaultDir, 'Docs', 'test-source', 'dry.md');
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it('TOML source: CopyResult.status=skipped_toml, no vault file', async () => {
    const srcFile = path.join(sourceDir, 'toml.md');
    fs.writeFileSync(srcFile, '+++\ntitle = "TOML Doc"\n+++\n# Content\n', 'utf-8');

    const sourceFile = makeSourceFile(srcFile, {
      sourcePath: sourceDir,
      relPath: 'toml.md',
    });

    const result = await copyFile(sourceFile, config, adapter, undefined, false);

    expect(result.status).toBe('skipped_toml');

    const destPath = path.join(vaultDir, 'Docs', 'test-source', 'toml.md');
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it('source with labels: vault file contains label tags in YAML frontmatter (CAT-02)', async () => {
    const srcFile = path.join(sourceDir, 'labeled.md');
    fs.writeFileSync(srcFile, '---\ntitle: Labeled Doc\n---\n# Labeled Content\n', 'utf-8');

    const sourceFile = makeSourceFile(srcFile, {
      sourcePath: sourceDir,
      relPath: 'labeled.md',
      labels: ['runbook', 'infra'],
    });
    // Config source has labels matching the source file's labels
    const labeledConfig: ObsyncConfig = {
      vault: { path: vaultDir },
      sources: [
        {
          name: 'test-source',
          path: sourceDir,
          category: 'Docs',
          scan: 'scattered',
          ai_summary: false,
          ignore: [],
          labels: ['runbook', 'infra'],
        },
      ],
      ignore: [],
    };

    const result = await copyFile(sourceFile, labeledConfig, adapter, undefined, false);

    expect(result.status).toBe('copied');

    const destPath = path.join(vaultDir, 'Docs', 'test-source', 'labeled.md');
    expect(fs.existsSync(destPath)).toBe(true);

    const content = fs.readFileSync(destPath, 'utf-8');
    // Both labels must appear in the vault file's tags frontmatter
    expect(content).toContain('runbook');
    expect(content).toContain('infra');
    expect(content).toContain('tags:');
  });

  it('source with empty labels: vault file has no injected tags (backward compat)', async () => {
    const srcFile = path.join(sourceDir, 'nolabels.md');
    fs.writeFileSync(srcFile, '---\ntitle: No Labels\n---\n# No Labels\n', 'utf-8');

    const sourceFile = makeSourceFile(srcFile, {
      sourcePath: sourceDir,
      relPath: 'nolabels.md',
      labels: [],
    });

    const result = await copyFile(sourceFile, config, adapter, undefined, false);

    expect(result.status).toBe('copied');

    const destPath = path.join(vaultDir, 'Docs', 'test-source', 'nolabels.md');
    const content = fs.readFileSync(destPath, 'utf-8');
    // Should NOT have tags field added
    expect(content).not.toContain('tags:');
  });

  it('source with labels and existing file tags: tags are merged without duplicates', async () => {
    const srcFile = path.join(sourceDir, 'with-tags.md');
    fs.writeFileSync(srcFile, '---\ntitle: Has Tags\ntags:\n  - existing\n---\n# Content\n', 'utf-8');

    const sourceFile = makeSourceFile(srcFile, {
      sourcePath: sourceDir,
      relPath: 'with-tags.md',
      labels: ['runbook'],
    });
    const labeledConfig: ObsyncConfig = {
      vault: { path: vaultDir },
      sources: [
        {
          name: 'test-source',
          path: sourceDir,
          category: 'Docs',
          scan: 'scattered',
          ai_summary: false,
          ignore: [],
          labels: ['runbook'],
        },
      ],
      ignore: [],
    };

    const result = await copyFile(sourceFile, labeledConfig, adapter, undefined, false);

    expect(result.status).toBe('copied');

    const destPath = path.join(vaultDir, 'Docs', 'test-source', 'with-tags.md');
    const content = fs.readFileSync(destPath, 'utf-8');
    // Both existing tag and label must appear
    expect(content).toContain('existing');
    expect(content).toContain('runbook');
  });

  it('TOML/JSON skip still applies when labels are passed (no frontmatter regression)', async () => {
    const srcFile = path.join(sourceDir, 'toml-labeled.md');
    fs.writeFileSync(srcFile, '+++\ntitle = "TOML"\n+++\n# Content\n', 'utf-8');

    const sourceFile = makeSourceFile(srcFile, {
      sourcePath: sourceDir,
      relPath: 'toml-labeled.md',
      labels: ['runbook'],
    });
    const labeledConfig: ObsyncConfig = {
      vault: { path: vaultDir },
      sources: [
        {
          name: 'test-source',
          path: sourceDir,
          category: 'Docs',
          scan: 'scattered',
          ai_summary: false,
          ignore: [],
          labels: ['runbook'],
        },
      ],
      ignore: [],
    };

    const result = await copyFile(sourceFile, labeledConfig, adapter, undefined, false);

    // TOML should still be skipped even when labels are passed
    expect(result.status).toBe('skipped_toml');

    const destPath = path.join(vaultDir, 'Docs', 'test-source', 'toml-labeled.md');
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it('path outside vault: returns status=error without throwing', async () => {
    const srcFile = path.join(sourceDir, 'escape.md');
    fs.writeFileSync(srcFile, '# Escape\n', 'utf-8');

    // Make a config with vault path that sourceFile's dest won't be under
    // by crafting a config with vault path that won't match our source
    const tinyVault = makeTmpDir();
    // Use a sourceFile with a category/name that would path-traverse
    const maliciousSource: SourceFile = {
      sourceName: '../../etc',
      sourcePath: sourceDir,
      absPath: srcFile,
      relPath: '../../../etc/passwd',
      category: '../../etc',
      labels: [],
      aiSummary: false,
    };
    const maliciousConfig = makeConfig(tinyVault);

    try {
      const result = await copyFile(maliciousSource, maliciousConfig, new ObsidianAdapter(tinyVault), undefined, false);
      expect(result.status).toBe('error');
    } finally {
      fs.rmSync(tinyVault, { recursive: true, force: true });
    }
  });
});
