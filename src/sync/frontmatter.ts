import matter from 'gray-matter';

/**
 * Fields that obsync injects/overwrites on every sync run (D-13).
 * All fields are obsync-owned and always reflect the current sync run.
 * obsync_git_ref is null when source is not in a git repository.
 */
export interface ObsyncFields {
  obsync_source: string;
  obsync_hash: string;
  obsync_synced_at: string; // ISO 8601 (Dataview-compatible, META-05)
  obsync_git_ref: string | null;
}

/**
 * Result of merging source frontmatter with obsync-owned fields.
 * When skipped=true the file had TOML or JSON frontmatter and no obsync_* fields
 * were injected — the file should still be copied as-is (D-15).
 */
export interface MergeResult {
  mergedData: Record<string, unknown>;
  body: string;
  skipped: boolean;
  skipReason?: 'toml' | 'json';
}

/**
 * Parse rawContent frontmatter and inject obsync_* fields.
 *
 * Rules enforced:
 *   D-12: Source wins on all non-obsync_* fields — source fields copied as-is.
 *   D-13: obsync_* fields are always overwritten (spread order guarantees this).
 *   D-14: obsync never adds fields not in source or obsync_* namespace.
 *   D-15: TOML (+++) and JSON ({) frontmatter: return skipped=true, no injection.
 *   D-16: Prior obsync_* fields in vault copy are overwritten by spread.
 *   CAT-02: labels are appended to existing tags without duplicates (additive merge, never replace).
 *
 * @param rawContent - Raw file content string.
 * @param obsyncFields - Fresh obsync-owned fields for this sync run.
 * @param labels - Source labels to inject as tags (CAT-02). Defaults to [] (no-op, backward compat).
 * @returns MergeResult with merged frontmatter data and body string.
 */
export function mergeFrontmatter(
  rawContent: string,
  obsyncFields: ObsyncFields,
  labels: string[] = [],
): MergeResult {
  // D-15: TOML frontmatter detection — must check raw byte 0 (three plus signs).
  if (rawContent.startsWith('+++')) {
    return { mergedData: {}, body: rawContent, skipped: true, skipReason: 'toml' };
  }

  // D-15: JSON frontmatter detection — trimStart handles optional BOM/leading whitespace.
  if (rawContent.trimStart().startsWith('{')) {
    return { mergedData: {}, body: rawContent, skipped: true, skipReason: 'json' };
  }

  // gray-matter handles YAML frontmatter parsing and the --- delimiter edge cases
  // (horizontal rules in body vs frontmatter delimiters) — do not re-implement.
  const parsed = matter(rawContent);

  // CAT-02: Normalize existing tags to string[] for merge.
  // Source file may have tags as string[] (YAML array), plain string, or absent.
  const existingTags: string[] = Array.isArray(parsed.data['tags'])
    ? (parsed.data['tags'] as string[])
    : typeof parsed.data['tags'] === 'string'
    ? [parsed.data['tags'] as string]
    : [];

  // Append labels without duplicates (additive merge — never remove existing tags, META-03 spirit).
  // If labels is empty or no labels remain after dedup filter, mergedTags equals existingTags.
  const mergedTags: string[] =
    labels.length > 0
      ? [...existingTags, ...labels.filter((l) => !existingTags.includes(l))]
      : existingTags;

  // Only inject tags field if there are tags to set (do not inject empty array, D-14 spirit).
  const tagsField: Record<string, unknown> = mergedTags.length > 0 ? { tags: mergedTags } : {};

  // D-12 + D-13 + D-14 + D-16: spread order is critical.
  //   { ...parsed.data }     — all source fields preserved (D-12, D-14)
  //   { ...tagsField }       — tags merged (existing + labels, no duplicates) (CAT-02)
  //   { ...obsyncFields }    — obsync_* overwrite any same-named source fields (D-13, D-16)
  // obsync_* always wins because it is spread last; tags is not an obsync_* field.
  const mergedData: Record<string, unknown> = { ...parsed.data, ...tagsField, ...obsyncFields };

  return {
    mergedData,
    body: parsed.content,
    skipped: false,
  };
}
