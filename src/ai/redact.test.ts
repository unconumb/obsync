import { describe, it, expect } from 'vitest';
import { redact } from './redact';

describe('redact — built-in pattern classes (REDACT-01)', () => {
  it('replaces an IPv4 address with [REDACTED:IPv4] and adds IPv4 to matchedTypes', () => {
    const result = redact('Connect to 192.168.1.1 now');

    expect(result.redactedText).toBe('Connect to [REDACTED:IPv4] now');
    expect(result.matchedTypes).toContain('IPv4');
  });

  it('replaces a PEM block with [REDACTED:PEM_BLOCK] and adds PEM_BLOCK to matchedTypes', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAT\n-----END PRIVATE KEY-----';
    const result = redact(`Here is a key:\n${pem}\nDone.`);

    expect(result.redactedText).toContain('[REDACTED:PEM_BLOCK]');
    expect(result.redactedText).not.toContain('BEGIN PRIVATE KEY');
    expect(result.matchedTypes).toContain('PEM_BLOCK');
  });

  it.each([
    ['api_key: sk-abc123', 'api_key'],
    ['password: hunter2', 'password'],
    ['token: x', 'token'],
    ['secret: y', 'secret'],
  ])('redacts "%s" and adds SECRET to matchedTypes (case-insensitive key match)', (input) => {
    const result = redact(input);

    expect(result.redactedText).toContain('[REDACTED:SECRET]');
    expect(result.matchedTypes).toContain('SECRET');
  });

  it('does NOT add IPv6 to matchedTypes for a body containing only a 40-char git SHA (Pitfall 2)', () => {
    const sha = 'a'.repeat(40);
    const result = redact(`obsync_git_ref: ${sha}`);

    expect(result.matchedTypes).not.toContain('IPv6');
    expect(result.redactedText).toContain(sha);
  });

  it('redacts IPv6 forms and adds IPv6 to matchedTypes', () => {
    const result = redact('fe80::1 and ::1');

    expect(result.matchedTypes).toContain('IPv6');
    expect(result.redactedText).not.toContain('fe80::1');
  });
});

describe('redact — custom patterns (D-35)', () => {
  it('replaces matches of a custom pattern with [REDACTED:CUSTOM] and adds CUSTOM, additive to built-ins', () => {
    const result = redact('Connect to 192.168.1.1 and thornode42 now', ['thornode[0-9]+']);

    expect(result.redactedText).toContain('[REDACTED:IPv4]');
    expect(result.redactedText).toContain('[REDACTED:CUSTOM]');
    expect(result.redactedText).not.toContain('thornode42');
    expect(result.matchedTypes).toContain('IPv4');
    expect(result.matchedTypes).toContain('CUSTOM');
  });
});

describe('redact — matchedTypes invariants', () => {
  it('deduplicates matchedTypes when multiple matches of the same type exist', () => {
    const result = redact('IPs: 192.168.1.1 and 10.0.0.1');

    const ipv4Count = result.matchedTypes.filter((t) => t === 'IPv4').length;
    expect(ipv4Count).toBe(1);
  });

  it('matchedTypes never contains a matched value — only known type-name strings', () => {
    const knownTypes = new Set(['IPv4', 'IPv6', 'PEM_BLOCK', 'SECRET', 'CUSTOM']);
    const result = redact('192.168.1.1 password: hunter2 fe80::1', ['hunter[0-9]*']);

    for (const t of result.matchedTypes) {
      expect(knownTypes.has(t)).toBe(true);
    }
    expect(result.redactedText).not.toContain('192.168.1.1');
    expect(result.redactedText).not.toContain('hunter2');
  });
});
