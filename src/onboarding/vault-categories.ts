/**
 * vault-categories.ts — vault-aware category picker scan (VCAT-01).
 *
 * Scans `vault.path` two levels deep (PARA-style top-level folders plus
 * their immediate subfolders) to build category picker options that
 * reflect the user's actual vault structure, e.g. `02-areas` and
 * `02-areas/sysadmin`.
 *
 * `_readdirSync`/`_existsSync` are dependency-injected (default
 * `fs.readdirSync(dir, { withFileTypes: true })` / `fs.existsSync`)
 * following the same convention as `detectScan`'s `existsFn`
 * (src/onboarding/detect.ts) and `scanSource`'s `ScanOptions`
 * (src/sync/scanner.ts) — keeps this function unit-testable without
 * touching the real filesystem or mocking non-configurable CJS module
 * properties.
 *
 * `inferCategory` (src/onboarding/detect.ts) remains the D-03 picker
 * default supplier when no source path has been chosen yet — this module
 * does not duplicate or modify it.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * VaultCategoryScanOptions — injection seam for scanVaultCategories.
 */
export interface VaultCategoryScanOptions {
  /** Override for fs.readdirSync(dir, { withFileTypes: true }) — inject in tests. */
  _readdirSync?: (dir: string) => fs.Dirent[];
  /** Override for fs.existsSync — inject in tests. */
  _existsSync?: (p: string) => boolean;
}

/**
 * PARA_DEFAULTS — flat fallback category list (D-03) used when `vault.path`
 * does not exist or has no non-hidden depth-1 directories.
 */
const PARA_DEFAULTS = ['00-inbox', '01-projects', '02-areas', '03-resources', '04-archive'];

/**
 * isHiddenOrInternal — broad prefix filter for picker exclusions (D-04).
 *
 * Excludes dotfiles (`.obsidian`, `.git`, ...) and obsync-generated
 * internal folders (`_index`, `_changelog`, `_dashboard`, ...) at both
 * scan depths. Deliberately a broad `startsWith` filter, not an exact-name
 * allowlist — see 08-RESEARCH.md Pitfall 5.
 */
function isHiddenOrInternal(name: string): boolean {
  return name.startsWith('.') || name.startsWith('_');
}

/**
 * scanVaultCategories — list category picker options derived from vault.path (VCAT-01).
 *
 * Depth-2 scan (D-01): top-level PARA-like folders + their immediate
 * subfolders, e.g. `02-areas`, `02-areas/sysadmin` (subfolder keys use
 * `path.posix.join` for vault-relative forward-slash style). Filters
 * dotfiles and `_`-prefixed directories at both levels (D-04).
 *
 * Falls back to PARA_DEFAULTS if `vaultPath` doesn't exist or has zero
 * non-hidden depth-1 directories (D-03).
 *
 * @param vaultPath - Absolute path to the Obsidian vault root.
 * @param opts - Optional `_readdirSync`/`_existsSync` overrides for tests.
 */
export function scanVaultCategories(
  vaultPath: string,
  opts: VaultCategoryScanOptions = {},
): string[] {
  const existsSync = opts._existsSync ?? fs.existsSync;
  const readdirSync =
    opts._readdirSync ?? ((dir: string) => fs.readdirSync(dir, { withFileTypes: true }));

  if (!existsSync(vaultPath)) {
    return PARA_DEFAULTS;
  }

  const depth1 = readdirSync(vaultPath)
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !isHiddenOrInternal(name));

  if (depth1.length === 0) {
    return PARA_DEFAULTS;
  }

  const results: string[] = [];
  for (const top of depth1) {
    results.push(top);
    const topPath = path.join(vaultPath, top).split('\\').join('/');
    if (!existsSync(topPath)) {
      continue;
    }
    let depth2Entries: ReturnType<typeof readdirSync>;
    try {
      depth2Entries = readdirSync(topPath);
    } catch {
      // Unreadable subfolder (TOCTOU race, permission-denied, broken
      // symlink, etc.) — skip it rather than crashing the picker.
      continue;
    }
    const depth2 = depth2Entries
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => !isHiddenOrInternal(name));
    for (const sub of depth2) {
      results.push(path.posix.join(top, sub));
    }
  }
  return results;
}
