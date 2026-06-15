/**
 * processAiSummary — per-file AI job: redact -> summarize -> inject callout ->
 * write -> audit -> state update.
 *
 * AI-01/AI-04/AI-06/AUDIT-02/REDACT-02: this is the function that turns an
 * eligible source file into a real `> [!ai-summary]` callout in the vault,
 * with a content-free ai_inference audit entry (including redactionTypes)
 * and a persisted AI staleness baseline in FileStateEntry.
 *
 * Mirrors src/sync/copier.ts copyFile's per-file orchestration shape: safe
 * default locals declared before the try block, a single try/catch boundary,
 * typed result with a status field, audit entries inside the try and in the
 * catch (Pitfall 1 — summarize() throwing is a per-file error, not a backend
 * unavailability signal; the queue swallows but this function logs explicitly).
 *
 * D-34/Pitfall 5: `body` MUST be the frontmatter-stripped body (MergeResult.body /
 * VaultEntry.body) — never rawContent or mergedFrontmatter. Only redacted body
 * text ever reaches provider.summarize().
 *
 * SECURITY INVARIANT: redactedText, sentText, body, and summary are NEVER
 * written to the audit log — only byte counts and redact()'s matchedTypes
 * (type-name strings, REDACT-02) cross into an AuditEntry.
 */

import { redact } from './redact';
import { injectCallout } from './callout';
import { appendAuditEntry } from '../audit/logger';
import type { AiProvider } from './provider';
import type { OutputAdapter, VaultEntry } from '../adapters/interface';
import type { AiConfig } from '../config/types';
import type { FileStateEntry } from '../state/types';

/**
 * Maximum number of UTF-8 bytes of redacted text sent to the AI provider
 * (~6000 tokens). Prevents context-window overflow on large documents
 * (RESEARCH.md Open Question 2). Text exceeding this threshold is truncated
 * to the first MAX_PROMPT_BYTES bytes with a trailing '[TRUNCATED]' marker.
 */
const MAX_PROMPT_BYTES = 24000;

/** Marker appended to redacted text truncated at MAX_PROMPT_BYTES. */
const TRUNCATION_MARKER = '\n[TRUNCATED]';

/**
 * truncateToUtf8ByteLimit — truncate `text` to at most `maxBytes` UTF-8 bytes
 * without splitting a multi-byte UTF-8 character (WR-01).
 *
 * Continuation bytes in UTF-8 always have the high bits `10xxxxxx` (i.e.
 * `(byte & 0xc0) === 0x80`). Walking `end` backwards while the byte at `end`
 * is a continuation byte ensures the cut point lands on a character boundary,
 * preventing replacement characters / garbled text in the prompt sent to the
 * AI provider for documents near the byte threshold.
 */
function truncateToUtf8ByteLimit(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString('utf-8');
}

/**
 * AiProcessResult — the outcome of a single processAiSummary call.
 * Analogous to CopyResult (src/sync/copier.ts).
 */
export interface AiProcessResult {
  /** Absolute destination path in the vault that was (or would be) re-written. */
  destinationPath: string;
  /**
   * Outcome of the operation:
   * - 'summarized': the callout was injected, the vault entry re-written, and
   *   an ai_inference audit entry was appended.
   * - 'error': summarize() (or any other step) threw; an 'error' audit entry
   *   was appended and the failure is isolated (never re-thrown).
   */
  status: 'summarized' | 'error';
  /**
   * AI staleness fields to merge into this file's FileStateEntry. Only
   * present on status === 'summarized'.
   */
  stateUpdate?: Pick<FileStateEntry, 'aiSummaryHash' | 'aiSummarizedAt' | 'aiGitRefAtSummary' | 'aiLineCountAtSummary'>;
  /** Human-readable error description. Only set when status === 'error'. */
  errorMessage?: string;
}

/**
 * Arguments for processAiSummary.
 */
