/**
 * generateDashboard — produce _dashboard/Home.md on every sync run.
 *
 * Writes a single dashboard file with sync summary, Sources table, and Labels list.
 * Written through OutputAdapter.writeEntry() so atomic writes and path confinement
 * are inherited automatically.
 *
 * Requirements: DASH-01, DASH-02, DASH-03
 */

import type { ObsyncConfig } from '../config/types';
import type { SyncResult } from '../sync/engine';
import type { OutputAdapter, VaultEntry } from '../adapters/interface';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * formatLocalDateTime — returns YYYY-MM-DD date and HH:MM time strings using local time.
 * Per UI-SPEC §6.1: headings use local time, frontmatter uses UTC ISO 8601.
 */
function formatLocalDateTime(date: Date): { date: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

/**
 * labelToFilename — same transform as index-page.ts.
 * 'disaster-recovery' → 'Disaster-Recovery'
 */
function labelToFilename(label: string): string {
  return label
    .split(/[-\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-');
}

/**
 * labelToDisplayName — same transform as index-page.ts.
 * 'disaster-recovery' → 'Disaster Recovery'
 */
function labelToDisplayName(label: string): string {
  return label
    .split(/[-\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Body builder
// ---------------------------------------------------------------------------

/**
 * buildDashboardBody — constructs the markdown body for _dashboard/Home.md.
 *
 * Sections (UI-SPEC §2.3):
 * - # obsync Dashboard
 * - ## Last Sync
 * - ## Sources (GFM table)
 * - ## Labels (bulleted wikilinks)
 */
function buildDashboardBody(
  config: ObsyncConfig,
  result: SyncResult,
  now: Date,
  changelogFilename: string,
): string {
  const { date, time } = formatLocalDateTime(now);

  // ## Last Sync section
  const lastSyncLine = `**${date} at ${time}** — ${result.addedCount} files added, ${result.updatedCount} updated, ${result.movedCount} moved, ${result.removedCount} removed, ${result.unchangedCount} unchanged, ${result.errorCount} errors`;
  const changelogLink = `[View full changelog](_changelog/${changelogFilename})`;

  // ## Sources table: per-source counts from result.changes
  const addedBySource = new Map<string, number>();
  const updatedBySource = new Map<string, number>();

  for (const change of result.changes) {
    if (change.type === 'added') {
      addedBySource.set(change.sourceName, (addedBySource.get(change.sourceName) ?? 0) + 1);
    } else if (change.type === 'updated') {
      updatedBySource.set(change.sourceName, (updatedBySource.get(change.sourceName) ?? 0) + 1);
    }
    // 'moved'/'removed' changes are intentionally not counted in this table
    // (D-73) — surfaced only in the Last Sync line above.
  }

  // Per-source unchanged/error counts are not tracked in SyncResult, so the
  // table always shows 0 for those columns; aggregate totals are shown in
  // the "## Last Sync" summary line instead (UI-SPEC §2.6).

  const sortedSources = [...config.sources].sort((a, b) => a.name.localeCompare(b.name));

  const tableHeader = '| Source | Category | Added | Updated | Unchanged | Errors |';
  const tableSeparator = '|--------|----------|-------|---------|-----------|--------|';
  const tableRows = sortedSources.map((source) => {
    const added = addedBySource.get(source.name) ?? 0;
    const updated = updatedBySource.get(source.name) ?? 0;
    return `| ${source.name} | ${source.category} | ${added} | ${updated} | 0 | 0 |`;
  });

  // ## Labels section
  const allLabels = new Set<string>();
  for (const source of config.sources) {
    for (const label of source.labels) {
      allLabels.add(label);
    }
  }

  let labelsSection: string;
  if (allLabels.size === 0) {
    labelsSection = '*No labels configured.*\n';
  } else {
    const sortedLabels = [...allLabels].sort((a, b) =>
      labelToDisplayName(a).localeCompare(labelToDisplayName(b)),
    );
    labelsSection = sortedLabels
      .map((label) => `- [[_index/${labelToFilename(label)}|${labelToDisplayName(label)}]]`)
      .join('\n') + '\n';
  }

  return (
    `# obsync Dashboard\n` +
    `\n` +
    `## Last Sync\n` +
    `\n` +
    `${lastSyncLine}\n` +
    `\n` +
    `${changelogLink}\n` +
    `\n` +
    `## Sources\n` +
    `\n` +
    `${tableHeader}\n` +
    `${tableSeparator}\n` +
    tableRows.join('\n') +
    `\n` +
    `\n` +
    `## Labels\n` +
    `\n` +
    labelsSection
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * generateDashboard — writes _dashboard/Home.md with sync summary, Sources table,
 * and Labels list.
 *
 * @param config - Validated ObsyncConfig
 * @param result - SyncResult from the completed sync run
 * @param syncCount - Total sync run count (from updated state)
 * @param changelogFilename - Filename returned by generateChangelog (e.g. '2026-06-09-2132-sync.md')
 * @param adapter - OutputAdapter to write through
 */
export async function generateDashboard(
  config: ObsyncConfig,
  result: SyncResult,
  syncCount: number,
  changelogFilename: string,
  adapter: OutputAdapter,
): Promise<void> {
  const vaultRoot = config.vault.path;
  const now = new Date();

  const frontmatter: Record<string, unknown> = {
    obsync_generated_by: 'obsync',
    obsync_last_sync: now.toISOString(),
    obsync_sync_count: syncCount,
  };

  const body = buildDashboardBody(config, result, now, changelogFilename);

  const entry: VaultEntry = {
    destinationPath: `${vaultRoot}/_dashboard/Home.md`,
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
}
