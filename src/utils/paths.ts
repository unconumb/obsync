import * as os from 'os';
import * as path from 'path';

/**
 * Expand a leading ~ to the user's home directory.
 *
 * expandHome('/absolute') returns the path unchanged.
 * expandHome('~/foo') returns os.homedir() + '/foo'.
 */
export function expandHome(p: string): string {
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/')) {
    return `${os.homedir()}/${p.slice(2)}`;
  }
  return p;
}

/**
 * Determine whether target is strictly under base (not equal to base).
 *
 * Both paths are resolved to absolute paths before comparison.
 * A trailing '/' is appended to the resolved base to prevent prefix
 * collisions where '/vault2' would incorrectly match base '/vault'.
 *
 * Returns false for path traversal attempts like '../../etc/passwd'.
 * Returns false if target equals base (file must be strictly under, not at).
 */
export function isUnder(base: string, target: string): boolean {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  // Append trailing slash to prevent /vault2 from matching /vault
  const baseWithSlash = resolvedBase.endsWith(path.sep)
    ? resolvedBase
    : resolvedBase + path.sep;
  return resolvedTarget.startsWith(baseWithSlash);
}

/**
 * Build a cross-platform state key from source name and relative path.
 *
 * Normalizes path separators to '/' so keys are consistent across
 * macOS, Linux, and Windows.
 */
export function toStateKey(sourceName: string, relPath: string): string {
  const normalized = relPath.split(path.sep).join('/');
  return `${sourceName}/${normalized}`;
}

/**
 * Suffix appended to a destination path while a file is being written
 * atomically (D-22): content is written to `<dest>${OBSYNC_TMP_SUFFIX}`
 * then renamed to `<dest>`. Shared by the write path (ObsidianAdapter)
 * and the scanner's always-ignore rule (shouldIgnore) so both recognize
 * the exact same temp-file suffix.
 */
export const OBSYNC_TMP_SUFFIX = '.obsync.tmp';

/**
 * Minimal shape of a config source needed for the SEC-09 overlap check.
 */
export interface OverlapSource {
  name: string;
  path: string;
}

/**
 * checkPathOverlap — SEC-09 path-overlap validation, shared by
 * src/config/loader.ts (Step 9) and src/config/editor.ts (appendSource).
 *
 * Expands `~` and resolves both `vaultPath` and each source's `path` before
 * comparing, so a `vault.path: ~/vault`-style entry (the default produced by
 * `obsync init`) is correctly detected as overlapping with an absolute
 * source path under the user's home directory.
 *
 * @param vaultPath - The configured vault path (raw or already-expanded).
 * @param sources - Sources to check against the vault path.
 * @returns The first overlapping source found, or `null` if none overlap.
 */
export function checkPathOverlap(
  vaultPath: string,
  sources: readonly OverlapSource[],
): OverlapSource | null {
  const resolvedVaultPath = path.resolve(expandHome(vaultPath));

  for (const source of sources) {
    const resolvedSourcePath = path.resolve(expandHome(source.path));

    const sourceInsideVault =
      resolvedSourcePath === resolvedVaultPath || isUnder(resolvedVaultPath, resolvedSourcePath);
    const vaultInsideSource =
      resolvedVaultPath === resolvedSourcePath || isUnder(resolvedSourcePath, resolvedVaultPath);

    if (sourceInsideVault || vaultInsideSource) {
      return source;
    }
  }

  return null;
}
