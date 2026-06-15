import { describe, it, expect, beforeEach } from 'vitest';
import type { OutputAdapter, VaultEntry } from '../adapters/interface';
import type { ObsyncConfig } from '../config/types';
import type { SyncResult } from '../sync/engine';
import { generateChangelog } from './changelog';

// MockAdapter captures writeEntry calls keyed by destinationPath
class MockAdapter implements OutputAdapter {
  readonly entries = new Map<string, VaultEntry>();

  async writeEntry(entry: VaultEntry): Promise<void> {
    this.entries.set(entry.destinationPath, entry);
  }

  async deleteEntry(destinationPath: string): Promise<void> {
    this.entries.delete(destinationPath);
  }
}

function makeConfig(vaultPath = '/vault'): ObsyncConfig {
  return {
    vault: { path: vaultPath },
    sources: [
      {
        name: 'infra',
        path: '/sources/infra',
        category: 'Infrastructure',
        scan: 'scattered' as const,
        ai_summary: false,
        ignore: [],
        ai_ignore: [],
        labels: [],
      },
    ],
    ignore: [],
  };
}

function makeResult(overrides?: Partial<SyncResult>): SyncResult {
  return {
    copiedCount: 0,
    addedCount: 0,
    updatedCount: 0,
    movedCount: 0,
    removedCount: 0,
    skippedCount: 0,
    unchangedCount: 0,
    errorCount: 0,
    errors: [],
    changes: [],
    aiSummaries: [],
    ...overrides,
  };
}

