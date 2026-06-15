/**
 * discover.ts — candidate source discovery for `obsync discover` (D-65).
 *
 * discoverCandidates() lists the immediate subdirectories of `root` and
 * returns those that contain at least one `.md` file anywhere in their
 * tree (recursive, early-exit on first match — does not enumerate all
 * files). Subdirectories matching an existing source path, matching a
 * global ignore pattern, or reached via a symlink are excluded.
 *
 * Mirrors src/sync/scanner.ts's recursive readdir + lstat-symlink-skip shape
 * and `ScanOptions._readdirSync`/`_lstatSync` injection convention so this
 * is fully unit-testable without real filesystem fixtures (T-05-06).
 */

import * as fs from 'fs';
import * as path from 'path';
import { shouldIgnore } from '../sync/ignore';

/**
 * Candidate — a subdirectory of the scanned root that looks like a viable
 * source (contains at least one non-ignored, non-symlinked .md file).
 */
export interface Candidate {
  /** Absolute path to the candidate directory. */
  path: string;
  /** Folder basename — used as the default source name. */
  name: string;
}

/**
 * Options for discoverCandidates — not part of the public API.
 * Used only for test injection, mirroring src/sync/scanner.ts ScanOptions.
 */
export interface DiscoverOptions {
  /** Override for fs.readdirSync — inject in tests. */
  _readdirSync?: (root: string, opts: Record<string, unknown>) => unknown[];
  /** Override for fs.lstatSync — inject in tests to simulate symlinks. */
  _lstatSync?: (p: string) => Pick<fs.Stats, 'isSymbolicLink'>;
}

/**
 * normalizeAbsPath — forward-slash-normalize a path without injecting a drive letter.
 *
 * `path.resolve()` on Windows adds the cwd's drive letter to root-relative paths
 * (e.g. '/root' -> 'C:/root'), which desyncs comparisons against paths built via
 * `path.join` (which never adds a drive letter). Already-absolute inputs are
 * normalized as-is; only relative inputs go through `path.resolve`.
 */
function normalizeAbsPath(p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(p);
  return abs.split('\\').join('/');
}

interface DirentLike {
  name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}

/**
 * Recursively scan `dir` for the first non-ignored, non-symlinked `.md`
 * file. Early-exits on the first match (does not enumerate the full tree).
 *
 * @param dir - Absolute path to the directory to scan.
 * @param ignorePatterns - Global ignore patterns (config.ignore).
 * @param readdirSync - Injected fs.readdirSync-shaped function.
 * @param lstatSyncFn - Injected fs.lstatSync-shaped function.
 * @returns true if at least one matching .md file was found.
 */
function containsMarkdownFile(
  dir: string,
  rootDir: string,
  ignorePatterns: string[],
  readdirSync: (root: string, opts: Record<string, unknown>) => unknown[],
  lstatSyncFn: (p: string) => Pick<fs.Stats, 'isSymbolicLink'>,
): boolean {
  const entries = readdirSync(dir, {
    withFileTypes: true,
    recursive: false,
  }) as DirentLike[];

  for (const entry of entries) {
    const absPath = path.join(dir, entry.name).split('\\').join('/');

    if (entry.isDirectory()) {
      if (containsMarkdownFile(absPath, rootDir, ignorePatterns, readdirSync, lstatSyncFn)) {
        return true;
      }
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }

    // Skip symlinks via lstat (T-05-06 — do not follow symlinks).
    try {
      const lstat = lstatSyncFn(absPath);
      if (lstat.isSymbolicLink()) {
        continue;
      }
    } catch {
      continue;
    }

    const relPath = path.relative(rootDir, absPath).split('\\').join('/');
    if (shouldIgnore(relPath, ignorePatterns)) {
      continue;
    }

    // Found a non-ignored, non-symlinked .md file — early-exit.
    return true;
  }

  return false;
}

/**
 * discoverCandidates — list immediate subdirectories of `root` that look
 * like viable sources (D-65).
 *
 * @param root - Absolute or ~-relative path to scan. Resolved internally.
 * @param existingSourcePaths - Resolved paths of already-configured sources;
 *   any matching subdirectory is excluded.
 * @param ignorePatterns - Global ignore patterns (config.ignore) applied to
 *   the recursive .md existence check.
 *
 *   Note: top-level ignore matching only considers the immediate
 *   subdirectory's basename (e.g. "node_modules"), not its path relative to
 *   `root`. Multi-segment patterns intended to match nested paths (e.g.
 *   "src/generated/") will not exclude a top-level candidate here, though
 *   they still apply correctly inside containsMarkdownFile's recursive scan.
 * @param opts - Optional fs injection for testing.
 * @returns Candidates with `name` set to the subdirectory's basename.
 */
export function discoverCandidates(
  root: string,
  existingSourcePaths: string[],
  ignorePatterns: string[],
  opts: DiscoverOptions = {},
): Candidate[] {
  const readdirSync =
    opts._readdirSync ??
    ((dir: string, o: Record<string, unknown>) =>
      (fs.readdirSync(dir, o as Parameters<typeof fs.readdirSync>[1]) as unknown) as unknown[]);
  const lstatSyncFn = opts._lstatSync ?? ((p: string) => fs.lstatSync(p));

  const resolvedRoot = normalizeAbsPath(root);
  const resolvedExisting = new Set(existingSourcePaths.map(normalizeAbsPath));

  const topEntries = readdirSync(resolvedRoot, {
    withFileTypes: true,
    recursive: false,
  }) as DirentLike[];

  const candidates: Candidate[] = [];

  for (const entry of topEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const absPath = path.join(resolvedRoot, entry.name).split('\\').join('/');

    // Skip symlinked subdirectories — do not follow (T-05-06).
    try {
      const lstat = lstatSyncFn(absPath);
      if (lstat.isSymbolicLink()) {
        continue;
      }
    } catch {
      continue;
    }

    // Exclude existing source paths.
    if (resolvedExisting.has(normalizeAbsPath(absPath))) {
      continue;
    }

    // Exclude paths matching global ignore patterns (e.g. "ignored-dir/").
    if (shouldIgnore(entry.name, ignorePatterns) || shouldIgnore(entry.name + '/', ignorePatterns)) {
      continue;
    }

    if (containsMarkdownFile(absPath, absPath, ignorePatterns, readdirSync, lstatSyncFn)) {
      candidates.push({ path: absPath, name: entry.name });
    }
  }

  return candidates;
}
