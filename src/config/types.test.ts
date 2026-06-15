import { describe, it, expect } from 'vitest';
import { AiConfigSchema, SourceSchema } from './types';

describe('AiConfigSchema — Phase 3 AI fields (D-31, D-35)', () => {
  it('defaults callout_type to "ai-summary" when omitted', () => {
    const result = AiConfigSchema.parse({ backend: 'ollama', model: 'qwen3.5:9b' });

    expect(result.callout_type).toBe('ai-summary');
  });

  it('defaults redact_patterns to [] when omitted', () => {
    const result = AiConfigSchema.parse({ backend: 'ollama', model: 'qwen3.5:9b' });

    expect(result.redact_patterns).toEqual([]);
  });

  it('preserves provided callout_type and redact_patterns values', () => {
    const result = AiConfigSchema.parse({
      backend: 'ollama',
      model: 'qwen3.5:9b',
      callout_type: 'note',
      redact_patterns: ['foo[0-9]+'],
    });

    expect(result.callout_type).toBe('note');
    expect(result.redact_patterns).toEqual(['foo[0-9]+']);
  });

  it('still validates backend enum and existing fields', () => {
    const result = AiConfigSchema.parse({
      backend: 'none',
      model: 'qwen3.5:9b',
      ollama_url: 'http://localhost:11434',
    });

    expect(result.backend).toBe('none');
    expect(result.model).toBe('qwen3.5:9b');
    expect(result.ollama_url).toBe('http://localhost:11434');
  });
});

describe('AiConfigSchema — WR-03: model required when backend !== "none"', () => {
  it('rejects an ollama backend with no model', () => {
    expect(() => AiConfigSchema.parse({ backend: 'ollama' })).toThrow(/ai\.model is required/);
  });

  it('rejects an ollama backend with an empty-string model', () => {
    expect(() => AiConfigSchema.parse({ backend: 'ollama', model: '   ' })).toThrow(/ai\.model is required/);
  });

  it('rejects a claude backend with no model', () => {
    expect(() => AiConfigSchema.parse({ backend: 'claude' })).toThrow(/ai\.model is required/);
  });

  it('allows backend "none" with no model', () => {
    const result = AiConfigSchema.parse({ backend: 'none' });

    expect(result.backend).toBe('none');
    expect(result.model).toBeUndefined();
  });

  it('allows a non-"none" backend with a non-empty model', () => {
    const result = AiConfigSchema.parse({ backend: 'ollama', model: 'qwen3.5:9b' });

    expect(result.model).toBe('qwen3.5:9b');
  });
});

describe('AiConfigSchema — WR-04: redact_patterns must be valid regexes', () => {
  it('accepts an empty redact_patterns array', () => {
    const result = AiConfigSchema.parse({ backend: 'none', redact_patterns: [] });

    expect(result.redact_patterns).toEqual([]);
  });

  it('accepts well-formed custom regex patterns', () => {
    const result = AiConfigSchema.parse({
      backend: 'none',
      redact_patterns: ['foo[0-9]+', '\\bACME-\\d{4}\\b'],
    });

    expect(result.redact_patterns).toEqual(['foo[0-9]+', '\\bACME-\\d{4}\\b']);
  });

  it('rejects a redact_patterns entry with an unbalanced parenthesis', () => {
    expect(() => AiConfigSchema.parse({ backend: 'none', redact_patterns: ['(unbalanced'] })).toThrow(
      /redact_patterns must contain valid regular expressions/,
    );
  });

  it('rejects redact_patterns if any single entry is invalid', () => {
    expect(() =>
      AiConfigSchema.parse({ backend: 'none', redact_patterns: ['valid[0-9]+', '(unbalanced'] }),
    ).toThrow(/redact_patterns must contain valid regular expressions/);
  });
});

describe('SourceSchema — ai_ignore field (D-74)', () => {
  const baseSource = {
    name: 'test-source',
    path: '/tmp/source',
    category: 'Docs',
  };

  it('defaults ai_ignore to [] when omitted', () => {
    const result = SourceSchema.parse(baseSource);

    expect(result.ai_ignore).toEqual([]);
  });

  it('parses a provided ai_ignore array', () => {
    const result = SourceSchema.parse({ ...baseSource, ai_ignore: ['drafts/**'] });

    expect(result.ai_ignore).toEqual(['drafts/**']);
  });
});
