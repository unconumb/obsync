import { describe, it, expect } from 'vitest';
import { extractInlineTags } from './tags';

describe('extractInlineTags', () => {
  it('extracts simple inline hashtags from prose', () => {
    expect(extractInlineTags('intro #alpha and #beta-tag here')).toEqual(['alpha', 'beta-tag']);
  });

  it('does not match ATX headings (space after #)', () => {
    expect(extractInlineTags('## Heading')).toEqual([]);
    expect(extractInlineTags('# Title')).toEqual([]);
  });

  it('does not match URL fragments (no whitespace before #)', () => {
    expect(extractInlineTags('see https://example.com#section')).toEqual([]);
  });

  it('excludes tags with a leading digit', () => {
    expect(extractInlineTags('#123numeric')).toEqual([]);
  });

  it('strips fenced code blocks before scanning', () => {
    const body = '```\n#nottag\n```\n#realtag';
    expect(extractInlineTags(body)).toEqual(['realtag']);
  });

  it('does not let prose between two fenced blocks be consumed (non-greedy)', () => {
    const body = '```\n#nottag1\n```\n#realtag\n```\n#nottag2\n```';
    expect(extractInlineTags(body)).toEqual(['realtag']);
  });

  it('deduplicates repeated tags', () => {
    expect(extractInlineTags('#dup #dup')).toEqual(['dup']);
  });

  it('allows underscores in tags, including a leading underscore', () => {
    expect(extractInlineTags('#tag_with_underscore #_leading')).toEqual([
      'tag_with_underscore',
      '_leading',
    ]);
  });

  it('returns an empty array for body with no tags', () => {
    expect(extractInlineTags('plain prose with no tags at all')).toEqual([]);
  });

  // D-68 explicitly requires whitespace or line-start immediately before `#`.
  // The following document the resulting (intentional) behavior for
  // punctuation-adjacent and chained hashtags so future readers don't mistake
  // these gaps for bugs (WR-04).
  it('does not match a tag immediately following another tag with no whitespace', () => {
    expect(extractInlineTags('#a#b')).toEqual(['a']); // documents current behavior
  });

  it('does not match a tag inside parentheses (preceded by "(" rather than whitespace)', () => {
    expect(extractInlineTags('see (#tag)')).toEqual([]); // documents current behavior — '(' is not whitespace
  });
});
