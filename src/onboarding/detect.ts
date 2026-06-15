/**
 * detect.ts — onboarding auto-detection heuristics (D-62/D-63).
 *
 * Pure functions used by `obsync add`/`obsync discover` to pre-fill
 * sensible defaults (category, name, scan mode) for a candidate source
 * path before presenting them to the user for confirmation.
 *
 * `homeDir`/`existsFn` are dependency-injected (default `os.homedir()` /
 * `fs.existsSync`) following the same convention as `checkMacFda`
 * (src/health/darwin.ts) and `scanSource`'s `ScanOptions` (src/sync/scanner.ts) —
 * keeps these functions unit-testable without touching the real filesystem
 * or mocking non-configurable CJS module properties.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * normalizeAbsPath — forward-slash-normalize a path without injecting a drive letter.
 *
 * `path.resolve()` on Windows adds the cwd's drive letter to root-relative paths
 * (e.g. '/Users/x' -> 'C:/Users/x'), which desyncs comparisons against paths built
 * via `path.join` (which never adds a drive letter). Already-absolute inputs are
 * normalized as-is; only relative inputs go through `path.resolve`.
 */
function normalizeAbsPath(p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(p);
  return abs.split('\\').join('/');
}

/**
 * inferCategory — guess a PARA vault category folder for a source path (D-63).
 *
 * Precedence (first match wins):
 *   1. Under `~/work` or `~/Dev/Work` (or equal to either) → '01-projects'
 *      (client/work folders are deadline-bound PARA "projects")
 *   2. Otherwise → '02-areas'
 *      (personal tools, infra/runbook folders, and anything else default to
 *      an ongoing area of responsibility — the safest PARA default)
 *
 * This is only a starting suggestion — `obsync add`/`discover` let the user
 * pick any category, including a freeform one.
 *
 * Uses `startsWith` (not the stricter `isUnder`) so the root directory
 * itself also matches.
 *
 * @param sourcePath - Candidate source path (absolute, ~-relative, or relative).
 * @param homeDir - The user's home directory; defaults to `os.homedir()`.
 */
export function inferCategory(sourcePath: string, homeDir: string = os.homedir()): string {
  // Normalize to forward slashes for separator-independent comparison (idiom from ignore.ts).
  // Avoid path.resolve() on already-absolute inputs: on Windows it injects the cwd's
  // drive letter (e.g. '/Users/x' -> 'C:/Users/x'), which would desync `resolved` from
  // `workRootA`/`workRootB` (built via path.join, which does not add a drive letter).
  const resolved = normalizeAbsPath(sourcePath);
  const workRootA = normalizeAbsPath(path.join(homeDir, 'work'));
  const workRootB = normalizeAbsPath(path.join(homeDir, 'Dev', 'Work'));

  if (
    resolved === workRootA ||
    resolved.startsWith(workRootA + '/') ||
    resolved === workRootB ||
    resolved.startsWith(workRootB + '/')
  ) {
    return '01-projects';
  }

  return '02-areas';
}

/**
 * detectName — derive a default source name from the folder basename (D-62).
 *
 * Resolves the path first (handles relative paths and trailing slashes)
 * then returns `path.basename`.
 *
 * @param sourcePath - Candidate source path.
 */
export function detectName(sourcePath: string): string {
  return path.basename(path.resolve(sourcePath));
}

/**
 * detectScan — guess the scan mode for a source path (D-62).
 *
 * Returns 'docs' if the resolved path contains a `docs/` or `.planning/`
 * subdirectory, otherwise 'scattered'.
 *
 * `existsFn` is dependency-injected (default `fs.existsSync`) so tests can
 * stub filesystem checks without real fixtures.
 *
 * @param sourcePath - Candidate source path.
 * @param existsFn - Override for `fs.existsSync`; defaults to the real implementation.
 */
export function detectScan(
  sourcePath: string,
  existsFn: (p: string) => boolean = fs.existsSync,
): 'scattered' | 'docs' {
  const resolved = path.resolve(sourcePath);

  if (
    existsFn(path.join(resolved, 'docs').split('\\').join('/')) ||
    existsFn(path.join(resolved, '.planning').split('\\').join('/'))
  ) {
    return 'docs';
  }

  return 'scattered';
}