describe('generateChangelog', () => {
  let adapter: MockAdapter;
  const startedAt = '2026-06-09T21:32:06.688Z';
  const finishedAt = '2026-06-09T21:32:18.123Z';

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  it('returns { filename } with YYYY-MM-DD-HHmm-sync.md pattern', async () => {
    const config = makeConfig();
    const { filename } = await generateChangelog(
      config,
      makeResult(),
      startedAt,
      finishedAt,
      adapter,
    );
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-sync\.md$/);
  });

  it('writes to _changelog/{filename}', async () => {
    const config = makeConfig();
    const { filename } = await generateChangelog(
      config,
      makeResult(),
      startedAt,
      finishedAt,
      adapter,
    );
    expect(adapter.entries.has(`/vault/_changelog/${filename}`)).toBe(true);
  });

  it('frontmatter has run_id as 8 hex chars', async () => {
    const config = makeConfig();
    const { filename } = await generateChangelog(
      config,
      makeResult(),
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    const runId = entry.mergedFrontmatter['run_id'] as string;
    expect(runId).toMatch(/^[0-9a-f]{8}$/);
  });

  it('frontmatter has started_at and finished_at', async () => {
    const config = makeConfig();
    const { filename } = await generateChangelog(
      config,
      makeResult(),
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.mergedFrontmatter['started_at']).toBe(startedAt);
    expect(entry.mergedFrontmatter['finished_at']).toBe(finishedAt);
  });

  it('frontmatter has total_added, total_updated, total_unchanged, total_errors', async () => {
    const config = makeConfig();
    const result = makeResult({
      addedCount: 3,
      updatedCount: 1,
      unchangedCount: 45,
      errorCount: 2,
    });
    const { filename } = await generateChangelog(
      config,
      result,
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.mergedFrontmatter['total_added']).toBe(3);
    expect(entry.mergedFrontmatter['total_updated']).toBe(1);
    expect(entry.mergedFrontmatter['total_unchanged']).toBe(45);
    expect(entry.mergedFrontmatter['total_errors']).toBe(2);
    expect(entry.mergedFrontmatter['obsync_generated_by']).toBe('obsync');
  });

  it('frontmatter has total_moved and total_removed ordered after total_updated and before total_unchanged', async () => {
    const config = makeConfig();
    const result = makeResult({
      movedCount: 1,
      removedCount: 2,
    });
    const { filename } = await generateChangelog(
      config,
      result,
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.mergedFrontmatter['total_moved']).toBe(1);
    expect(entry.mergedFrontmatter['total_removed']).toBe(2);

    const keys = Object.keys(entry.mergedFrontmatter);
    const updatedIdx = keys.indexOf('total_updated');
    const movedIdx = keys.indexOf('total_moved');
    const removedIdx = keys.indexOf('total_removed');
    const unchangedIdx = keys.indexOf('total_unchanged');
    expect(updatedIdx).toBeLessThan(movedIdx);
    expect(movedIdx).toBeLessThan(removedIdx);
    expect(removedIdx).toBeLessThan(unchangedIdx);
  });

  it('H1 is "# Sync — {YYYY-MM-DD} {HH:MM}" format', async () => {
    const config = makeConfig();
    const { filename } = await generateChangelog(
      config,
      makeResult(),
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.body).toMatch(/^# Sync — \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it('all four H2 sections always present', async () => {
    const config = makeConfig();
    const { filename } = await generateChangelog(
      config,
      makeResult(),
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.body).toContain('## Added');
    expect(entry.body).toContain('## Updated');
    expect(entry.body).toContain('## Unchanged');
    expect(entry.body).toContain('## Errors');
  });

  it('## Moved and ## Removed sections present with singular/plural counts, ordered after Updated and before Unchanged', async () => {
    const config = makeConfig();
    const result = makeResult({ movedCount: 1, removedCount: 2 });
    const { filename } = await generateChangelog(
      config,
      result,
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.body).toContain('## Moved');
    expect(entry.body).toContain('1 file moved.');
    expect(entry.body).toContain('## Removed');
    expect(entry.body).toContain('2 files removed.');

    const updatedIdx = entry.body.indexOf('## Updated');
    const movedIdx = entry.body.indexOf('## Moved');
    const removedIdx = entry.body.indexOf('## Removed');
    const unchangedIdx = entry.body.indexOf('## Unchanged');
    expect(updatedIdx).toBeLessThan(movedIdx);
    expect(movedIdx).toBeLessThan(removedIdx);
    expect(removedIdx).toBeLessThan(unchangedIdx);
  });

  it('Moved/Removed sections: singular "file" when count === 1, plural "files" when count === 0', async () => {
    const config = makeConfig();
    const result = makeResult({ movedCount: 1, removedCount: 0 });
    const { filename } = await generateChangelog(
      config,
      result,
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.body).toContain('1 file moved.');
    expect(entry.body).not.toContain('1 files moved.');
    expect(entry.body).toContain('0 files removed.');
  });

  it('empty Added section uses "*Nothing added this run.*"', async () => {
    const config = makeConfig();
    const { filename } = await generateChangelog(
      config,
      makeResult(),
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.body).toContain('*Nothing added this run.*');
  });

  it('empty Updated section uses "*Nothing updated this run.*"', async () => {
    const config = makeConfig();
    const { filename } = await generateChangelog(
      config,
      makeResult(),
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.body).toContain('*Nothing updated this run.*');
  });

  it('Unchanged section: singular "file" when N === 1', async () => {
    const config = makeConfig();
    const result = makeResult({ unchangedCount: 1 });
    const { filename } = await generateChangelog(
      config,
      result,
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.body).toContain('1 file unchanged.');
    expect(entry.body).not.toContain('1 files unchanged.');
  });

  it('Unchanged section: plural "files" when N > 1', async () => {
    const config = makeConfig();
    const result = makeResult({ unchangedCount: 45 });
    const { filename } = await generateChangelog(
      config,
      result,
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.body).toContain('45 files unchanged.');
  });

  it('Unchanged section: plural "files" when N === 0', async () => {
    const config = makeConfig();
    const result = makeResult({ unchangedCount: 0 });
    const { filename } = await generateChangelog(
      config,
      result,
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.body).toContain('0 files unchanged.');
  });

  it('Errors section: "No errors." when zero errors', async () => {
    const config = makeConfig();
    const { filename } = await generateChangelog(
      config,
      makeResult(),
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.body).toContain('No errors.');
  });

  it('Added section: wikilinks grouped by source name', async () => {
    const config = makeConfig();
    const result = makeResult({
      changes: [
        {
          type: 'added',
          sourceName: 'infra',
          relPath: 'runbook.md',
          destinationPath: '/vault/Infrastructure/infra/runbook.md',
          syncedAt: new Date().toISOString(),
        },
      ],
      addedCount: 1,
    });
    const { filename } = await generateChangelog(
      config,
      result,
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.body).toContain('### infra');
    expect(entry.body).toContain('[[Infrastructure/infra/runbook|runbook]]');
  });

  it('Updated section: wikilinks grouped by source name', async () => {
    const config = makeConfig();
    const result = makeResult({
      changes: [
        {
          type: 'updated',
          sourceName: 'infra',
          relPath: 'guide.md',
          destinationPath: '/vault/Infrastructure/infra/guide.md',
          syncedAt: new Date().toISOString(),
        },
      ],
      updatedCount: 1,
    });
    const { filename } = await generateChangelog(
      config,
      result,
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.body).toContain('### infra');
    expect(entry.body).toContain('[[Infrastructure/infra/guide|guide]]');
  });

  it('Errors section groups errors by source name', async () => {
    const config = makeConfig();
    const result = makeResult({
      errorCount: 1,
      errors: [{ file: 'infra/broken.md', message: 'Permission denied' }],
    });
    const { filename } = await generateChangelog(
      config,
      result,
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.body).toContain('`infra/broken.md`');
    expect(entry.body).toContain('Permission denied');
  });

  it('AI Activity section: empty/"none" state when no AI ran', async () => {
    const config = makeConfig();
    const { filename } = await generateChangelog(
      config,
      makeResult(),
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.body).toContain('## AI Activity');
    expect(entry.body).toMatch(/no files? (were )?summarized|nothing summarized|no ai activity/i);
  });

  it('AI Activity section: shows summarized count and source names when AI ran', async () => {
    const config = makeConfig();
    const result = makeResult({
      aiSummaries: [
        { sourceName: 'infra', relPath: 'runbook.md' },
        { sourceName: 'infra', relPath: 'guide.md' },
      ],
    });
    const { filename } = await generateChangelog(
      config,
      result,
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    expect(entry.body).toContain('## AI Activity');
    expect(entry.body).toContain('2');
    expect(entry.body).toContain('infra');
  });

  it('AI Activity section: never includes summary/body/content text — counts and source names only', async () => {
    const config = makeConfig();
    const result = makeResult({
      aiSummaries: [{ sourceName: 'infra', relPath: 'runbook.md' }],
    });
    const { filename } = await generateChangelog(
      config,
      result,
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    // Section must not contain markdown body content like "summary" prose
    const aiActivitySection = entry.body.split('## AI Activity')[1] ?? '';
    expect(aiActivitySection).not.toContain('This is a short AI-generated summary');
  });

  it('wikilink target has no .md and no leading slash', async () => {
    const config = makeConfig();
    const result = makeResult({
      changes: [
        {
          type: 'added',
          sourceName: 'infra',
          relPath: 'runbook.md',
          destinationPath: '/vault/Infrastructure/infra/runbook.md',
          syncedAt: new Date().toISOString(),
        },
      ],
      addedCount: 1,
    });
    const { filename } = await generateChangelog(
      config,
      result,
      startedAt,
      finishedAt,
      adapter,
    );
    const entry = adapter.entries.get(`/vault/_changelog/${filename}`)!;
    // Target should not have .md extension
    expect(entry.body).not.toMatch(/\[\[.*\.md\|/);
    // Should not start with slash in target
    expect(entry.body).not.toMatch(/\[\[\//);
  });
});
