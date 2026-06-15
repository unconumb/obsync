import { describe, it, expect } from 'vitest';
import { sha256 } from '../../../src/utils/hash';

describe('sha256', () => {
  it('returns a 64-character hex string for a known string input', () => {
    const result = sha256('hello world');
    expect(result).toHaveLength(64);
    // SHA-256 of 'hello world' (actual computed value — not the well-known b94d27... which is SHA-1)
    expect(result).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('returns the same result for a Buffer with the same bytes as a string', () => {
    const str = 'obsync test content';
    const buf = Buffer.from(str, 'utf-8');
    expect(sha256(str)).toBe(sha256(buf));
  });

  it('result length is always 64 hex characters', () => {
    const inputs = ['', 'a', 'hello', 'x'.repeat(1000)];
    for (const input of inputs) {
      expect(sha256(input)).toHaveLength(64);
    }
  });
});
