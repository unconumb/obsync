/**
 * extractInlineTags — pure extraction of inline `#hashtag` tags from a markdown body (D-68).
 *
 * Rules enforced:
 *   D-68: A tag is `#` immediately followed by a letter or underscore, then any number of
 *         word characters or hyphens (`[A-Za-z_][\w-]*`). Tags with a leading digit
 *         (e.g. `#123numeric`) are NOT matched.
 *   D-68: A `#` only starts a tag when it is at the start of a line or preceded by
 *         whitespace. This excludes ATX headings (`## Heading`, `# Title` — space after `#`
 *         is not part of the tag pattern, so the heading marker itself never matches) and
 *         URL fragments (`https://example.com#section` — no whitespace/line-start before `#`).
 *   D-68: Fenced code blocks (``` ... ```) are stripped before scanning, via a non-greedy
 *         regex, so code samples containing `#something` never produce spurious tags.
 *   D-68: Duplicate tags are deduplicated; first-seen order is preserved.
 *
 * Pure function — no I/O, does not mutate its input.
 *
 * @param body - The markdown body to scan (post-frontmatter, pre-AI-injection per Pitfall 6).
 * @returns Array of distinct inline tags (without the leading `#`), in first-seen order.
 */
export function extractInlineTags(body: string): string[] {
  // Strip fenced code blocks first (non-greedy — do not let prose between two
  // separate fenced blocks be consumed as a single block).
  const withoutCodeBlocks = body.replace(/```[\s\S]*?```/g, '');

  // Match `#tag` at line-start or after whitespace. Leading char must be a letter
  // or underscore (excludes `#123numeric`); subsequent chars are word chars or hyphens.
  const tagRegex = /(?:^|\s)#([A-Za-z_][\w-]*)/gm;

  const tags = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(withoutCodeBlocks)) !== null) {
    tags.add(match[1]);
  }

  return [...tags];
}
