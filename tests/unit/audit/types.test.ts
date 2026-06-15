import { describe, it, expect } from 'vitest';
import type { AuditEntry } from '../../../src/audit/types';
import { ObsyncConfigSchema } from '../../../src/config/types';

// Test: AuditEntry discriminated union narrowing and variant validity

describe('AuditEntry discriminated union', () => {
  it('AuditEntry with type file_copied and all required fields is a valid AuditEntry', () => {
    const entry: AuditEntry = {
      type: 'file_copied',
      timestamp: '2026-06-09T13:50:00Z',
      sourceName: 'thornode',
      sourceFile: '/home/user/thornode/runbook.md',
      destinationFile: '/vault/Infrastructure/thornode/runbook.md',
      byteCount: 2048,
    };

    expect(entry.type).toBe('file_copied');
    expect(entry.sourceName).toBe('thornode');
    expect(entry.byteCount).toBe(2048);
    // Type-safety check: the type field narrows the variant
    if (entry.type === 'file_copied') {
      expect(entry.destinationFile).toBe('/vault/Infrastructure/thornode/runbook.md');
    }
  });

  it('AuditEntry with type file_skipped and reason unchanged is valid', () => {
    const entry: AuditEntry = {
      type: 'file_skipped',
      timestamp: '2026-06-09T13:50:00Z',
      sourceName: 'thornode',
      sourceFile: '/home/user/thornode/runbook.md',
      reason: 'unchanged',
    };

    expect(entry.type).toBe('file_skipped');
    expect(entry.reason).toBe('unchanged');
  });

  it('TypeScript narrowing — switch on entry.type exhaustively handles all variants', () => {
    function describeEntry(entry: AuditEntry): string {
      switch (entry.type) {
        case 'file_copied':
          return `copied ${entry.byteCount} bytes to ${entry.destinationFile}`;
        case 'file_skipped':
          return `skipped: ${entry.reason}`;
        case 'sync_start':
          return `sync started with ${entry.sourceCount} sources`;
        case 'sync_complete':
          return `sync complete: ${entry.copiedCount} copied, ${entry.skippedCount} skipped, ${entry.errorCount} errors`;
        case 'error':
          return `error: ${entry.message}`;
        case 'config_security_warning':
          return `security warning: ${entry.warningType} — ${entry.detail}`;
        case 'ai_inference':
          return `ai inference: ${entry.provider}/${entry.model} in=${entry.inputByteCount}B out=${entry.outputByteCount}B`;
        default: {
          // Exhaustive check — TypeScript will error here if a variant is missing
          const _exhaustive: never = entry;
          return `unknown: ${(_exhaustive as AuditEntry).type}`;
        }
      }
    }

    const copied: AuditEntry = {
      type: 'file_copied',
      timestamp: '2026-06-09T13:50:00Z',
      sourceName: 'thornode',
      sourceFile: 'runbook.md',
      destinationFile: '/vault/runbook.md',
      byteCount: 512,
    };
    expect(describeEntry(copied)).toBe('copied 512 bytes to /vault/runbook.md');

    const skipped: AuditEntry = {
      type: 'file_skipped',
      timestamp: '2026-06-09T13:50:00Z',
      sourceName: 'thornode',
      sourceFile: 'runbook.md',
      reason: 'dry_run',
    };
    expect(describeEntry(skipped)).toBe('skipped: dry_run');

    const syncStart: AuditEntry = {
      type: 'sync_start',
      timestamp: '2026-06-09T13:50:00Z',
      sourceCount: 3,
    };
    expect(describeEntry(syncStart)).toBe('sync started with 3 sources');

    const syncComplete: AuditEntry = {
      type: 'sync_complete',
      timestamp: '2026-06-09T13:50:00Z',
      sourceCount: 3,
      copiedCount: 10,
      skippedCount: 5,
      errorCount: 0,
    };
    expect(describeEntry(syncComplete)).toBe('sync complete: 10 copied, 5 skipped, 0 errors');

    const error: AuditEntry = {
      type: 'error',
      timestamp: '2026-06-09T13:50:00Z',
      sourceName: 'thornode',
      sourceFile: 'runbook.md',
      message: 'Permission denied',
    };
    expect(describeEntry(error)).toBe('error: Permission denied');

    const warning: AuditEntry = {
      type: 'config_security_warning',
      timestamp: '2026-06-09T13:50:00Z',
      warningType: 'world_readable',
      detail: 'obsync.yml is world-readable',
    };
    expect(describeEntry(warning)).toBe('security warning: world_readable — obsync.yml is world-readable');
  });
});

// Test: ObsyncConfig Zod schema validation

describe('ObsyncConfig Zod schema', () => {
  const minimalValidConfig = {
    vault: { path: '/Users/testuser/vault' },
    sources: [
      {
        name: 'thornode',
        path: '/Users/testuser/thornode',
        category: 'Infrastructure',
      },
    ],
  };

  it('ObsyncConfig with audit_log field set parses successfully', () => {
    const result = ObsyncConfigSchema.safeParse({
      ...minimalValidConfig,
      audit_log: '/Users/testuser/.obsync/audit.log',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.audit_log).toBe('/Users/testuser/.obsync/audit.log');
    }
  });

  it('ObsyncConfig without audit_log field also parses successfully (field is optional)', () => {
    const result = ObsyncConfigSchema.safeParse(minimalValidConfig);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.audit_log).toBeUndefined();
    }
  });

  it('ObsyncConfig with full ai block parses successfully', () => {
    const result = ObsyncConfigSchema.safeParse({
      ...minimalValidConfig,
      ai: {
        backend: 'ollama',
        model: 'qwen3.5:9b',
        ollama_url: 'http://localhost:11434',
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ai?.backend).toBe('ollama');
      expect(result.data.ai?.model).toBe('qwen3.5:9b');
    }
  });

  it('ObsyncConfig without ai block is valid (ai is optional)', () => {
    const result = ObsyncConfigSchema.safeParse(minimalValidConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ai).toBeUndefined();
    }
  });

  it('ObsyncConfig with empty sources array fails validation (min 1 required)', () => {
    const result = ObsyncConfigSchema.safeParse({
      vault: { path: '/Users/testuser/vault' },
      sources: [],
    });

    expect(result.success).toBe(false);
  });

  it('Source with scan docs mode and docs_path parses correctly', () => {
    const result = ObsyncConfigSchema.safeParse({
      vault: { path: '/Users/testuser/vault' },
      sources: [
        {
          name: 'project2',
          path: '/Users/testuser/project2',
          category: 'Projects',
          scan: 'docs',
          docs_path: 'docs',
          ai_summary: true,
          ignore: ['drafts/**'],
          labels: ['backend', 'api'],
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const source = result.data.sources[0];
      expect(source.scan).toBe('docs');
      expect(source.docs_path).toBe('docs');
      expect(source.ai_summary).toBe(true);
      expect(source.labels).toEqual(['backend', 'api']);
    }
  });
});
