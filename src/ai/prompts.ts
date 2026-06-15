/**
 * Shared prompt templates for AI summarization (D-01).
 *
 * D-01: Prompt text and selection logic are extracted into this single shared
 *       module so that OllamaProvider, ClaudeProvider, and OpenAiProvider all
 *       derive their summary instructions from the same source of truth.
 * D-32 (revised 2026-06-11): Prompt text remains fixed (not config-driven, Rule 7),
 *       but obsync selects between two fixed templates based on redacted doc
 *       length — see SHORT_SUMMARY_PROMPT / LONG_SUMMARY_PROMPT below. Originally
 *       a single "2-4 sentences" prompt (D-30); dogfooding on long multi-section
 *       runbooks showed forced prose either rambled or lost the structure that
 *       made the doc scannable.
 */

/**
 * D-32: redacted text at or below this length gets the short prose prompt;
 * above it, the bullet-point prompt is used instead.
 */
export const LONG_DOC_THRESHOLD_CHARS = 3000;

/** D-32: prompt for short documents — a TL;DR prose summary (original D-30 behavior). */
export const SHORT_SUMMARY_PROMPT =
  'Summarize this documentation in 2-4 sentences for someone scanning their knowledge base:\n\n';

/** D-32: prompt for long, multi-section documents — preserves scannable structure as bullets. */
export const LONG_SUMMARY_PROMPT =
  'This documentation is long. Summarize it as 3-5 concise bullet points capturing the key ' +
  'sections and takeaways for someone scanning their knowledge base. Start each bullet with ' +
  '"- " and do not include any preamble:\n\n';

/** D-32: select the prompt template based on redacted document length. */
export function selectSummaryPrompt(redactedText: string): string {
  return redactedText.length > LONG_DOC_THRESHOLD_CHARS
    ? LONG_SUMMARY_PROMPT
    : SHORT_SUMMARY_PROMPT;
}
