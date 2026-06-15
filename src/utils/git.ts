import { execFileSync } from 'child_process';
import * as path from 'path';

/**
 * Get the most recent git commit ref (full SHA-1) for the given file path.
 *
 * Returns the SHA of the last commit that touched the specific file — not the
 * repo HEAD. Uses execFileSync with explicit argv to avoid shell interpolation.
 *
 * Returns null if:
 *   - The path is not inside a git repository
 *   - execFileSync throws for any reason (exit code != 0, not found, etc.)
 *   - The returned string is not exactly a 40-character hex string
 *
 * Security (T-05-03): stdio is ['ignore','pipe','ignore'] to prevent stderr
 * leakage. The returned string is validated to be exactly 40 hex chars before
 * being passed to callers — no other data from the git process is retained.
 *
 * The cwd is set to the directory containing filePath so that git resolves
 * the repository relative to the file, not the process working directory.
 */
export function getGitRef(filePath: string): string | null {
  try {
    const dir = path.dirname(filePath);
    const output = execFileSync(
      'git',
      ['log', '-1', '--format=%H', '--', path.basename(filePath)],
      { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const ref = output.trim();
    // Validate exactly 40 hex chars — reject any malformed or empty output
    if (/^[0-9a-f]{40}$/.test(ref)) {
      return ref;
    }
    return null;
  } catch {
    return null;
  }
}
