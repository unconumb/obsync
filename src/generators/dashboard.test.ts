import { describe, it, expect, beforeEach } from 'vitest';
import type { OutputAdapter, VaultEntry } from '../adapters/interface';
import type { ObsyncConfig } from '../config/types';
import type { SyncResult } from '../sync/engine';
import { generateDashboard } from './dashboard';

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

function makeConfig(
  sources: Array<{
    name: string;
    category: string;
    labels?: string[];
  }>,
  vaultPath = '/vault',
): ObsyncConfig {
  return {
    vault: { path: vaultPath },
    sources: sources.map((s) => ({
      name: s.name,
      path: `/sources/${s.name}`,
      category: s.category,
      scan: 'scattered' as const,
      ai_summary: false,
      ignore: [],
      ai_ignore: [],
      labels: s.labels ?? [],
    })),
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

describe('generateDashboard', () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  it('writes to _dashboard/Home.md', async () => {
    const config = makeConfig([{ name: 'infra', category: 'Infrastructure' }]);
    await generateDashboard(config, makeResult(), 1, '2026-06-09-2132-sync.md', adapter);
    expect(adapter.entries.has('/vault/_dashboard/Home.md')).toBe(true);
  });

  it('frontmatter has correct fields', async () => {
    const config = makeConfig([{ name: 'infra', category: 'Infrastructure' }]);
    await generateDashboard(config, makeResult(), 42, '2026-06-09-2132-sync.md', adapter);
    const entry = adapter.entries.get('/vault/_dashboard/Home.md')!;
    expect(entry.mergedFrontmatter['obsync_generated_by']).toBe('obsync');
    expect(entry.mergedFrontmatter['obsync_sync_count']).toBe(42);
    const lastSync = entry.mergedFrontmatter['obsync_last_sync'] as string;
    expect(() => new Date(lastSync).toISOString()).not.toThrow();
  });

  it('H1 is exact string "# obsync Dashboard"', async () => {
    const config = makeConfig([{ name: 'infra', category: 'Infrastructure' }]);
    await generateDashboard(config, makeResult(), 1, '2026-06-09-2132-sync.md', adapter);
    const entry = adapter.entries.get('/vault/_dashboard/Home.md')!;
    expect(entry.body).toContain('# obsync Dashboard');
  });

  it('body contains ## Last Sync, ## Sources, ## Labels sections', async () => {
    const config = makeConfig([{ name: 'infra', category: 'Infrastructure' }]);
    await generateDashboard(config, makeResult(), 1, '2026-06-09-2132-sync.md', adapter);
    const entry = adapter.entries.get('/vault/_dashboard/Home.md')!;
    expect(entry.body).toContain('## Last Sync');
    expect(entry.body).toContain('## Sources');
    expect(entry.body).toContain('## Labels');
  });

  it('Last Sync summary line has all four counts', async () => {
    const config = makeConfig([{ name: 'infra', category: 'Infrastructure' }]);
    const result = makeResult({
      addedCount: 3,
      updatedCount: 1,
      unchangedCount: 45,
      errorCount: 0,
    });
    await generateDashboard(config, result, 5, '2026-06-09-2132-sync.md', adapter);
    const entry = adapter.entries.get('/vault/_dashboard/Home.md')!;
    expect(entry.body).toContain('3 files added');
    expect(entry.body).toContain('1 updated');
    expect(entry.body).toContain('45 unchanged');
    expect(entry.body).toContain('0 errors');
  });

  it('Last Sync summary line includes moved and removed counts between updated and unchanged', async () => {
    const config = makeConfig([{ name: 'infra', category: 'Infrastructure' }]);
    const result = makeResult({
      addedCount: 1,
      updatedCount: 2,
      movedCount: 3,
      removedCount: 4,
      unchangedCount: 5,
      errorCount: 0,
    });
    await generateDashboard(config, result, 5, '2026-06-09-2132-sync.md', adapter);
    const entry = adapter.entries.get('/vault/_dashboard/Home.md')!;
    expect(entry.body).toContain('3 moved');
    expect(entry.body).toContain('4 removed');

    const updatedIdx = entry.body.indexOf('2 updated');
    const movedIdx = entry.body.indexOf('3 moved');
    const removedIdx = entry.body.indexOf('4 removed');
    const unchangedIdx = entry.body.indexOf('5 unchanged');
    expect(updatedIdx).toBeLessThan(movedIdx);
    expect(movedIdx).toBeLessThan(removedIdx);
    expect(removedIdx).toBeLessThan(unchangedIdx);
  });

  it('changelog link uses provided changelogFilename', async () => {
    const config = makeConfig([{ name: 'infra', category: 'Infrastructure' }]);
    await generateDashboard(config, makeResult(), 1, '2026-06-09-2132-sync.md', adapter);
    const entry = adapter.entries.get('/vault/_dashboard/Home.md')!;
    expect(entry.body).toContain('[View full changelog](_changelog/2026-06-09-2132-sync.md)');
  });

  it('Sources table includes all configured sources', async () => {
    const config = makeConfig([
      { name: 'beta', category: 'Infrastructure' },
      { name: 'alpha', category: 'Projects' },
    ]);
    await generateDashboard(config, makeResult(), 1, 'changelog.md', adapter);
    const entry = adapter.entries.get('/vault/_dashboard/Home.md')!;
    expect(entry.body).toContain('| alpha |');
    expect(entry.body).toContain('| beta |');
  });

  it('Sources table rows sorted alphabetically by Source name', async () => {
    const config = makeConfig([
      { name: 'zebra', category: 'Infrastructure' },
      { name: 'alpha', category: 'Projects' },
    ]);
    await generateDashboard(config, makeResult(), 1, 'changelog.md', adapter);
    const entry = adapter.entries.get('/vault/_dashboard/Home.md')!;
    const alphaPos = entry.body.indexOf('| alpha |');
    const zebraPos = entry.body.indexOf('| zebra |');
    expect(alphaPos).toBeLessThan(zebraPos);
  });

  it('Sources table includes zero-count rows for sources with no changes', async () => {
    const config = makeConfig([{ name: 'infra', category: 'Infrastructure' }]);
    await generateDashboard(config, makeResult(), 1, 'changelog.md', adapter);
    const entry = adapter.entries.get('/vault/_dashboard/Home.md')!;
    // The row for 'infra' should show 0 for all counts
    expect(entry.body).toContain('| infra |');
    expect(entry.body).toContain('| 0 | 0 | 0 | 0 |');
  });

  it('Sources table: addedCount derived from result.changes type=added', async () => {
    const config = makeConfig([{ name: 'infra', category: 'Infrastructure' }]);
    const result = makeResult({
      changes: [
        {
          type: 'added',
          sourceName: 'infra',
          relPath: 'a.md',
          destinationPath: '/vault/Infrastructure/infra/a.md',
          syncedAt: new Date().toISOString(),
        },
        {
          type: 'added',
          sourceName: 'infra',
          relPath: 'b.md',
          destinationPath: '/vault/Infrastructure/infra/b.md',
          syncedAt: new Date().toISOString(),
        },
      ],
      addedCount: 2,
    });
    await generateDashboard(config, result, 1, 'changelog.md', adapter);
    const entry = adapter.entries.get('/vault/_dashboard/Home.md')!;
    // infra row should show 2 added
    expect(entry.body).toMatch(/\| infra \| Infrastructure \| 2 \|/);
  });

  it('Sources table: updatedCount derived from result.changes type=updated', async () => {
    const config = makeConfig([{ name: 'infra', category: 'Infrastructure' }]);
    const result = makeResult({
      changes: [
        {
          type: 'updated',
          sourceName: 'infra',
          relPath: 'a.md',
          destinationPath: '/vault/Infrastructure/infra/a.md',
          syncedAt: new Date().toISOString(),
        },
      ],
      updatedCount: 1,
    });
    await generateDashboard(config, result, 1, 'changelog.md', adapter);
    const entry = adapter.entries.get('/vault/_dashboard/Home.md')!;
    // infra row: 0 added, 1 updated
    expect(entry.body).toMatch(/\| infra \| Infrastructure \| 0 \| 1 \|/);
  });

  it('Sources table: moved/removed changes are NOT counted as updated (regression — required fix)', async () => {
    const config = makeConfig([{ name: 'infra', category: 'Infrastructure' }]);
    const result = makeResult({
      changes: [
        {
          type: 'moved',
          sourceName: 'infra',
          relPath: 'a.md',
          destinationPath: '/vault/Infrastructure/infra/a.md',
          syncedAt: new Date().toISOString(),
        },
        {
          type: 'removed',
          sourceName: 'infra',
          relPath: 'b.md',
          destinationPath: '/vault/Infrastructure/infra/b.md',
          syncedAt: new Date().toISOString(),
        },
        {
          type: 'updated',
          sourceName: 'infra',
          relPath: 'c.md',
          destinationPath: '/vault/Infrastructure/infra/c.md',
          syncedAt: new Date().toISOString(),
        },
      ],
      movedCount: 1,
      removedCount: 1,
      updatedCount: 1,
    });
    await generateDashboard(config, result, 1, 'changelog.md', adapter);
    const entry = adapter.entries.get('/vault/_dashboard/Home.md')!;
    // infra row: 0 added, 1 updated (not 3 — moved/removed must not be counted)
    expect(entry.body).toMatch(/\| infra \| Infrastructure \| 0 \| 1 \|/);
  });

  it('Labels list renders wikilinks for each label', async () => {
    const config = makeConfig([
      { name: 'infra', category: 'Infrastructure', labels: ['disaster-recovery', 'runbook'] },
    ]);
    await generateDashboard(config, makeResult(), 1, 'changelog.md', adapter);
    const entry = adapter.entries.get('/vault/_dashboard/Home.md')!;
    expect(entry.body).toContain('[[_index/Disaster-Recovery|Disaster Recovery]]');
    expect(entry.body).toContain('[[_index/Runbook|Runbook]]');
  });

  it('Labels list empty-state when no labels configured', async () => {
    const config = makeConfig([{ name: 'infra', category: 'Infrastructure', labels: [] }]);
    await generateDashboard(config, makeResult(), 1, 'changelog.md', adapter);
    const entry = adapter.entries.get('/vault/_dashboard/Home.md')!;
    expect(entry.body).toContain('*No labels configured.*');
  });

  it('all-zero run: shows zeroes not blanks', async () => {
    const config = makeConfig([{ name: 'infra', category: 'Infrastructure' }]);
    await generateDashboard(config, makeResult(), 0, 'changelog.md', adapter);
    const entry = adapter.entries.get('/vault/_dashboard/Home.md')!;
    expect(entry.body).toContain('0 files added');
    expect(entry.body).toContain('0 updated');
    expect(entry.body).toContain('0 unchanged');
    expect(entry.body).toContain('0 errors');
  });

  it('Sources table has GFM header separator row', async () => {
    const config = makeConfig([{ name: 'infra', category: 'Infrastructure' }]);
    await generateDashboard(config, makeResult(), 1, 'changelog.md', adapter);
    const entry = adapter.entries.get('/vault/_dashboard/Home.md')!;
    // GFM separator row
    expect(entry.body).toContain('|--------|');
  });
});
