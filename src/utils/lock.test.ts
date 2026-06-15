import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireLock, releaseLock, getLockPath, LockConflictError } from './lock';

describe('lock', () => {
  let tmpDir: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-lock-test-'));
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

  describe('getLockPath', () => {
    it('returns OBSYNC_STATE_DIR/sync.lock when env var is set', () => {
      expect(getLockPath()).toBe(path.join(tmpDir, 'sync.lock'));
    });

    it('returns ~/.obsync/sync.lock when env var is unset', () => {
      delete process.env['OBSYNC_STATE_DIR'];
      expect(getLockPath()).toBe(path.join(os.homedir(), '.obsync', 'sync.lock'));
    });
  });

  describe('acquireLock', () => {
    it('writes the current PID to the lock path when no lock file exists', () => {
      acquireLock();
      const lockPath = getLockPath();
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.readFileSync(lockPath, 'utf-8').trim()).toBe(String(process.pid));
    });

    it('throws LockConflictError when a live pid already holds the lock', () => {
      const lockPath = getLockPath();
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      // The test runner's own pid is genuinely alive.
      fs.writeFileSync(lockPath, String(process.pid), 'utf-8');

      expect(() => acquireLock()).toThrow(LockConflictError);
    });

    it('removes a stale (dead-pid) lock and acquires successfully', () => {
      const lockPath = getLockPath();
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      // A very high PID extremely unlikely to be running.
      const deadPid = 999999;
      fs.writeFileSync(lockPath, String(deadPid), 'utf-8');

      acquireLock();

      expect(fs.readFileSync(lockPath, 'utf-8').trim()).toBe(String(process.pid));
    });

    it('treats a non-numeric lock file content as stale and clears it', () => {
      const lockPath = getLockPath();
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, 'not-a-pid', 'utf-8');

      acquireLock();

      expect(fs.readFileSync(lockPath, 'utf-8').trim()).toBe(String(process.pid));
    });
  });

  describe('releaseLock', () => {
    it('unlinks the lock file when present', () => {
      acquireLock();
      const lockPath = getLockPath();
      expect(fs.existsSync(lockPath)).toBe(true);

      releaseLock();

      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('is a no-op when the lock file is absent', () => {
      const lockPath = getLockPath();
      expect(fs.existsSync(lockPath)).toBe(false);

      expect(() => releaseLock()).not.toThrow();
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });
});
