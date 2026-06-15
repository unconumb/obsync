import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { StateFile } from './types';

/**
 * Returns the directory where obsync state files are stored.
 * Always ~/.obsync — never vault root (D-23, STATE-01).
 *
 * OBSYNC_STATE_DIR env var overrides the default for test isolation.
 */
export function getStateDir(): string {
  return process.env['OBSYNC_STATE_DIR'] ?? path.join(os.homedir(), '.obsync');
}

/**
 * Returns the absolute path to the state file.
 * Always ~/.obsync/state.json (STATE-01).
 */
export function getStatePath(): string {
  return path.join(getStateDir(), 'state.json');
}

/**
 * Returns an empty StateFile with version '1' and the current timestamp.
 */
function emptyState(): StateFile {
  return {
    version: '1',
    updatedAt: new Date().toISOString(),
    files: {},
  };
}

/**
 * Read the current state from disk.
 *
 * Guarantees:
 * - Creates the state directory if it does not exist.
 * - If an orphaned state.json.tmp exists (crash mid-write), deletes it before reading.
 * - If state.json is missing, returns an empty StateFile.
 * - If state.json is corrupted (invalid JSON), falls back to state.json.bak.
 * - If both are corrupted or missing, returns an empty StateFile.
 *
 * All FS operations are synchronous (state is read once at startup, not in a hot loop).
 */
export function readState(): StateFile {
  const stateDir = getStateDir();
  const statePath = getStatePath();
  const tmpPath = `${statePath}.tmp`;
  const bakPath = `${statePath}.bak`;

  fs.mkdirSync(stateDir, { recursive: true });

  // Clean up any orphaned .tmp file left by a crash mid-write
  if (fs.existsSync(tmpPath)) {
    fs.unlinkSync(tmpPath);
  }

  // Try reading the primary state file
  if (fs.existsSync(statePath)) {
    try {
      const raw = fs.readFileSync(statePath, 'utf-8');
      return JSON.parse(raw) as StateFile;
    } catch {
      // Primary file is corrupted — try the backup
      if (fs.existsSync(bakPath)) {
        try {
          const bakRaw = fs.readFileSync(bakPath, 'utf-8');
          return JSON.parse(bakRaw) as StateFile;
        } catch {
          // Backup also corrupted — fall through to empty state
        }
      }
    }
  }

  return emptyState();
}

/**
 * Write state to disk atomically.
 *
 * Atomic write sequence (STATE-02, D-22):
 * 1. If state.json already exists, copy it to state.json.bak (enables recovery).
 * 2. Write serialized state to state.json.tmp.
 * 3. Rename state.json.tmp to state.json (atomic on POSIX; best-effort on Windows).
 *
 * If the process crashes between step 2 and step 3, readState() will clean up
 * the orphaned .tmp and recover from .bak.
 */
export function writeState(state: StateFile): void {
  const stateDir = getStateDir();
  const statePath = getStatePath();
  const tmpPath = `${statePath}.tmp`;
  const bakPath = `${statePath}.bak`;

  fs.mkdirSync(stateDir, { recursive: true });

  // Back up the current state file before overwriting
  if (fs.existsSync(statePath)) {
    fs.copyFileSync(statePath, bakPath);
  }

  const serialized = JSON.stringify(state, null, 2);
  fs.writeFileSync(tmpPath, serialized, 'utf-8');
  fs.renameSync(tmpPath, statePath);
}
