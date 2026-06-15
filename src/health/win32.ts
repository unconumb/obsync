import { buildDestPath } from '../sync/copier';
import type { SourceFile } from '../sync/scanner';

/**
 * Maximum safe vault-destination path length on Windows (XPLAT-05 / D-51).
 *
 * Literal interpretation per RESEARCH Open Question 2: this is checked
 * directly against `buildDestPath(...).length`, with NO `.obsync.tmp`
 * suffix arithmetic. The 20-char gap between this threshold and Windows'
 * real 260 MAX_PATH already covers the 11-char `.obsync.tmp` suffix plus
 * drive-letter/null-terminator overhead.
 */
const MAX_PATH_LENGTH = 240;

/**
 * checkWindowsPathLength — XPLAT-05 / D-51/D-52/D-53.
 *
 * Reuses `buildDestPath` (src/sync/copier.ts, D-08 formula) over the shared
 * scanner output (D-52) to find the longest vault-destination path. Warns
 * if it exceeds MAX_PATH_LENGTH, suggesting config-level fixes only (D-53)
 * — shortening the vault path or source category/folder names. Does not
 * mention Windows LongPathsEnabled registry/group-policy settings.
 *
 * Pure function: never throws, never calls process.exit (D-44). Does not
 * branch on process.platform — the orchestrator (Plan 02) owns dispatch.
 *
 * @param files - Scanner output (shared with the Linux inotify check, D-52).
 * @param vaultRoot - Absolute path to the vault root directory.
 * @returns A one-line warning string, or null if no path exceeds the limit
 *   (including when `files` is empty).
 */
export function checkWindowsPathLength(files: SourceFile[], vaultRoot: string): string | null {
  let longest: { destPath: string; length: number } | null = null;

  for (const sf of files) {
    const destPath = buildDestPath(sf, vaultRoot);
    if (!longest || destPath.length > longest.length) {
      longest = { destPath, length: destPath.length };
    }
  }

  if (longest && longest.length > MAX_PATH_LENGTH) {
    return (
      `Warning: vault destination path "${longest.destPath}" is ${longest.length} characters, ` +
      `exceeding the ${MAX_PATH_LENGTH}-character safe limit on Windows. ` +
      `Shorten the vault path or source category/folder names in obsync.yml.`
    );
  }

  return null;
}
