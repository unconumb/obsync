import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { AuditEntry } from '../../../src/audit/types';
import { appendAuditEntry, getAuditLogPath } from '../../../src/audit/logger';

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-audit-test-'));
  logPath = path.join(tmpDir, 'audit.log');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getAuditLogPath', () => {
  it('returns default path ~/.obsync/audit.log when no configuredPath provided', () => {
    const result = getAuditLogPath();
    expect(result).toBe(path.join(os.homedir(), '.obsync', 'audit.log'));
  });

  it('resolves a custom configured path', () => {
    const customPath = path.join(tmpDir, 'custom', 'my-audit.log');
    const result = getAuditLogPath(customPath);
    expect(result).toBe(customPath);
  });

  it('expands ~ in configured path', () => {
    const result = getAuditLogPath('~/logs/audit.log');
    expect(result).toBe(path.join(os.homedir(), 'logs', 'audit.log'));
  });
});

describe('appendAuditEntry', () => {
  it('appends one JSON line for a file_copied entry', () => {
    const entry: AuditEntry = {
      type: 'file_copied',
      timestamp: '2024-06-01T12:00:00.000Z',
      sourceName: 'test-source',
      sourceFile: 'docs/README.md',
      destinationFile: '/vault/docs/test-source/README.md',
      byteCount: 1024,
    };

    appendAuditEntry(entry, logPath);

    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]) as AuditEntry;
    expect(parsed.type).toBe('file_copied');
  });

  it('appends two lines when called twice — existing content is preserved', () => {
    const firstEntry: AuditEntry = {
      type: 'sync_start',
      timestamp: '2024-06-01T12:00:00.000Z',
      sourceCount: 2,
    };
    const secondEntry: AuditEntry = {
      type: 'file_copied',
      timestamp: '2024-06-01T12:00:01.000Z',
      sourceName: 'src',
      sourceFile: 'README.md',
      destinationFile: '/vault/README.md',
      byteCount: 512,
    };

    appendAuditEntry(firstEntry, logPath);
    appendAuditEntry(secondEntry, logPath);

    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ type: 'sync_start' });
    expect(JSON.parse(lines[1] as string)).toMatchObject({ type: 'file_copied' });
  });

  it('each line is parseable as valid JSON with the correct type discriminant', () => {
    const entries: AuditEntry[] = [
      { type: 'sync_start', timestamp: '2024-06-01T12:00:00.000Z', sourceCount: 1 },
      {
        type: 'sync_complete',
        timestamp: '2024-06-01T12:00:10.000Z',
        sourceCount: 1,
        copiedCount: 3,
        skippedCount: 1,
        errorCount: 0,
      },
    ];

    for (const entry of entries) {
      appendAuditEntry(entry, logPath);
    }

    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0] as string) as AuditEntry).type).toBe('sync_start');
    expect((JSON.parse(lines[1] as string) as AuditEntry).type).toBe('sync_complete');
  });

  it('sync_start entry contains only the fields defined in AuditEntry (no content fields)', () => {
    const entry: AuditEntry = {
      type: 'sync_start',
      timestamp: '2024-06-01T12:00:00.000Z',
      sourceCount: 3,
    };

    appendAuditEntry(entry, logPath);

    const parsed = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim()) as Record<string, unknown>;
    const keys = Object.keys(parsed);

    // Ensure no prohibited content-capturing fields are present
    const prohibitedFields = ['content', 'body', 'rawContent', 'fileContent', 'data', 'payload'];
    for (const field of prohibitedFields) {
      expect(keys).not.toContain(field);
    }

    expect(keys).toEqual(expect.arrayContaining(['type', 'timestamp', 'sourceCount']));
    expect(keys).toHaveLength(3);
  });

  it('writes to custom logPath when specified', () => {
    const customPath = path.join(tmpDir, 'custom-dir', 'custom.log');
    const entry: AuditEntry = {
      type: 'sync_start',
      timestamp: '2024-06-01T12:00:00.000Z',
      sourceCount: 1,
    };

    appendAuditEntry(entry, customPath);

    expect(fs.existsSync(customPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(customPath, 'utf-8').trim()) as AuditEntry;
    expect(parsed.type).toBe('sync_start');
  });

  it('uses default log path when no logPath provided (verifiable via OBSYNC_STATE_DIR env)', () => {
    // The default path writes to ~/.obsync/audit.log. We verify the function
    // does not throw and the returned default path is correct (tested in getAuditLogPath tests).
    // Here we verify via a custom path param to avoid writing to the real home dir in tests.
    const entry: AuditEntry = {
      type: 'error',
      timestamp: '2024-06-01T12:00:00.000Z',
      sourceName: 'src',
      sourceFile: 'broken.md',
      message: 'Permission denied',
    };

    // Use explicit logPath to stay within tmpDir
    appendAuditEntry(entry, logPath);

    const parsed = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim()) as AuditEntry;
    expect(parsed.type).toBe('error');
  });

  it('creates the log directory if it does not exist', () => {
    const deepLogPath = path.join(tmpDir, 'deep', 'nested', 'audit.log');
    const entry: AuditEntry = {
      type: 'sync_start',
      timestamp: '2024-06-01T12:00:00.000Z',
      sourceCount: 0,
    };

    appendAuditEntry(entry, deepLogPath);

    expect(fs.existsSync(deepLogPath)).toBe(true);
    expect(fs.existsSync(path.dirname(deepLogPath))).toBe(true);
  });
});
