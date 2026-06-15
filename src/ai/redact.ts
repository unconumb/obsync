/**
 * redact — pure pre-inference redaction pass.
 *
 * REDACT-01: Strip IPv4/IPv6 addresses, PEM blocks, and token/password/secret/api_key
 *            key-value pairs from body text before it reaches any AI provider.
 * REDACT-02: Return the set of pattern TYPE NAMES that matched (e.g. ['IPv4', 'PEM_BLOCK'])
 *            for the audit trail — never the matched values themselves.
 * D-35: Custom regex patterns (from AiConfig.redact_patterns) are applied additively,
 *       after the built-in patterns, and tagged as 'CUSTOM'.
 * D-36: matchedTypes is the only redaction-related data permitted to cross into an
 *       audit entry (src/audit/types.ts ai_inference.redactionTypes).
 *
 * SECURITY INVARIANT: redactedText must never be logged or persisted to the audit
 * log — only matchedTypes (type-name strings) may ever reach an AuditEntry. Callers
 * (Plan 03-03 processAiSummary) must pass redactedText to AiProvider.summarize() and
 * matchedTypes to the ai_inference.redactionTypes audit field, never the reverse.
 */

export interface RedactResult {
  /** body with all matched ranges replaced by [REDACTED:<TYPE>] placeholders. */
  redactedText: string;
  /** Deduplicated pattern type names that matched. Type names only — never values. */
  matchedTypes: string[];
}

interface RedactPattern {
  type: string;
  regex: RegExp;
}

/**
 * Built-in redaction patterns (REDACT-01).
 *
 * IPv6 requires at least 2 colon-separated hex groups (Pitfall 2 / T-03-03) — this
 * prevents false-positive matches on colon-free 40-char git SHAs and content hashes
 * (e.g. obsync_git_ref, obsync_hash frontmatter values).
 */
const DEFAULT_PATTERNS: RedactPattern[] = [
  // IPv4 dotted-quad pattern (REDACT-01). This also matches dotted version/build
  // numbers in prose (e.g. "1.2.3.4") — an intentional security-over-precision
  // tradeoff: false positives on version numbers are acceptable (they are
  // replaced with a harmless [REDACTED:IPv4] placeholder), but false negatives
  // on real IP addresses are not.
  { type: 'IPv4', regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  {
    type: 'IPv6',
    regex:
      /\b(?:[0-9a-fA-F]{1,4}:){1,7}:?(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{0,4}|::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}\b/g,
  },
  { type: 'PEM_BLOCK', regex: /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g },
  { type: 'SECRET', regex: /(token|password|secret|api_key)\s*[:=]\s*\S+/gi },
];

/**
 * redact — replace built-in and custom sensitive patterns with typed placeholders.
 *
 * @param body - Untrusted document body text (already frontmatter-stripped, D-34/Pitfall 5).
 * @param customPatterns - Optional additive regex source strings (D-35). Compiled with the
 *   'g' flag. Applied after built-in patterns; matches are tagged 'CUSTOM'.
 * @returns redactedText (safe to send to an AiProvider) and matchedTypes (type names only,
 *   safe to persist to the ai_inference.redactionTypes audit field).
 */
export function redact(body: string, customPatterns: string[] = []): RedactResult {
  const matchedTypes = new Set<string>();
  let redactedText = body;

  for (const { type, regex } of DEFAULT_PATTERNS) {
    // Use a fresh global regex per test/replace call to avoid lastIndex
    // statefulness bugs from reusing a global RegExp across .test()/.replace().
    if (new RegExp(regex.source, regex.flags).test(redactedText)) {
      matchedTypes.add(type);
    }
    redactedText = redactedText.replace(new RegExp(regex.source, regex.flags), `[REDACTED:${type}]`);
  }

  // Custom patterns (D-35) — additive, tagged as CUSTOM.
  for (const pattern of customPatterns) {
    const testRe = new RegExp(pattern, 'g');
    if (testRe.test(redactedText)) {
      matchedTypes.add('CUSTOM');
    }
    const replaceRe = new RegExp(pattern, 'g');
    redactedText = redactedText.replace(replaceRe, '[REDACTED:CUSTOM]');
  }

  return { redactedText, matchedTypes: [...matchedTypes] };
}
