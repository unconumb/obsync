/**
 * injectCallout — body transform that prepends or replaces an AI-generated
 * summary callout block.
 *
 * D-30 (revised by D-32, 2026-06-11): Summaries are short (2-4 sentences) for short
 *       docs, or 3-5 bullet points for long multi-section docs — either form is
 *       rendered as a single callout block. Sanitization below is line-based and
 *       applies identically to both forms.
 * D-33: Idempotent — when the body already starts with a same-type callout,
 *       injectCallout replaces that block entirely. Calling injectCallout twice
 *       with the same inputs yields the same result (no stacked callouts).
 * D-37/REDACT-03: The AI response is untrusted. Before insertion: lines whose
 *       trimmed form starts with '---' are stripped (prevents frontmatter-
 *       delimiter confusion), and every remaining line is blockquote-prefixed
 *       with '> ' (prevents a blank line from terminating the callout block
 *       early and corrupting the surrounding vault body). If sanitization
 *       leaves no content (CR-01), a fixed '> (no summary)' placeholder line
 *       is used so the callout block always ends on a blockquote-prefixed
 *       line, preserving D-33 idempotency.
 * D-34: Operates strictly on the already-frontmatter-stripped body string —
 *       never re-parses or touches frontmatter.
 */

/**
 * injectCallout — prepend (or idempotently replace) a `> [!{calloutType}]`
 * callout block at the top of body, containing the sanitized summary.
 *
 * @param body - frontmatter-stripped document body (D-34).
 * @param summary - untrusted AI-generated summary text (sanitized before insertion).
 * @param calloutType - the Obsidian callout type, e.g. 'ai-summary' or 'note'.
 */
export function injectCallout(body: string, summary: string, calloutType: string): string {
  // REDACT-03/D-37: strip '---' lines (frontmatter-delimiter confusion) and
  // blockquote-prefix every remaining line (prevents blank-line callout
  // termination and any other content from escaping the callout).
  const sanitizedLines = summary
    .split('\n')
    .filter((line) => !line.trim().startsWith('---'))
    .map((line) => `> ${line}`.trimEnd())
    .filter((line, idx, arr) => !(arr.length === 1 && (line === '>' || line === '')));

  // CR-01: when sanitization leaves no real content, fall back to a fixed
  // placeholder line so calloutBlock never ends on a bare unprefixed blank
  // line (which would break D-33 idempotency on the next run).
  const contentLines = sanitizedLines.length > 0 ? sanitizedLines : ['> (no summary)'];

  const calloutBlock = `> [!${calloutType}]\n${contentLines.join('\n')}`;

  const trimmedBody = body.trimStart();

  // D-33: detect an existing same-type callout at the top of the body and
  // replace it entirely (idempotent — no stacked callouts).
  const existingCalloutPattern = new RegExp(
    `^> \\[!${calloutType}\\][\\s\\S]*?(?=\\n\\n|\\n(?!>)|$)`
  );

  if (existingCalloutPattern.test(trimmedBody)) {
    return trimmedBody.replace(existingCalloutPattern, calloutBlock);
  }

  return `${calloutBlock}\n\n${trimmedBody}`;
}
