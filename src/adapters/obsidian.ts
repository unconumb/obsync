import * as fs from 'fs';
import * as path from 'path';
import { stringify as yamlStringify } from 'yaml';
import { isUnder, OBSYNC_TMP_SUFFIX } from '../utils/paths';
import type { VaultEntry, OutputAdapter } from './interface';

/**
 * ObsidianAdapter — implements OutputAdapter for writing vault entries as Obsidian
 * markdown files with YAML frontmatter.
 *
 * Security guarantees (D-19, D-22, SEC-06):
 *   - Path confinement is re-validated inside writeEntry (second check after copier's check)
 *   - Atomic write: content written to <dest>OBSYNC_TMP_SUFFIX then fs.renameSync to final path
 *   - Any pre-existing OBSYNC_TMP_SUFFIX file is deleted before write (orphan cleanup, Pitfall 1)
 *
 * ARCH-01 / ARCH-02 / ARCH-03: ObsidianAdapter implements OutputAdapter; the engine
 * depends only on OutputAdapter, never on this class directly.
 *
 * D-20: All Obsidian-specific concerns (YAML serialization, folder creation, callout syntax)
 * live here, not in the engine.
 */
export class ObsidianAdapter implements OutputAdapter {
  private readonly vaultRoot: string;

  /**
   * @param vaultRoot - Absolute path to the Obsidian vault root directory.
   *                    Must already be resolved to an absolute path before passing in.
   */
  constructor(vaultRoot: string) {
    this.vaultRoot = path.resolve(vaultRoot);
  }

  /**
   * Write a single vault entry atomically.
   *
   * Steps:
   *   1. Path confinement check (adapter side, D-19 defense-in-depth)
   *   2. Create parent directories (mkdirSync recursive)
   *   3. Construct YAML frontmatter block using yaml.stringify
   *   4. Construct finalContent: '---\n' + frontmatterYaml + '---\n' + entry.body
   *   5. Atomic write: unlink any pre-existing OBSYNC_TMP_SUFFIX file, writeFileSync to .tmp, renameSync to final
   *
   * @throws Error with 'path confinement violation' if destinationPath is outside vaultRoot
   * @throws Error if any filesystem operation fails
   */
  async writeEntry(entry: VaultEntry): Promise<void> {
    // Step 1: Path confinement — adapter-side validation (D-19, second check)
    if (!isUnder(this.vaultRoot, entry.destinationPath)) {
      throw new Error(
        `path confinement violation: "${entry.destinationPath}" is not under vault root "${this.vaultRoot}"`,
      );
    }

    // Step 2: Create parent directory structure
    const destDir = path.dirname(entry.destinationPath);
    fs.mkdirSync(destDir, { recursive: true });

    // Step 3: Serialize YAML frontmatter using yaml.stringify
    // yaml.stringify produces 'key: value\n' lines without trailing ---
    const frontmatterYaml = yamlStringify(entry.mergedFrontmatter);

    // Step 4: Construct final content with YAML frontmatter delimiters
    const finalContent = '---\n' + frontmatterYaml + '---\n' + entry.body;

    // Step 5: Atomic write — write to OBSYNC_TMP_SUFFIX then rename to final path (D-22)
    const tmpPath = entry.destinationPath + OBSYNC_TMP_SUFFIX;

    // Defense-in-depth: validate tmpPath is also within the vault (D-19)
    if (!isUnder(this.vaultRoot, tmpPath)) {
      throw new Error(`path confinement violation on tmp path: "${tmpPath}"`);
    }

    // Clean up any orphaned .tmp file from a prior crash (Pitfall 1)
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // File does not exist — that is the expected case; ignore the error
    }

    fs.writeFileSync(tmpPath, finalContent, 'utf-8');
    fs.renameSync(tmpPath, entry.destinationPath);
  }

  /**
   * Remove a previously-written vault file.
   *
   * Steps:
   *   1. Path confinement check (adapter side, D-19 defense-in-depth — same guarantee as writeEntry)
   *   2. Attempt fs.promises.unlink; ENOENT (already gone) is swallowed — idempotent success
   *
   * Does not delete or prune parent directories — only the file itself.
   *
   * @throws Error with 'path confinement violation' if destinationPath is outside vaultRoot
   * @throws Error if unlink fails for a reason other than the file not existing
   */
  async deleteEntry(destinationPath: string): Promise<void> {
    // Step 1: Path confinement — adapter-side validation (D-19, mirrors writeEntry)
    if (!isUnder(this.vaultRoot, destinationPath)) {
      throw new Error(
        `path confinement violation: "${destinationPath}" is not under vault root "${this.vaultRoot}"`,
      );
    }

    // Step 2: Remove the file, treating ENOENT as success (idempotent)
    try {
      await fs.promises.unlink(destinationPath);
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }
}
