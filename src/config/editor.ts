/**
 * editor.ts — comment-preserving obsync.yml editor (D-61/D-64).
 *
 * appendSource() reads the existing obsync.yml as a `yaml` Document, appends
 * a new entry to the `sources:` sequence using the Document API (preserving
 * comments and formatting elsewhere in the file), then re-validates the
 * resulting document with ObsyncConfigSchema before returning it. The caller
 * (e.g. `obsync add`) is responsible for writing the returned string via
 * writeConfigAtomic — appendSource never writes to disk itself, so a failed
 * validation always leaves obsync.yml untouched (pre-write guard, mirrors
 * initConfig's existence check in src/config/init.ts).
 *
 * Validation performed before returning (T-05-04, T-05-03, SEC-09):
 *   - doc.toString() must re-parse and pass ObsyncConfigSchema.safeParse
 *   - the new source's name must not duplicate an existing source's name
 *   - the new source's path must not overlap the vault path (SEC-09, via the
 *     shared `checkPathOverlap` helper, also used by src/config/loader.ts
 *     Step 9 — both expand `~` before comparing)
 *
 * writeConfigAtomic() performs the tmp-write + chmod(0o600) + rename pattern
 * from src/config/init.ts (SEC-01) so callers don't need to duplicate it.
 */

import * as fs from 'fs';
import { parseDocument, parse as parseYaml } from 'yaml';
import { ObsyncConfigSchema } from './types';
import { checkPathOverlap } from '../utils/paths';

/**
 * ConfigEditError — typed error thrown by appendSource for all rejection
 * paths. Mirrors ConfigLoadError (src/config/loader.ts) so CLI callers can
 * catch config-edit failures specifically.
 */
export class ConfigEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigEditError';
  }
}

/**
 * NewSourceInput — the shape of a new source entry to append.
 *
 * Mirrors the writable fields of SourceSchema (src/config/types.ts).
 * `ignore` and other Zod-defaulted fields are intentionally omitted here —
 * ObsyncConfigSchema.safeParse fills in defaults (`ignore: []`, etc.) during
 * re-validation, so the YAML node only needs the fields the user actually
 * configured.
 */
export interface NewSourceInput {
  name: string;
  path: string;
  category: string;
  scan: 'scattered' | 'docs';
  ai_summary: boolean;
  labels: string[];
  docs_path?: string;
}

/**
 * appendSource — add a new source entry to obsync.yml, preserving comments.
 *
 * @param configPath - Path to the existing obsync.yml.
 * @param newSource - The new source entry to append.
 * @returns The full edited YAML content as a string. The caller must write
 *   this to disk (e.g. via writeConfigAtomic) — appendSource never writes.
 * @throws ConfigEditError if obsync.yml has no `sources:` sequence, if the
 *   resulting document fails ObsyncConfigSchema validation, if the new
 *   source's name duplicates an existing source, or if the new source's path
 *   overlaps the vault path (SEC-09).
 */
export function appendSource(configPath: string, newSource: NewSourceInput): string {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const doc = parseDocument(raw);

  const sources = doc.get('sources', true);
  if (sources == null || typeof (sources as { add?: unknown }).add !== 'function') {
    throw new ConfigEditError(
      `obsync.yml is missing a 'sources:' sequence — cannot append new source "${newSource.name}".`,
    );
  }

  const newNode = doc.createNode(newSource);
  (sources as { add: (node: unknown) => void }).add(newNode);

  const newRaw = doc.toString();

  // Re-validate the full edited document (T-05-04, D-61).
  let reparsed: unknown;
  try {
    reparsed = parseYaml(newRaw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigEditError(`Edited config failed to re-parse as YAML: ${message}`);
  }

  const result = ObsyncConfigSchema.safeParse(reparsed);
  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => {
        const fieldPath = issue.path.join('.');
        const label = fieldPath ? `[${fieldPath}]` : '[config]';
        return `${label}: ${issue.message}`;
      })
      .join('\n');
    throw new ConfigEditError(`Edited config failed validation:\n${formatted}`);
  }

  const config = result.data;

  // Duplicate-name check across all sources (including the newly appended one).
  const namesSeen = new Set<string>();
  for (const source of config.sources) {
    if (namesSeen.has(source.name)) {
      throw new ConfigEditError(
        `Edited config has duplicate source name "${source.name}". Source names must be unique.`,
      );
    }
    namesSeen.add(source.name);
  }

  // Path-overlap check (SEC-09) — shared with src/config/loader.ts Step 9.
  // vault.path / source.path are expanded (~ → os.homedir()) before
  // comparison by checkPathOverlap, so a `vault.path: ~/vault`-style entry
  // (the default produced by `obsync init`) is correctly detected.
  const overlapping = checkPathOverlap(config.vault.path, config.sources);
  if (overlapping !== null) {
    throw new ConfigEditError(
      `Path overlap detected (SEC-09): source '${overlapping.name}' path '${overlapping.path}' ` +
        `overlaps with vault path '${config.vault.path}'. ` +
        'Source paths must not be inside the vault, and vice versa.',
    );
  }

  return newRaw;
}

/**
 * writeConfigAtomic — write obsync.yml content atomically with 0600 perms (SEC-01).
 *
 * Reuses the tmp-write + chmod(0o600) + rename pattern from
 * src/config/init.ts initConfig() so a crash mid-write leaves the original
 * obsync.yml intact (the .obsync.tmp file is cleaned up on failure).
 *
 * @param configPath - Path to obsync.yml.
 * @param content - The full new YAML content (e.g. from appendSource).
 */
export function writeConfigAtomic(configPath: string, content: string): void {
  const tmpConfigPath = configPath + '.obsync.tmp';
  try {
    fs.writeFileSync(tmpConfigPath, content, { mode: 0o600 });
    fs.chmodSync(tmpConfigPath, 0o600);
    fs.renameSync(tmpConfigPath, configPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpConfigPath);
    } catch {
      /* ignore — tmp may not exist */
    }
    throw err;
  }
}
