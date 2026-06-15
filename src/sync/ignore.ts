import { OBSYNC_TMP_SUFFIX } from '../utils/paths';

/**
 * Ignore pattern matching for the file scanner.
 *
 * Patterns are matched against relative paths (relative to the scan root).
 * Uses built-in Node.js string matching only — no external glob libraries
 * (PROJECT.md Rule 7: keep dependencies minimal).
 *
 * Pattern semantics:
 *   - Pattern ending with '/' → directory prefix match
 *     relPath starts with the pattern, or contains '/' + pattern + '/' (nested)
 *   - Pattern starting with '*.' → file extension match (e.g. '*.log')
 *   - All other patterns → exact match against the relative path or
 *     a segment anywhere in the path
 *
 * Built-in always-ignored suffixes:
 *   - Files ending with OBSYNC_TMP_SUFFIX (see ../utils/paths) — these are
 *     obsync's own atomic write temporaries and must never be synced (D-22).
 */
export function shouldIgnore(relPath: string, patterns: string[]): boolean {
  // Always ignore obsync temporary files (D-22)
  if (relPath.endsWith(OBSYNC_TMP_SUFFIX)) {
    return true;
  }

  // Normalize relPath to use forward slashes for cross-platform matching
  const normalizedRel = relPath.split('\\').join('/');

  for (const pattern of patterns) {
    if (pattern.endsWith('/')) {
      // Directory prefix match
      const dir = pattern; // e.g. 'node_modules/'
      if (
        normalizedRel.startsWith(dir) ||
        normalizedRel.includes('/' + dir)
      ) {
        return true;
      }
    } else if (pattern.startsWith('*.')) {
      // Extension glob match (e.g. '*.log')
      const ext = pattern.slice(1); // '.log'
      if (normalizedRel.endsWith(ext)) {
        return true;
      }
    } else {
      // Exact match against the full relative path or any path segment/component
      if (normalizedRel === pattern || normalizedRel.endsWith('/' + pattern)) {
        return true;
      }
    }
  }

  return false;
}
