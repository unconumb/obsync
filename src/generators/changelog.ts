/**
 * generateChangelog — produce _changelog/YYYY-MM-DD-HHmm-sync.md on every sync run.
 *
 * Returns { filename } so the caller can pass the changelog filename to generateDashboard.
 * Written through OutputAdapter.writeEntry() so atomic writes and path confinement
 * are inherited automatically.
 *
 * Requirements: DASH-04, DASH-05
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ObsyncConfig } from '../config/types';
import type { SyncResult } from '../sync/engine';
import type { OutputAdapter, VaultEntry } from '../adapters/interface';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * generateRunId — produces an 8-character hex string from a UUID v4.
 * Per UI-SPEC §3.2: run_id is 8-char hex prefix of UUID v4.
 */
function generateRunId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

/**
 * buildChangelogFilename — produces the YYYY-MM-DD-HHmm-sync.md filename using local time.
 * Per UI-SPEC §3.1.
 */
function buildChangelogFilename(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  return `${y}-${mo}-${d}-${h}${mi}-sync.md`;
}

/**
 * formatLocalDateTime — returns YYYY-MM-DD date and HH:MM time in local time.
 * Per UI-SPEC §6.1.
 */
function formatLocalDateTime(date: Date): { date: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

/**
 * toWikilink — vault-relative wikilink target from an absolute destination path.
 * Target: vault-relative, no .md, no leading slash.
 * Display: filename without extension.
 */
function toWikilink(
  destPath: string,
  vaultRoot: string,
): { target: string; display: string } {
  const rel = path
    .relative(vaultRoot, destPath)
    .replace(/\.md$/, '')
    .replace(/\\/g, '/');
  const display = path.basename(destPath, '.md');
  return { target: rel, display };
}

/**
 * escapeForInlineCode — sanitizes a string for safe interpolation inside a
 * backtick-delimited markdown inline-code span.
 *
 * Strips backticks (which would prematurely terminate the span) and
 * collapses newlines (which would break the single-line list item format).
 */
function escapeForInlineCode(s: string): string {
  return s.replace(/`/g, "'").replace(/\r?\n/g, ' ');
}

// ---------------------------------------------------------------------------
// Body builder
// ---------------------------------------------------------------------------

/**
 * buildAiActivitySection — constructs the "## AI Activity" section body.
 *
 * AUDIT-02/Phase 3 Plan 04: reports per-run AI summarization counts derived
 * from result.aiSummaries (counts + source names only — content-free,
 * SECURITY INVARIANT). Renders an empty/"none" state when no AI ran this
 * run (no-ai, no eligible files, or fail-closed).
 */
function buildAiActivitySection(aiSummaries: SyncResult['aiSummaries']): string {
  if (aiSummaries.length === 0) {
    return 'No files summarized this run.\n';
  }

  // Group by sourceName, count per source
  const counts = new Map<string, number>();
  for (const s of aiSummaries) {
    counts.set(s.sourceName, (counts.get(s.sourceName) ?? 0) + 1);
  }
  const sortedSources = [...counts.keys()].sort();

  const total = aiSummaries.length;
  const totalLine = total === 1 ? '1 file summarized.' : `${total} files summarized.`;

  let section = `${totalLine}\n\n`;
  for (const sourceName of sortedSources) {
    const count = counts.get(sourceName)!;
    const fileWord = count === 1 ? 'file' : 'files';
    section += `- ${sourceName}: ${count} ${fileWord}\n`;
  }
  return section;
}

/**
 * buildChangelogBody — constructs the markdown body for a per-run changelog page.
 *
 * Structure (UI-SPEC §3.3):
 * - H1: # Sync — YYYY-MM-DD HH:MM
 * - ## Added (grouped by source, or empty-state)
 * - ## Updated (grouped by source, or empty-state)
 * - ## Unchanged (count-only line, singular/plural)
 * - ## Errors (grouped by source, or "No errors.")
 * - ## AI Activity (per-run summarization counts, or "none" state)
 *
 * All H2 sections always present (UI-SPEC §3.8).
 */
function buildChangelogBody(
  result: SyncResult,
  now: Date,
  vaultRoot: string,
): string {
  const { date, time } = formatLocalDateTime(now);

  // Split changes by type
  const addedChanges = result.changes.filter((c) => c.type === 'added');
  const updatedChanges = result.changes.filter((c) => c.type === 'updated');

  // Group entries by source name, return sorted H3 sections
  const buildGroupedSection = (
    changes: typeof result.changes,
    emptyText: string,
  ): string => {
    if (changes.length === 0) {
      return `${emptyText}\n`;
    }
    // Group by sourceName
    const grouped = new Map<string, typeof changes>();
    for (const change of changes) {
      const group = grouped.get(change.sourceName) ?? [];
      group.push(change);
      grouped.set(change.sourceName, group);
    }
    const sortedSources = [...grouped.keys()].sort();
    let section = '';
    for (const sourceName of sortedSources) {
      const sourceChanges = grouped.get(sourceName)!;
      const sortedChanges = [...sourceChanges].sort((a, b) =>
        path.basename(a.destinationPath).localeCompare(path.basename(b.destinationPath)),
      );
      section += `### ${sourceName}\n\n`;
      for (const change of sortedChanges) {
        const { target, display } = toWikilink(change.destinationPath, vaultRoot);
        section += `- [[${target}|${display}]]\n`;
      }
      section += '\n';
    }
    return section;
  };

  // ## Moved / ## Removed: singular/plural, counts-only (D-73)
  const movedLine =
    result.movedCount === 1 ? '1 file moved.' : `${result.movedCount} files moved.`;
  const removedLine =
    result.removedCount === 1 ? '1 file removed.' : `${result.removedCount} files removed.`;

  // ## Unchanged: singular/plural (UI-SPEC §3.6)
  const n = result.unchangedCount;
  const unchangedLine = n === 1 ? '1 file unchanged.' : `${n} files unchanged.`;

  // ## Errors section (UI-SPEC §3.7)
  let errorsSection: string;
  if (result.errors.length === 0) {
    errorsSection = 'No errors.\n';
  } else {
    errorsSection = result.errors
      .map((e) => `- \`${escapeForInlineCode(e.file)}\` — ${escapeForInlineCode(e.message)}`)
      .join('\n') + '\n';
  }

  const addedSection = buildGroupedSection(addedChanges, '*Nothing added this run.*');
  const updatedSection = buildGroupedSection(updatedChanges, '*Nothing updated this run.*');
  const aiActivitySection = buildAiActivitySection(result.aiSummaries);

  return (
    `# Sync — ${date} ${time}\n` +
    `\n` +
    `## Added\n` +
    `\n` +
    addedSection +
    `## Updated\n` +
    `\n` +
    updatedSection +
    `## Moved\n` +
    `\n` +
    `${movedLine}\n` +
    `\n` +
    `## Removed\n` +
    `\n` +
    `${removedLine}\n` +
    `\n` +
    `## Unchanged\n` +
    `\n` +
    `${unchangedLine}\n` +
    `\n` +
    `## Errors\n` +
    `\n` +
    errorsSection +
    `\n` +
    `## AI Activity\n` +
    `\n` +
    aiActivitySection
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * generateChangelog — writes _changelog/{YYYY-MM-DD-HHmm-sync.md} and returns { filename }.
 *
 * The returned filename should be passed to generateDashboard as changelogFilename
 * so the dashboard can link to it.
 *
 * @param config - Validated ObsyncConfig
 * @param result - SyncResult from the completed sync run
 * @param startedAt - ISO 8601 UTC string when runSync() began
 * @param finishedAt - ISO 8601 UTC string when runSync() completed
 * @param adapter - OutputAdapter to write through
 * @returns { filename } — the changelog filename (relative, not full path)
 */
export async function generateChangelog(
  config: ObsyncConfig,
  result: SyncResult,
  startedAt: string,
  finishedAt: string,
  adapter: OutputAdapter,
): Promise<{ filename: string }> {
  const vaultRoot = config.vault.path;
  const runId = generateRunId();
  const now = new Date();
  const filename = buildChangelogFilename(now);

  const frontmatter: Record<string, unknown> = {
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    total_added: result.addedCount,
    total_updated: result.updatedCount,
    total_moved: result.movedCount,
    total_removed: result.removedCount,
    total_unchanged: result.unchangedCount,
    total_errors: result.errorCount,
    obsync_generated_by: 'obsync',
  };

  const body = buildChangelogBody(result, now, vaultRoot);

  const entry: VaultEntry = {
    destinationPath: `${vaultRoot}/_changelog/${filename}`,
    mergedFrontmatter: frontmatter,
    body,
    metadata: {
      sourceFile: '',
      hash: '',
      gitRef: null,
      syncedAt: now.toISOString(),
    },
  };

  await adapter.writeEntry(entry);
  return { filename };
}
