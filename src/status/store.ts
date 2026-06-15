/**
 * store.ts — atomic status.json persistence (D-10, STATUS-02).
 *
 * Implements the `.tmp` + `renameSync` atomic write lifecycle for
 * status.json, mirroring `src/state/store.ts`'s `writeState` but WITHOUT
 * the `.bak` step — status.json is ephemeral/derived (written fresh by
 * `obsync watch` on every sync), so a backup copy is unnecessary.
 *
 * `readStatusFile` fails soft to `null` on missing or malformed JSON
 * (T-09-03 — a crashed/buggy writer can leave malformed JSON; the reader
 * must never throw).
 */

import * as fs from 'fs';
import * as path from 'path';
import { getStateDir } from '../state/store';
import type { StatusFile } from './types';

/**
 * getStatusPath — absolute path to status.json.
 *
 * Returns `${OBSYNC_STATE_DIR}/status.json` when the env var is set (test
 * isolation, via getStateDir), else `~/.obsync/status.json`.
 */
export function getStatusPath(): string {
  return path.join(getStateDir(), 'status.json');
}

/**
 * writeStatusFile — write the StatusFile envelope to status.json atomically.
 *
 * Sequence: mkdir -p, write to status.json.tmp, rename to status.json.
 * No `.bak` step (status.json drops the backup step — RESEARCH Pattern 3).
 */
export function writeStatusFile(statusFile: StatusFile): void {
  const statusDir = getStateDir();
  const statusPath = getStatusPath();
  const tmpPath = `${statusPath}.tmp`;

  fs.mkdirSync(statusDir, { recursive: true });

  const serialized = JSON.stringify(statusFile, null, 2);
  fs.writeFileSync(tmpPath, serialized, 'utf-8');
  fs.renameSync(tmpPath, statusPath);
}

/**
 * readStatusFile — read and parse status.json.
 *
 * Fail-soft (T-09-03): returns `null` if the file does not exist or
 * contains malformed JSON. Never throws.
 */
export function readStatusFile(): StatusFile | null {
  const statusPath = getStatusPath();
  if (!fs.existsSync(statusPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as StatusFile;
  } catch {
    return null;
  }
}

/**
 * removeStatusFile — delete status.json if present (no-op if absent).
 */
export function removeStatusFile(): void {
  const statusPath = getStatusPath();
  if (fs.existsSync(statusPath)) {
    fs.unlinkSync(statusPath);
  }
}
