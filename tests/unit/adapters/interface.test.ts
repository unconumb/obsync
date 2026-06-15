import { describe, it, expect } from 'vitest';
import type { OutputAdapter, VaultEntry } from '../../../src/adapters/interface';
import type { StateFile, FileStateEntry } from '../../../src/state/types';

// Test: A mock class implementing OutputAdapter compiles and can be assigned to OutputAdapter type
describe('OutputAdapter interface', () => {
  it('A mock class implementing OutputAdapter can be assigned to OutputAdapter type', () => {
    class MockAdapter implements OutputAdapter {
      async writeEntry(_entry: VaultEntry): Promise<void> {
        // no-op mock
      }

      async deleteEntry(_destinationPath: string): Promise<void> {
        // no-op mock
      }
    }

    const adapter: OutputAdapter = new MockAdapter();
    expect(adapter).toBeDefined();
    expect(typeof adapter.writeEntry).toBe('function');
    expect(typeof adapter.deleteEntry).toBe('function');
  });

  it('VaultEntry object with all required fields satisfies the interface', () => {
    const entry: VaultEntry = {
      destinationPath: '/vault/Infrastructure/thornode/runbook.md',
      mergedFrontmatter: {
        title: 'Runbook',
        obsync_source: 'thornode',
        obsync_hash: 'abc123',
        obsync_synced_at: '2026-06-09T13:50:00Z',
        obsync_git_ref: null,
      },
      body: '# Runbook\n\nThis is the body.',
      metadata: {
        sourceFile: '/home/user/thornode/runbook.md',
        hash: 'abc123def456',
        gitRef: null,
        syncedAt: '2026-06-09T13:50:00Z',
      },
    };

    expect(entry.destinationPath).toBe('/vault/Infrastructure/thornode/runbook.md');
    expect(entry.mergedFrontmatter).toHaveProperty('title');
    expect(entry.body).toContain('# Runbook');
    expect(entry.metadata.hash).toBe('abc123def456');
    expect(entry.metadata.gitRef).toBeNull();
    expect(entry.metadata.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// Test: StateFile shape
describe('StateFile interface', () => {
  it('StateFile with version 1 and files map is valid', () => {
    const entry: FileStateEntry = {
      hash: 'deadbeef',
      syncedAt: '2026-06-09T13:50:00Z',
      gitRef: 'abc1234567890abcdef1234567890abcdef12345678',
      sourceName: 'thornode',
      destinationPath: '/vault/Infrastructure/thornode/runbook.md',
    };

    const state: StateFile = {
      version: '1',
      updatedAt: '2026-06-09T13:50:00Z',
      files: {
        'runbook.md': entry,
      },
    };

    expect(state.version).toBe('1');
    expect(state.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(state.files['runbook.md']).toEqual(entry);
    expect(state.files['runbook.md'].gitRef).toBeTruthy();
  });

  it('StateFile with null gitRef in entry is valid (non-git source)', () => {
    const entry: FileStateEntry = {
      hash: 'cafebabe',
      syncedAt: '2026-06-09T13:50:00Z',
      gitRef: null,
      sourceName: 'personal',
      destinationPath: '/vault/Personal/Bio/about.md',
    };

    const state: StateFile = {
      version: '1',
      updatedAt: '2026-06-09T13:50:00Z',
      files: {
        'about.md': entry,
      },
    };

    expect(state.files['about.md'].gitRef).toBeNull();
    expect(state.files['about.md'].sourceName).toBe('personal');
  });
});
