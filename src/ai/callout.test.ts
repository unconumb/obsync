import { describe, it, expect } from 'vitest';
import { injectCallout } from './callout';

describe('injectCallout', () => {
  it('prepends a callout block at the top of the body when none exists', () => {
    const body = '# Title\n\nSome body content.';
    const result = injectCallout(body, 'Short summary.', 'ai-summary');

    expect(result.startsWith('> [!ai-summary]\n> Short summary.')).toBe(true);
    expect(result).toContain('# Title\n\nSome body content.');
  });

  it('prefixes each line of a multi-line summary with "> "', () => {
    const body = '# Title\n\nbody';
    const summary = 'First sentence.\nSecond sentence.';
    const result = injectCallout(body, summary, 'ai-summary');

    expect(result).toContain('> First sentence.');
    expect(result).toContain('> Second sentence.');
  });

  it('strips a summary line that is exactly "---" (REDACT-03/D-37)', () => {
    const body = '# Title\n\nbody';
    const summary = 'Line one.\n---\nLine two.';
    const result = injectCallout(body, summary, 'ai-summary');

    // No raw '---' line should appear in the output as its own line.
    const lines = result.split('\n');
    expect(lines.some((l) => l.trim() === '---')).toBe(false);
    expect(result).toContain('> Line one.');
    expect(result).toContain('> Line two.');
  });

  it('strips a summary line starting with "---" (e.g. "--- frontmatter")', () => {
    const body = '# Title\n\nbody';
    const summary = 'Safe line.\n--- malicious frontmatter delimiter';
    const result = injectCallout(body, summary, 'ai-summary');

    expect(result).not.toContain('malicious frontmatter delimiter');
    expect(result).toContain('> Safe line.');
  });

  it('every summary content line starts with "> "', () => {
    const body = 'body';
    const summary = 'Alpha.\nBeta.\nGamma.';
    const result = injectCallout(body, summary, 'ai-summary');

    const calloutLines = result.split('\n').slice(1, 4);
    for (const line of calloutLines) {
      if (line.trim().length > 0) {
        expect(line.startsWith('> ')).toBe(true);
      }
    }
  });

  it('replaces an existing callout of the same type at the top of the body (idempotent, D-33)', () => {
    const body = '# Title\n\nbody content';
    const summary1 = 'First summary.';
    const summary2 = 'Second, updated summary.';

    const once = injectCallout(body, summary1, 'ai-summary');
    const twice = injectCallout(once, summary2, 'ai-summary');

    expect(twice).toContain('> Second, updated summary.');
    expect(twice).not.toContain('First summary.');
    expect(twice).toContain('# Title\n\nbody content');
  });

  it('is fully idempotent: injectCallout(injectCallout(body, s, t), s, t) === injectCallout(body, s, t)', () => {
    const body = '# Title\n\nbody content';
    const summary = 'A stable summary.';
    const calloutType = 'ai-summary';

    const once = injectCallout(body, summary, calloutType);
    const twice = injectCallout(once, summary, calloutType);

    expect(twice).toBe(once);
  });

  it('calloutType parameter changes the rendered marker', () => {
    const body = 'body';
    const result = injectCallout(body, 'A summary.', 'note');

    expect(result.startsWith('> [!note]')).toBe(true);
    expect(result).not.toContain('[!ai-summary]');
  });

  it('does not stack multiple callouts on repeated injection with different content', () => {
    const body = '# Title\n\nbody';
    let result = injectCallout(body, 'v1', 'ai-summary');
    result = injectCallout(result, 'v2', 'ai-summary');
    result = injectCallout(result, 'v3', 'ai-summary');

    const matches = result.match(/\[!ai-summary\]/g) ?? [];
    expect(matches.length).toBe(1);
    expect(result).toContain('> v3');
  });

  it('is idempotent when the summary is entirely stripped (e.g. only "---" lines)', () => {
    const body = '# Title\n\nbody';
    const summary = '---\n---';

    const once = injectCallout(body, summary, 'ai-summary');
    const twice = injectCallout(once, summary, 'ai-summary');

    expect(twice).toBe(once);
  });

  it('is idempotent when the summary is an empty string', () => {
    const body = '# Title\n\nbody';
    const summary = '';

    const once = injectCallout(body, summary, 'ai-summary');
    const twice = injectCallout(once, summary, 'ai-summary');

    expect(twice).toBe(once);
  });
});
