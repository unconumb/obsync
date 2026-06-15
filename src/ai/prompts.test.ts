import { describe, it, expect } from 'vitest';
import {
  selectSummaryPrompt,
  LONG_DOC_THRESHOLD_CHARS,
  SHORT_SUMMARY_PROMPT,
  LONG_SUMMARY_PROMPT,
} from './prompts';

describe('selectSummaryPrompt (D-32)', () => {
  it('returns SHORT_SUMMARY_PROMPT for short documents', () => {
    expect(selectSummaryPrompt('A short doc.')).toBe(SHORT_SUMMARY_PROMPT);
  });

  it('returns LONG_SUMMARY_PROMPT for documents over LONG_DOC_THRESHOLD_CHARS', () => {
    const longDoc = 'x'.repeat(LONG_DOC_THRESHOLD_CHARS + 1);
    expect(selectSummaryPrompt(longDoc)).toBe(LONG_SUMMARY_PROMPT);
  });

  it('returns SHORT_SUMMARY_PROMPT at exactly the threshold (boundary)', () => {
    const boundaryDoc = 'x'.repeat(LONG_DOC_THRESHOLD_CHARS);
    expect(selectSummaryPrompt(boundaryDoc)).toBe(SHORT_SUMMARY_PROMPT);
  });
});
