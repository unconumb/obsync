import * as fs from 'fs';
import * as path from 'path';
import type { Source } from '../config/types';
import { shouldIgnore } from './ignore';
import { isUnder } from '../utils/paths';

/**
 * SourceFile — a single .md file discovered by scanSource.
 *
 * Passed to the differ (Plan 05) and the sync engine (Plan 07).
 * relPath is relative to the scan root (source.path or docs_path root).
 */
export interface SourceFile {
  /** Source name from config. Used as the state key prefix and vault folder name. */
  sourceName: string;
  /** Absolute path to the source root directory (after expanding ~). */
  sourcePath: string;
  /** Absolute path to this specific file. */
  absPath: string;
  /**
   * Path relative to the scan root.
   * For scattered: relative to source.path.
   * For docs: relative to path.join(source.path, source.docs_path).
   */
  relPath: string;
  /** Vault category folder (from source config). */
  category: string;
  /** Labels from source config. Applied to all files from this source. */
  labels: string[];
  /** Whether AI summarization is enabled for this source. */
  aiSummary: boolean;
}

/**
 * Internal options for scanSource — not part of the public API.
 * Used only for test injection to work around CJS non-configurable fs properties.
 */
export interface ScanOptions {
  /** Override for fs.readdirSync — inject in tests to simulate collisions. */
  _readdirSync?: (root: string, opts: Record<string, unknown>) => unknown[];
  /** Override for fs.lstatSync — inject in tests to simulate symlinks. */
  _lstatSync?: (p: string) => Pick<fs.Stats, 'isSymbolicLink'>;
}

/**
 * Scan a source directory and return all discovered .md files.
 *
 * Behavior:
 * - scan: scattered → recursively scans the full source.path
 * - scan: docs → recursively scans path.join(source.path, source.docs_path)
 * - Symlinks are skipped (lstatSync.isSymbolicLink()) — T-05-01
 * - Non-.md files are skipped
 * - Files matching any ignore pattern (source-level or global) are skipped
 * - Case collisions are warned and first occurrence is kept — T-05-02
 * - Results are sorted by absPath for deterministic ordering
 *
 * Uses fs.readdirSync with { withFileTypes: true, recursive: true }
 * (available in Node.js 18.17+ / Node.js 20+).
 *
 * @throws if the scan root does not exist or is not readable. Callers
 * (e.g. runSync) must catch this per-source and treat it as "this source's
 * scan failed" rather than "this source has zero files" — see CR-01.
 */
/**
 * Determine the scan root for a source based on its scan mode (D-03, D-04).
 *
 * - scan: 'scattered' (or 'docs' without docs_path, defensively) → source.path
 * - scan: 'docs' with docs_path set → path.join(source.path, source.docs_path)
 *
 * Shared by scanSource (file discovery) and the watch command (chokidar watch
 * paths) to keep scan-scope logic in a single place — avoids drift between
 * what gets scanned/synced and what gets watched.
 *
 * Defensive validation: if `docs_path` resolves to a location outside
 * `source.path` (e.g. via `..` traversal or an absolute path), the scan
 * root falls back to `source.path` and a warning is printed. This keeps
 * scan/watch roots confined to the configured source directory even when
 * `docs_path` is misconfigured.
 */
export function getScanRoot(source: Source): string {
  if (source.scan !== 'docs' || source.docs_path == null) {
    return source.path;
  }

  const candidate = path.join(source.path, source.docs_path);
  const resolvedSource = path.resolve(source.path);
  const resolvedCandidate = path.resolve(candidate);

  if (resolvedCandidate !== resolvedSource && !isUnder(source.path, candidate)) {
    process.stderr.write(
      `[obsync] warning: docs_path "${source.docs_path}" escapes source path "${source.path}" — using source.path instead\n`,
    );
    return source.path;
  }

  return candidate;
}

export function scanSource(
  source: Source,
  globalIgnore: string[],
  opts: ScanOptions = {},
): SourceFile[] {
  const readdirSync = opts._readdirSync ?? ((root: string, o: Record<string, unknown>) =>
    (fs.readdirSync(root, o as Parameters<typeof fs.readdirSync>[1]) as unknown) as unknown[]
  );
  const lstatSyncFn = opts._lstatSync ?? ((p: string) => fs.lstatSync(p));

  // Determine scan root based on scan mode (D-03, D-04)
  const scanRoot = getScanRoot(source);

  const allIgnorePatterns = [...source.ignore, ...globalIgnore];

  // Case collision detection map: lowercase relative path → original relative path (T-05-02)
  const caseMap = new Map<string, string>();

  const results: SourceFile[] = [];

  // If the scan root does not exist or is not readable, surface the failure
  // to the caller (rather than silently returning []). A silent empty result
  // is indistinguishable from "this source legitimately has zero files now",
  // which previously caused the reconciliation pass in runSync to treat a
  // transient scan failure as "all of this source's files were deleted" and
  // prune+delete every previously-synced vault copy for it (CR-01).
  const entries = readdirSync(scanRoot, {
    withFileTypes: true,
    recursive: true,
  }) as fs.Dirent[];

  for (const entry of entries) {
    // Skip non-files (directories are included in recursive output as entries,
    // but we only want file entries here)
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }

    // Build the absolute path for this entry.
    // In Node.js 18.17+, Dirent from recursive readdirSync has a `parentPath`
    // property (renamed from `path` in Node.js 21.9). Support both.
    const entryParent = (entry as fs.Dirent & { parentPath?: string }).parentPath
      ?? (entry as fs.Dirent & { path?: string }).path
      ?? scanRoot;

    const absPath = path.join(entryParent, entry.name);

    // Skip symlinks — lstatSync check per T-05-01
    // We check lstatSync (not stat) so we follow the link entry itself, not the target.
    try {
      const lstat = lstatSyncFn(absPath);
      if (lstat.isSymbolicLink()) {
        continue;
      }
    } catch {
      // If lstat fails (race condition, broken entry), skip this entry
      continue;
    }

    // Skip non-.md files
    if (!entry.name.endsWith('.md')) {
      continue;
    }

    // Compute relative path from scan root
    // Normalize to forward slashes for cross-platform consistency (idiom from ignore.ts)
    const relPath = path.relative(scanRoot, absPath).split('\\').join('/');

    // Apply ignore patterns
    if (shouldIgnore(relPath, allIgnorePatterns)) {
      continue;
    }

    // Case collision detection (T-05-02, D-11)
    const lowerRelPath = relPath.toLowerCase();
    if (caseMap.has(lowerRelPath)) {
      const existing = caseMap.get(lowerRelPath) as string;
      process.stderr.write(
        `[obsync] case collision: "${relPath}" and "${existing}" differ only by case — skipping "${relPath}"\n`,
      );
      continue;
    }
    caseMap.set(lowerRelPath, relPath);

    results.push({
      sourceName: source.name,
      sourcePath: source.path,
      absPath,
      relPath,
      category: source.category,
      labels: source.labels,
      aiSummary: source.ai_summary,
    });
  }

  // Sort by absPath for deterministic output
  results.sort((a, b) => a.absPath.localeCompare(b.absPath));

  return results;
}
