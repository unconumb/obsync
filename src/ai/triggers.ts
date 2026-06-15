/**
 * evaluateTrigger — D-26 priority chain deciding whether a file is due for AI summarization.
 *
 * AI-08: Smart triggers prevent needless re-summarization (and CPU/Ollama spikes).
 * AI-06: Staleness re-generation fires ONLY when content has actually changed,
 *        including under a frontmatter flag (status: final / draft: false) — this
 *        prevents unbounded repeat Ollama calls on unchanged flagged content
 *        (Blocker-2 fix, T-03-13).
 *
 * currentContentHash is sha256(body) — the SHA-256 of the frontmatter-stripped body,
 * computed by the Plan 03 engine and threaded in via TriggerInput. It is NEVER
 * recomputed here (no hashing/crypto import) and is NOT the same as copier.ts's
 * result.hash (sha256 over the FULL FILE including frontmatter) — reusing that value
 * would falsely trip the AI-06 content-changed gate on a frontmatter-only edit.
 */

import type { FileStateEntry } from '../state/types';

/** Ten minutes in milliseconds — D-28 idle threshold. */
const IDLE_THRESHOLD_MS = 10 * 60 * 1000;

/** D-28 line-delta threshold — must be strictly greater than this to trigger. */
const LINE_DELTA_THRESHOLD = 20;

/**
 * TriggerInput — everything evaluateTrigger needs to decide if a file is due
 * for AI summarization. All values are read/computed by the caller (the Plan 03
 * engine) at scan time; evaluateTrigger is a pure decision function.
 */
export interface TriggerInput {
  /** Git commit ref (full SHA) for the file's source repo, or null if not git-tracked. */
  gitRef: string | null;
  /** Parsed frontmatter of the source file (D-34: body-only inference, but frontmatter still informs the trigger). */
  frontmatter: Record<string, unknown>;
  /** File mtime in milliseconds (epoch), used for the D-28 idle fallback. */
  mtimeMs: number;
  /** Current line count of the body, used for the D-28 idle-fallback line-diff check. */
  currentLineCount: number;
  /** sha256(body) — frontmatter-stripped body hash, threaded in (never recomputed here). */
  currentContentHash: string;
  /** Prior state entry for this file, or undefined if never synced/summarized. */
  stateEntry: FileStateEntry | undefined;
  /** Current time in milliseconds (epoch), injected for testability. */
  now: number;
}

/**
 * evaluateTrigger — D-26 priority chain: git-commit > frontmatter flag (content-hash
 * gated, AI-06) > idle+line-diff fallback (D-28).
 *
 * Flat early-return control flow (max 2-3 nesting levels), matching the
 * decision-logic-over-state style used in src/sync/differ.ts.
 */
export function evaluateTrigger(input: TriggerInput): boolean {
  const { gitRef, frontmatter, mtimeMs, currentLineCount, currentContentHash, stateEntry, now } = input;

  // No prior summary at all (first summarization) — always due.
  if (!stateEntry?.aiSummarizedAt) {
    return true;
  }

  // D-26 priority 1: git-tracked sources use the git-commit trigger. This wins
  // over the frontmatter flag and idle fallback even if those would also fire.
  if (gitRef !== null) {
    return gitRef !== stateEntry.aiGitRefAtSummary;
  }

  // D-26 priority 2: not git-tracked — check the frontmatter flag (status: final
  // or draft: false). AI-06: re-fire ONLY when content has changed since the last
  // summary (currentContentHash !== stateEntry.aiSummaryHash) — prevents unbounded
  // repeat Ollama calls on unchanged status:final / draft:false files (Blocker-2).
  if (frontmatter['status'] === 'final' || frontmatter['draft'] === false) {
    return currentContentHash !== stateEntry.aiSummaryHash;
  }

  // D-28 fallback: idle cooldown (10+ min untouched) AND line-count delta > 20.
  // Idle alone must not re-fire (Pitfall 3) — both conditions are required.
  const idleMs = now - mtimeMs;
  const lineDelta = Math.abs(currentLineCount - (stateEntry.aiLineCountAtSummary ?? 0));
  return idleMs >= IDLE_THRESHOLD_MS && lineDelta > LINE_DELTA_THRESHOLD;
}
