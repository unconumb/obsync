import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getStatusPath, writeStatusFile, readStatusFile, removeStatusFile } from './store';
import type { StatusFile } from './types';

function makeStatusFile(overrides: Partial<StatusFile> = {}): StatusFile {
  return {
    sync: {
      state: 'idle',
      lastSyncAt: null,
      counts: { added: 0, updated: 0, moved: 0, removed: 0, unchanged: 0, errors: 0 },
      errors: [],
    },
    ai: { backend: 'none', queueDepth: 0 },
    sources: [],
    vault: { path: '/tmp/vault' },
    pid: process.pid,
    port: 12345,
    updatedAt: '2026-06-13T00:00:00.000Z',
    ...overrides,
  };
}

describe('status/store', () => {
  let tmpDir: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-status-store-test-'));
    originalStateDir = process.env['OBSYNC_STATE_DIR'];
    process.env['OBSYNC_STATE_DIR'] = tmpDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env['OBSYNC_STATE_DIR'];
    } else {
      process.env['OBSYNC_STATE_DIR'] = originalStateDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getStatusPath', () => {
    it('returns OBSYNC_STATE_DIR/status.json when env var is set', () => {
      expect(getStatusPath()).toBe(path.join(tmpDir, 'status.json'));
    });
  });

  describe('writeStatusFile / readStatusFile', () => {
    it('round-trips an identical StatusFile object', () => {
      const sf = makeStatusFile();
      writeStatusFile(sf);
      expect(readStatusFile()).toEqual(sf);
    });

    it('leaves no status.json.tmp file after a successful write', () => {
      writeStatusFile(makeStatusFile());
      expect(fs.existsSync(`${getStatusPath()}.tmp`)).toBe(false);
      expect(fs.existsSync(getStatusPath())).toBe(true);
    });
  });

  describe('readStatusFile', () => {
    it('returns null when the file does not exist', () => {
      expect(readStatusFile()).toBeNull();
    });

    it('returns null (does not throw) when the file contains malformed JSON', () => {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(getStatusPath(), '{ this is not valid json', 'utf-8');
      expect(() => readStatusFile()).not.toThrow();
      expect(readStatusFile()).toBeNull();
    });
  });

  describe('removeStatusFile', () => {
    it('deletes an existing status.json', () => {
      writeStatusFile(makeStatusFile());
      expect(fs.existsSync(getStatusPath())).toBe(true);
      removeStatusFile();
      expect(fs.existsSync(getStatusPath())).toBe(false);
    });

    it('is a no-op when status.json is absent', () => {
      expect(fs.existsSync(getStatusPath())).toBe(false);
      expect(() => removeStatusFile()).not.toThrow();
      expect(fs.existsSync(getStatusPath())).toBe(false);
    });
  });
});