export interface ProcessAiSummaryArgs {
  /** Frontmatter-stripped document body (D-34/Pitfall 5 — never rawContent). */
  body: string;
  /** Frontmatter to preserve unchanged in the re-written VaultEntry. */
  mergedFrontmatter: Record<string, unknown>;
  /** Absolute destination path in the vault to re-write with the injected callout. */
  destinationPath: string;
  /** source.name from config — used in audit entries. */
  sourceName: string;
  /** Absolute path of the source file (for error audit entries). */
  sourceFile: string;
  /** Git commit ref (full SHA) at sync time, or null if not git-tracked. */
  gitRef: string | null;
  /**
   * sha256(body) — the body-only content hash computed by the engine (NOT
   * copier.ts's result.hash, which hashes the full file including
   * frontmatter). Used verbatim as stateUpdate.aiSummaryHash so the AI-06
   * trigger gate compares like-for-like on the next run.
   */
  contentHash: string;
  /** Validated config — used for ai.model, ai.callout_type, ai.redact_patterns, ai.backend. */
  config: { ai: AiConfig };
  /** AiProvider implementation (Ollama by default). */
  provider: AiProvider;
  /** OutputAdapter implementation for re-writing the vault entry. */
  adapter: OutputAdapter;
  /** Audit log path (undefined -> default ~/.obsync/audit.log). */
  auditLogPath: string | undefined;
}

/**
 * processAiSummary — run the full redact -> summarize -> inject -> write ->
 * audit -> state pipeline for a single eligible file.
 *
 * On success: returns status 'summarized' with stateUpdate.aiSummaryHash set
 * to the threaded contentHash (NOT a freshly computed hash).
 *
 * On summarize() (or any step) throwing: catches, appends an 'error' audit
 * entry, and returns status 'error' — never re-throws (queue isolation,
 * Pitfall 1).
 */
export async function processAiSummary(args: ProcessAiSummaryArgs): Promise<AiProcessResult> {
  const {
    body,
    mergedFrontmatter,
    destinationPath,
    sourceName,
    sourceFile,
    gitRef,
    contentHash,
    config,
    provider,
    adapter,
    auditLogPath,
  } = args;

  const now = new Date().toISOString();

  try {
    // Step 1: redact (D-34 — body only, never frontmatter)
    const { redactedText, matchedTypes } = redact(body, config.ai.redact_patterns);

    // Step 2: context-window guard (Open Question 2) — truncate over-threshold
    // redacted text to MAX_PROMPT_BYTES bytes plus a trailing marker before
    // it is sent to the provider.
    let sentText = redactedText;
    if (Buffer.byteLength(redactedText, 'utf-8') > MAX_PROMPT_BYTES) {
      sentText = truncateToUtf8ByteLimit(redactedText, MAX_PROMPT_BYTES) + TRUNCATION_MARKER;
    }

    // Step 3: summarize (may throw — Pitfall 1, caught below)
    const model = config.ai.model ?? '';
    const { summary } = await provider.summarize(sentText, model);

    // Step 4: inject callout into the (untouched) frontmatter-stripped body
    const updatedBody = injectCallout(body, summary, config.ai.callout_type);

    // Step 5: re-write the vault entry with the updated body, frontmatter unchanged
    const vaultEntry: VaultEntry = {
      destinationPath,
      mergedFrontmatter,
      body: updatedBody,
      metadata: {
        sourceFile,
        hash: contentHash,
        gitRef,
        syncedAt: now,
      },
    };
    await adapter.writeEntry(vaultEntry);

    // Step 6: append ai_inference audit entry — byte counts and redactionTypes
    // (type names only, REDACT-02) — never redactedText/sentText/body/summary.
    appendAuditEntry(
      {
        type: 'ai_inference',
        timestamp: now,
        sourceName,
        provider: config.ai.backend,
        model,
        inputByteCount: Buffer.byteLength(sentText, 'utf-8'),
        outputByteCount: Buffer.byteLength(summary, 'utf-8'),
        redactionTypes: matchedTypes,
      },
      auditLogPath,
    );

    // Step 7: return AI staleness state fields (AI-06 baseline)
    return {
      destinationPath,
      status: 'summarized',
      stateUpdate: {
        aiSummaryHash: contentHash,
        aiSummarizedAt: now,
        aiGitRefAtSummary: gitRef,
        aiLineCountAtSummary: body.split('\n').length,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendAuditEntry(
      {
        type: 'error',
        timestamp: new Date().toISOString(),
        sourceName,
        sourceFile,
        message,
      },
      auditLogPath,
    );
    return {
      destinationPath,
      status: 'error',
      errorMessage: message,
    };
  }
}
