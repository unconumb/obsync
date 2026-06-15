/**
 * pending.ts — shared per-source pending-change count computation.
 *
 * Extracted from src/cli/commands/watch.ts so both `obsync watch` and
 * `obsync sync` can produce the `pendingCountBySource` map that
 * buildStatusPayload() (D-04/D-05) requires, without duplicating the
 * scan+diff logic.
 */

import * as fs from 'fs';
import type { ObsyncConfig } from '../config/types';
import { scanSource } from '../sync/scanner';
import { diffSources } from '../sync/differ';
import { sha256 } from '../utils/hash';
import { readState } from '../state/store';

/**
 * computePendingCountBySource — scans all configured sources, diffs against
 * the persisted state, and returns a map of source name -> pending file
 * count. A source whose scan fails is treated as 0 pending (consistent with
 * the prior watch.ts behavior).
 */
export function computePendingCountBySource(config: ObsyncConfig): Map<string, number> {
  const allSourceFiles = config.sources.flatMap((source) => {
    try {
      return scanSource(source, config.ignore);
    } catch {
      return [];
    }
  });

  const hashFn = (absPath: string): string => sha256(fs.readFileSync(absPath));
  const existsFn = (p: string): boolean => fs.existsSync(p);

  const state = readState();
  const diffResult = diffSources(allSourceFiles, state, hashFn, existsFn);

  const pendingCountBySource = new Map<string, number>();
  for (const source of config.sources) {
    pendingCountBySource.set(source.name, 0);
  }
  for (const sf of diffResult.toSync) {
    const current = pendingCountBySource.get(sf.sourceName) ?? 0;
    pendingCountBySource.set(sf.sourceName, current + 1);
  }
  return pendingCountBySource;
}
