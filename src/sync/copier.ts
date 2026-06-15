import * as fs from 'fs/promises';
import * as path from 'path';
import { stringify as yamlStringify } from 'yaml';
import { sha256 } from '../utils/hash';
import { getGitRef } from '../utils/git';
import { mergeFrontmatter } from './frontmatter';
import { extractInlineTags } from './tags';
import { isUnder } from '../utils/paths';
import { appendAuditEntry } from '../audit/logger';
import type { SourceFile } from './scanner';
import type { ObsyncConfig } from '../config/types';
import type { OutputAdapter, VaultEntry } from '../adapters/interface';

/**
 * CopyResult — the outcome of a single copyFile call.
 */
export interface CopyResult {
  /** Absolute path to the source file that was processed. */
  sourceFile: string;
  /** Absolute path in the vault where the file was (or would be) written. */
  destinationPath: string;
  /** SHA-256 hex digest of the source file content at time of processing. */
  hash: string;
  /** Git commit SHA of the last commit touching the source file, or null. */
  gitRef: string | null;
  /**
   * Outcome of the operation:
   * - 'copied': File was written to the vault successfully.
   * - 'skipped_toml': File has TOML frontmatter — obsync skips frontmatter injection (D-15).
   * - 'dry_run': dryRun=true, no file was written.
   * - 'error': An error occurred; see errorMessage for details.
   */
  status: 'copied' | 'skipped_toml' | 'dry_run' | 'error';
  /** Human-readable error description. Only set when status='error'. */
  errorMessage?: string;
  /**
   * Deduplicated union of merged frontmatter+config-label tags and inline #hashtag
   * tags extracted from the body (D-67/D-68). Only set when status='copied'.
   */
  tags?: string[];
}

/**
 * Build the vault destination path from a source file using D-08 formula.
 *
 * Formula: path.join(vaultRoot, category, sourceName, relPath)
 *
 * This is deterministic — the same source file always maps to the same vault path (D-09).
 *
 * @param sf - The source file to build the destination path for.
 * @param vaultRoot - Absolute path to the vault root directory.
 * @returns Absolute destination path inside the vault.
 */
export function buildDestPath(sf: SourceFile, vaultRoot: string): string {
  return path.join(vaultRoot, sf.category, sf.sourceName, sf.relPath);
}

/**
 * Copy a single source file into the vault via the provided OutputAdapter.
 *
 * Per-file orchestration (SYNC-06 per-file error handling):
 *   1. Read source file (async, read-only per D-25, SEC-08)
 *   2. Compute SHA-256 hash of content
 *   3. Get git ref for the source file
 *   4. Build obsync_* fields
 *   5. Merge frontmatter (gray-matter parse + spread)
 *   6. Build destination path using D-08 formula
 *   7. Engine-side path confinement check (D-19, first check)
 *   8. If dryRun: log audit entry and return status='dry_run'
 *   9. If mergeResult.skipped (TOML/JSON): log audit entry and return status='skipped_toml'
 *  10. Build VaultEntry and call adapter.writeEntry
 *  11. Append audit entry type='file_copied'
 *  12. Return CopyResult with status='copied'
 *
 * Any exception is caught and returned as status='error' — caller continues (SYNC-06).
 *
 * @param sourceFile - The source file descriptor from the scanner.
 * @param config - The full validated config (vault path comes from config.vault.path).
 * @param adapter - The OutputAdapter implementation (ObsidianAdapter in Phase 1).
 * @param auditLogPath - Optional audit log file path (undefined → default ~/.obsync/audit.log).
 * @param dryRun - If true, no vault files are written.
 * @param operation - Whether this copy is a first-time add or a re-sync update of an existing
 *   file. Computed by the caller (engine) from its preRunStateKeys snapshot. Included in the
 *   file_copied audit entry. Defaults to 'added' for backward compatibility.
 * @returns A CopyResult describing the outcome.
 */
