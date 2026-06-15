import { describe, it, expect } from 'vitest';
import { evaluateTrigger, type TriggerInput } from './triggers';
import type { FileStateEntry } from '../state/types';

const NOW = Date.parse('2026-06-10T12:00:00.000Z');
const TEN_MIN = 10 * 60 * 1000;

function baseStateEntry(overrides: Partial<FileStateEntry> = {}): FileStateEntry {
  return {
    hash: 'fullhash',
    syncedAt: '2026-06-10T11:00:00.000Z',
    gitRef: 'abc123',
    sourceName: 'project2',
    destinationPath: '/vault/Projects/project2/doc.md',
    ...overrides,
  };
}

function baseInput(overrides: Partial<TriggerInput> = {}): TriggerInput {
  return {
    gitRef: null,
    frontmatter: {},
    mtimeMs: NOW - TEN_MIN - 1000,
    currentLineCount: 100,
    currentContentHash: 'hash-a',
    stateEntry: undefined,
    now: NOW,
    ...overrides,
  };
}

describe('evaluateTrigger', () => {
  it('returns true when there is no prior summary (stateEntry undefined)', () => {
    const input = baseInput({ stateEntry: undefined });
    expect(evaluateTrigger(input)).toBe(true);
  });

  it('returns true when stateEntry exists but aiSummarizedAt is undefined', () => {
    const input = baseInput({
      stateEntry: baseStateEntry({ aiSummarizedAt: undefined }),
    });
    expect(evaluateTrigger(input)).toBe(true);
  });

  it('priority 1: git-tracked and gitRef differs from aiGitRefAtSummary returns true', () => {
    const input = baseInput({
      gitRef: 'def456',
      stateEntry: baseStateEntry({
        aiSummarizedAt: '2026-06-10T10:00:00.000Z',
        aiGitRefAtSummary: 'abc123',
        aiSummaryHash: 'hash-a',
      }),
    });
    expect(evaluateTrigger(input)).toBe(true);
  });

  it('priority 1: git-tracked and gitRef equals aiGitRefAtSummary returns false', () => {
    const input = baseInput({
      gitRef: 'abc123',
      stateEntry: baseStateEntry({
        aiSummarizedAt: '2026-06-10T10:00:00.000Z',
        aiGitRefAtSummary: 'abc123',
        aiSummaryHash: 'hash-a',
      }),
    });
    expect(evaluateTrigger(input)).toBe(false);
  });

  it('priority: git-ref equality returns false even when frontmatter.status === "final"', () => {
    const input = baseInput({
      gitRef: 'abc123',
      frontmatter: { status: 'final' },
      currentContentHash: 'hash-b', // content changed, but git ref wins
      stateEntry: baseStateEntry({
        aiSummarizedAt: '2026-06-10T10:00:00.000Z',
        aiGitRefAtSummary: 'abc123',
        aiSummaryHash: 'hash-a',
      }),
    });
    expect(evaluateTrigger(input)).toBe(false);
  });

  it('status:final unchanged content returns FALSE on second evaluation (Blocker-2 regression, AI-06)', () => {
    const input = baseInput({
      gitRef: null,
      frontmatter: { status: 'final' },
      currentContentHash: 'hash-a',
      stateEntry: baseStateEntry({
        aiSummarizedAt: '2026-06-10T10:00:00.000Z',
        aiGitRefAtSummary: null,
        aiSummaryHash: 'hash-a',
      }),
    });
    expect(evaluateTrigger(input)).toBe(false);
  });

  it('status:final changed content returns TRUE even though aiSummarizedAt is set', () => {
    const input = baseInput({
      gitRef: null,
      frontmatter: { status: 'final' },
      currentContentHash: 'hash-b',
      stateEntry: baseStateEntry({
        aiSummarizedAt: '2026-06-10T10:00:00.000Z',
        aiGitRefAtSummary: null,
        aiSummaryHash: 'hash-a',
      }),
    });
    expect(evaluateTrigger(input)).toBe(true);
  });

  it('draft:false changed content returns TRUE (same hash-gate as status:final)', () => {
    const input = baseInput({
      gitRef: null,
      frontmatter: { draft: false },
      currentContentHash: 'hash-b',
      stateEntry: baseStateEntry({
        aiSummarizedAt: '2026-06-10T10:00:00.000Z',
        aiGitRefAtSummary: null,
        aiSummaryHash: 'hash-a',
      }),
    });
    expect(evaluateTrigger(input)).toBe(true);
  });

  it('draft:false unchanged content returns FALSE (same hash-gate as status:final)', () => {
    const input = baseInput({
      gitRef: null,
      frontmatter: { draft: false },
      currentContentHash: 'hash-a',
      stateEntry: baseStateEntry({
        aiSummarizedAt: '2026-06-10T10:00:00.000Z',
        aiGitRefAtSummary: null,
        aiSummaryHash: 'hash-a',
      }),
    });
    expect(evaluateTrigger(input)).toBe(false);
  });

  it('idle>=10min with lineDelta<=20 returns false (Pitfall 3 - idle alone must not re-fire)', () => {
    const input = baseInput({
      gitRef: null,
      frontmatter: {},
      mtimeMs: NOW - TEN_MIN - 1000,
      currentLineCount: 110,
      stateEntry: baseStateEntry({
        aiSummarizedAt: '2026-06-10T10:00:00.000Z',
        aiGitRefAtSummary: null,
        aiSummaryHash: 'hash-a',
        aiLineCountAtSummary: 100,
      }),
    });
    expect(evaluateTrigger(input)).toBe(false);
  });

  it('idle>=10min with lineDelta>20 returns true (D-28 fallback)', () => {
    const input = baseInput({
      gitRef: null,
      frontmatter: {},
      mtimeMs: NOW - TEN_MIN - 1000,
      currentLineCount: 130,
      stateEntry: baseStateEntry({
        aiSummarizedAt: '2026-06-10T10:00:00.000Z',
        aiGitRefAtSummary: null,
        aiSummaryHash: 'hash-a',
        aiLineCountAtSummary: 100,
      }),
    });
    expect(evaluateTrigger(input)).toBe(true);
  });

  it('idle<10min returns false regardless of lineDelta', () => {
    const input = baseInput({
      gitRef: null,
      frontmatter: {},
      mtimeMs: NOW - 1000, // just edited
      currentLineCount: 200,
      stateEntry: baseStateEntry({
        aiSummarizedAt: '2026-06-10T10:00:00.000Z',
        aiGitRefAtSummary: null,
        aiSummaryHash: 'hash-a',
        aiLineCountAtSummary: 100,
      }),
    });
    expect(evaluateTrigger(input)).toBe(false);
  });
});
