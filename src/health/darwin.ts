import * as os from 'os';
import * as path from 'path';
import { isUnder } from '../utils/paths';
import type { Source } from '../config/types';

/**
 * macOS folders that are subject to TCC (Transparency, Consent, and Control)
 * Full Disk Access protection regardless of whether they live under the
 * user's home directory (D-50).
 */
const PROTECTED_SUBFOLDERS = ['Desktop', 'Documents', 'Downloads', 'Library/Mobile Documents'];

/**
 * checkMacFda — XPLAT-03 / D-50.
 *
 * Warns if a configured source path resolves outside ~/, OR inside a
 * known macOS-protected folder even under ~/ (Desktop, Documents,
 * Downloads, Library/Mobile Documents / iCloud Drive). Sequoia's TCC
 * model protects these folders regardless of ~/ membership.
 *
 * `homeDir` is dependency-injected (default `os.homedir()`) per Pitfall 2 —
 * avoids os.homedir() mocking issues in CJS test environments, consistent
 * with this codebase's existing injection conventions (scanner.ts ScanOptions).
 *
 * Pure function: never throws, never calls process.exit (D-44). Does not
 * branch on process.platform — the orchestrator (Plan 02) owns dispatch.
 *
 * @param sources - Configured sources (only `name` and `path` are needed).
 * @param homeDir - The user's home directory; defaults to `os.homedir()`.
 * @returns A one-line warning string for the first matching source, or null
 *   if no source requires Full Disk Access.
 */
export function checkMacFda(
  sources: Pick<Source, 'name' | 'path'>[],
  homeDir: string = os.homedir(),
): string | null {
  const protectedRoots = PROTECTED_SUBFOLDERS.map((sub) => path.join(homeDir, sub));

  for (const source of sources) {
    const outsideHome = !isUnder(homeDir, source.path) && source.path !== homeDir;
    const insideProtected = protectedRoots.some(
      (root) => isUnder(root, source.path) || path.resolve(source.path) === path.resolve(root),
    );

    if (outsideHome || insideProtected) {
      return (
        `Warning: source '${source.name}' (${source.path}) may require Full Disk Access ` +
        `for file watching on macOS. Grant in System Settings > Privacy & Security > Full Disk Access.`
      );
    }
  }

  return null;
}