export async function copyFile(
  sourceFile: SourceFile,
  config: ObsyncConfig,
  adapter: OutputAdapter,
  auditLogPath: string | undefined,
  dryRun: boolean,
  operation: 'added' | 'updated' = 'added',
): Promise<CopyResult> {
  const now = new Date().toISOString();
  let destinationPath = '';
  let hash = '';
  let gitRef: string | null = null;

  try {
    // Step 1: Read source file async, read-only (D-25, SEC-08)
    const content = await fs.readFile(sourceFile.absPath, 'utf-8');

    // Step 2: Compute SHA-256 hash
    hash = sha256(content);

    // Step 3: Get git ref
    gitRef = getGitRef(sourceFile.absPath);

    // Step 4: Build obsync_* fields
    const obsyncFields = {
      obsync_source: sourceFile.sourceName,
      obsync_hash: hash,
      obsync_synced_at: now,
      obsync_git_ref: gitRef,
    };

    // Step 5: Merge frontmatter — look up source config to pass labels (CAT-02)
    const sourceConfig = config.sources.find((s) => s.name === sourceFile.sourceName);
    const labels = sourceConfig?.labels ?? [];
    const mergeResult = mergeFrontmatter(content, obsyncFields, labels);

    // D-67/D-68: compute deduplicated union of merged frontmatter+config-label tags
    // and inline #hashtag tags extracted from the pre-AI-injection body (Pitfall 6).
    const mergedFrontmatterTags = Array.isArray(mergeResult.mergedData['tags'])
      ? (mergeResult.mergedData['tags'] as string[])
      : [];
    const inlineTags = extractInlineTags(mergeResult.body);
    const fileTags = [
      ...mergedFrontmatterTags,
      ...inlineTags.filter((t) => !mergedFrontmatterTags.includes(t)),
    ];

    // Step 6: Build destination path using D-08 formula
    destinationPath = buildDestPath(sourceFile, config.vault.path);

    // Step 7: Engine-side path confinement check (D-19, first check before building VaultEntry)
    if (!isUnder(config.vault.path, destinationPath)) {
      throw new Error(
        `path confinement violation: "${destinationPath}" is not under vault root "${config.vault.path}"`,
      );
    }

    // Step 8: Dry run — log and return without writing
    if (dryRun) {
      appendAuditEntry(
        {
          type: 'file_skipped',
          timestamp: now,
          sourceName: sourceFile.sourceName,
          sourceFile: sourceFile.absPath,
          reason: 'dry_run',
        },
        auditLogPath,
      );
      return { sourceFile: sourceFile.absPath, destinationPath, hash, gitRef, status: 'dry_run' };
    }

    // Step 9: TOML/JSON skipped — log and return without writing
    if (mergeResult.skipped) {
      appendAuditEntry(
        {
          type: 'file_skipped',
          timestamp: now,
          sourceName: sourceFile.sourceName,
          sourceFile: sourceFile.absPath,
          reason: 'toml_frontmatter',
        },
        auditLogPath,
      );
      return { sourceFile: sourceFile.absPath, destinationPath, hash, gitRef, status: 'skipped_toml' };
    }

    // Step 10: Build VaultEntry and write via adapter
    const vaultEntry: VaultEntry = {
      destinationPath,
      mergedFrontmatter: mergeResult.mergedData,
      body: mergeResult.body,
      metadata: {
        sourceFile: sourceFile.absPath,
        hash,
        gitRef,
        syncedAt: now,
      },
    };

    await adapter.writeEntry(vaultEntry);

    // Step 11: Append audit entry for successful copy
    // Reconstruct the full written content (frontmatter + body) to match what the adapter writes:
    // '---\n' + frontmatterYaml + '---\n' + body (mirrors ObsidianAdapter.writeEntry)
    const frontmatterYaml = yamlStringify(vaultEntry.mergedFrontmatter);
    const fullContent = '---\n' + frontmatterYaml + '---\n' + vaultEntry.body;
    appendAuditEntry(
      {
        type: 'file_copied',
        timestamp: now,
        sourceName: sourceFile.sourceName,
        sourceFile: sourceFile.absPath,
        destinationFile: destinationPath,
        byteCount: Buffer.byteLength(fullContent, 'utf-8'),
        operation,
      },
      auditLogPath,
    );

    // Step 12: Return success result
    return {
      sourceFile: sourceFile.absPath,
      destinationPath,
      hash,
      gitRef,
      status: 'copied',
      tags: fileTags,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      sourceFile: sourceFile.absPath,
      destinationPath,
      hash,
      gitRef,
      status: 'error',
      errorMessage: message,
    };
  }
}
