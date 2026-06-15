import { describe, it, expect, vi, afterEach } from 'vitest';
import { processAiSummary } from './process';
import * as auditLogger from '../audit/logger';
import type { AiProvider } from './provider';
import type { OutputAdapter, VaultEntry } from '../adapters/interface';
import type { AiConfig } from '../config/types';
import { OllamaProvider } from './ollama';
import { ClaudeProvider } from './claude';
import { OpenAiProvider } from './openai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

/**
 * Unit tests for src/ai/process.ts processAiSummary.
 *
 * Covers:
 *   - full redact -> summarize -> inject -> write -> audit -> state pipeline
 *   - body-only inference (D-34): summarize() never sees frontmatter
 *   - redactionTypes populated from redact()'s matchedTypes (REDACT-02)
 *   - ai_inference audit entry has no body/content keys (SECURITY INVARIANT)
 *   - summarize() throw -> status 'error' + error audit entry, no re-throw (Pitfall 1)
 *   - over-threshold redacted text truncated to MAX_PROMPT_BYTES + '[TRUNCATED]' (Open Question 2)
 *   - stateUpdate.aiSummaryHash set from the threaded contentHash (not recomputed)
 */

function makeAiConfig(overrides: Partial<AiConfig> = {}): { ai: AiConfig } {
  return {
    ai: {
      backend: 'ollama',
      model: 'test-model',
      callout_type: 'ai-summary',
      redact_patterns: [],
      ...overrides,
    },
  };
}

function makeMockAdapter(): { adapter: OutputAdapter; writeEntryMock: ReturnType<typeof vi.fn> } {
  const writeEntryMock = vi.fn().mockResolvedValue(undefined);
  const adapter: OutputAdapter = {
    writeEntry: writeEntryMock as (entry: VaultEntry) => Promise<void>,
    deleteEntry: vi.fn().mockResolvedValue(undefined),
  };
  return { adapter, writeEntryMock };
}

function makeMockProvider(
  summaryImpl?: (text: string, model: string) => Promise<{ summary: string; inputBytes: number; outputBytes: number }>,
): { provider: AiProvider; summarizeMock: ReturnType<typeof vi.fn> } {
  const summarizeMock = vi.fn(
    summaryImpl ??
      (async () => ({
        summary: 'A concise two-sentence summary of the document.',
        inputBytes: 100,
        outputBytes: 50,
      })),
  );
  const provider: AiProvider = {
    isAvailable: vi.fn().mockResolvedValue(true),
    summarize: summarizeMock,
  };
  return { provider, summarizeMock };
}

const baseArgs = {
  destinationPath: '/vault/Projects/test-source/note.md',
  sourceName: 'test-source',
  sourceFile: '/source/test-source/note.md',
  gitRef: 'a'.repeat(40),
  contentHash: 'b'.repeat(64),
  auditLogPath: '/tmp/obsync-process-test-audit.log',
};

describe('processAiSummary', () => {
  it('runs redact -> summarize -> injectCallout -> writeEntry -> audit -> state in order, status "summarized"', async () => {
    const { adapter, writeEntryMock } = makeMockAdapter();
    const { provider, summarizeMock } = makeMockProvider();
    const appendSpy = vi.spyOn(auditLogger, 'appendAuditEntry').mockImplementation(() => {});

    const body = '# Note\n\nServer is at 10.0.0.5 for testing.\n';
    const mergedFrontmatter = { unique_frontmatter_key: 'do-not-leak-this-value' };

    const result = await processAiSummary({
      ...baseArgs,
      body,
      mergedFrontmatter,
      config: makeAiConfig(),
      provider,
      adapter,
    });

    expect(result.status).toBe('summarized');
    expect(result.destinationPath).toBe(baseArgs.destinationPath);

    // summarize() called with redacted text containing the placeholder, never raw IP
    expect(summarizeMock).toHaveBeenCalledTimes(1);
    const sentText = summarizeMock.mock.calls[0]?.[0] as string;
    expect(sentText).toContain('[REDACTED:IPv4]');
    expect(sentText).not.toContain('10.0.0.5');

    // summarize() never sees frontmatter (D-34)
    expect(sentText).not.toContain('unique_frontmatter_key');
    expect(sentText).not.toContain('do-not-leak-this-value');

    // writeEntry called with updated body containing the callout
    expect(writeEntryMock).toHaveBeenCalledTimes(1);
    const writtenEntry = writeEntryMock.mock.calls[0]?.[0] as VaultEntry;
    expect(writtenEntry.body.startsWith('> [!ai-summary]')).toBe(true);
    expect(writtenEntry.mergedFrontmatter).toBe(mergedFrontmatter);
    expect(writtenEntry.destinationPath).toBe(baseArgs.destinationPath);

    // ai_inference audit entry appended with redactionTypes containing 'IPv4'
    const aiInferenceCall = appendSpy.mock.calls.find((c) => (c[0] as { type: string }).type === 'ai_inference');
    expect(aiInferenceCall).toBeDefined();
    const entry = aiInferenceCall![0] as Record<string, unknown>;
    expect(entry['redactionTypes']).toEqual(['IPv4']);
    expect(typeof entry['inputByteCount']).toBe('number');
    expect(typeof entry['outputByteCount']).toBe('number');
    expect(entry['provider']).toBe('ollama');
    expect(entry['model']).toBe('test-model');
    expect(entry['sourceName']).toBe('test-source');

    // No content/body key in the serialized entry (SECURITY INVARIANT)
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('"body"');
    expect(serialized).not.toContain('"content"');
    expect(entry['body']).toBeUndefined();
    expect(entry['content']).toBeUndefined();

    // stateUpdate.aiSummaryHash set from the threaded contentHash, not recomputed
    expect(result.stateUpdate?.aiSummaryHash).toBe(baseArgs.contentHash);
    expect(typeof result.stateUpdate?.aiSummarizedAt).toBe('string');
    expect(result.stateUpdate?.aiGitRefAtSummary).toBe(baseArgs.gitRef);
    expect(result.stateUpdate?.aiLineCountAtSummary).toBe(body.split('\n').length);

    appendSpy.mockRestore();
  });

  it('returns redactionTypes: [] when nothing matched', async () => {
    const { adapter } = makeMockAdapter();
    const { provider } = makeMockProvider();
    const appendSpy = vi.spyOn(auditLogger, 'appendAuditEntry').mockImplementation(() => {});

    const body = '# Note\n\nNothing sensitive here.\n';

    await processAiSummary({
      ...baseArgs,
      body,
      mergedFrontmatter: {},
      config: makeAiConfig(),
      provider,
      adapter,
    });

    const aiInferenceCall = appendSpy.mock.calls.find((c) => (c[0] as { type: string }).type === 'ai_inference');
    const entry = aiInferenceCall![0] as Record<string, unknown>;
    expect(entry['redactionTypes']).toEqual([]);

    appendSpy.mockRestore();
  });

  it('on summarize() throw: returns status "error", appends an error audit entry, and does not re-throw', async () => {
    const { adapter, writeEntryMock } = makeMockAdapter();
    const { provider } = makeMockProvider(async () => {
      throw new Error('ollama: model not found');
    });
    const appendSpy = vi.spyOn(auditLogger, 'appendAuditEntry').mockImplementation(() => {});

    const body = '# Note\n\nSome content.\n';

    const result = await processAiSummary({
      ...baseArgs,
      body,
      mergedFrontmatter: {},
      config: makeAiConfig(),
      provider,
      adapter,
    });

    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('ollama: model not found');
    expect(result.stateUpdate).toBeUndefined();

    // No vault write on failure
    expect(writeEntryMock).not.toHaveBeenCalled();

    // error audit entry appended (not ai_inference)
    const errorCall = appendSpy.mock.calls.find((c) => (c[0] as { type: string }).type === 'error');
    expect(errorCall).toBeDefined();
    const entry = errorCall![0] as Record<string, unknown>;
    expect(entry['sourceName']).toBe('test-source');
    expect(entry['sourceFile']).toBe(baseArgs.sourceFile);
    expect(entry['message']).toContain('ollama: model not found');

    const aiInferenceCall = appendSpy.mock.calls.find((c) => (c[0] as { type: string }).type === 'ai_inference');
    expect(aiInferenceCall).toBeUndefined();

    appendSpy.mockRestore();
  });

  it('redacted text exceeding the byte threshold is truncated before being sent to the provider', async () => {
    const { adapter } = makeMockAdapter();
    const { provider, summarizeMock } = makeMockProvider();
    const appendSpy = vi.spyOn(auditLogger, 'appendAuditEntry').mockImplementation(() => {});

    // Build a body whose redacted form exceeds 24000 bytes (no redaction patterns
    // match plain repeated text, so redactedText === body).
    const longLine = 'x'.repeat(100) + '\n';
    const body = longLine.repeat(300); // ~30,300 bytes

    await processAiSummary({
      ...baseArgs,
      body,
      mergedFrontmatter: {},
      config: makeAiConfig(),
      provider,
      adapter,
    });

    expect(summarizeMock).toHaveBeenCalledTimes(1);
    const sentText = summarizeMock.mock.calls[0]?.[0] as string;
    expect(sentText.endsWith('[TRUNCATED]')).toBe(true);
    expect(Buffer.byteLength(sentText, 'utf-8')).toBeLessThanOrEqual(24000 + '\n[TRUNCATED]'.length);

    const aiInferenceCall = appendSpy.mock.calls.find((c) => (c[0] as { type: string }).type === 'ai_inference');
    const entry = aiInferenceCall![0] as Record<string, unknown>;
    expect(entry['inputByteCount']).toBe(Buffer.byteLength(sentText, 'utf-8'));

    appendSpy.mockRestore();
  });

  it('WR-01: truncation of multi-byte UTF-8 text does not split a character at the byte boundary', async () => {
    const { adapter } = makeMockAdapter();
    const { provider, summarizeMock } = makeMockProvider();
    const appendSpy = vi.spyOn(auditLogger, 'appendAuditEntry').mockImplementation(() => {});

    // '世' is a 3-byte UTF-8 character. 24000 (MAX_PROMPT_BYTES) is itself a
    // multiple of 3, so a body made purely of '世' would happen to cut cleanly
    // at byte 24000. Prepend a single ASCII byte to shift every subsequent
    // character's byte offsets by 1, so the byte-24000 cut point now falls
    // in the middle of a 3-byte character — exactly the case
    // truncateToUtf8ByteLimit must back up over.
    const body = 'x' + '世'.repeat(11000); // 1 + 33,000 = 33,001 bytes, well over the 24000 threshold

    await processAiSummary({
      ...baseArgs,
      body,
      mergedFrontmatter: {},
      config: makeAiConfig(),
      provider,
      adapter,
    });

    expect(summarizeMock).toHaveBeenCalledTimes(1);
    const sentText = summarizeMock.mock.calls[0]?.[0] as string;

    expect(sentText.endsWith('[TRUNCATED]')).toBe(true);
    expect(Buffer.byteLength(sentText, 'utf-8')).toBeLessThanOrEqual(24000 + '\n[TRUNCATED]'.length);

    // The truncated body (without the trailing marker) must decode cleanly —
    // no replacement character from a split multi-byte sequence.
    const withoutMarker = sentText.slice(0, sentText.length - '\n[TRUNCATED]'.length);
    expect(withoutMarker).not.toContain('�');

    appendSpy.mockRestore();
  });
});

/**
 * AI-13: cross-provider canary-string redaction contract test.
 *
 * Proves REDACT-01/02 + SECURITY INVARIANT hold identically across all three
 * AiProvider implementations (Ollama, Claude, OpenAI):
 *   (a) the canary string never appears in the captured payload sent to the provider
 *   (b) the ai_inference audit entry's redactionTypes includes the expected type
 *   (c) no field of any captured AuditEntry contains the raw canary string
 *
 * Each REAL provider is constructed with a mocked underlying transport (fetch spy for
 * Ollama, injected SDK client mock for Claude/OpenAI) — only the network/SDK boundary
 * is mocked, processAiSummary/redact/prompts run unmodified.
 */
describe('AI-13: cross-provider canary-string redaction contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Canary IPv4 address (matches the built-in 'IPv4' redact pattern, REDACT-01).
  const CANARY = '203.0.113.42';
  const body = `# Internal Notes\n\nThe staging server lives at ${CANARY} — do not share.\n`;

  it('Ollama: canary absent from sent payload and audit entries', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ response: 'summary' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { adapter } = makeMockAdapter();
    const appendSpy = vi.spyOn(auditLogger, 'appendAuditEntry').mockImplementation(() => {});

    const provider = new OllamaProvider('http://localhost:11434');

    const result = await processAiSummary({
      ...baseArgs,
      body,
      mergedFrontmatter: {},
      config: makeAiConfig({ backend: 'ollama' }),
      provider,
      adapter,
    });

    expect(result.status).toBe('summarized');

    // (a) canary absent from the captured sent payload
    expect(fetchSpy).toHaveBeenCalled();
    const generateCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith('/api/generate'));
    expect(generateCall).toBeDefined();
    const requestBody = JSON.parse(String(generateCall![1]?.body)) as { prompt: string };
    expect(requestBody.prompt).not.toContain(CANARY);
    expect(requestBody.prompt).toContain('[REDACTED:IPv4]');

    // (b) ai_inference audit entry's redactionTypes includes IPv4
    const aiInferenceCall = appendSpy.mock.calls.find((c) => (c[0] as { type: string }).type === 'ai_inference');
    expect(aiInferenceCall).toBeDefined();
    const entry = aiInferenceCall![0] as Record<string, unknown>;
    expect(entry['redactionTypes']).toContain('IPv4');

    // (c) no audit entry field contains the raw canary
    for (const call of appendSpy.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain(CANARY);
    }
  });

  it('Claude: canary absent from sent payload and audit entries', async () => {
    const { adapter } = makeMockAdapter();
    const appendSpy = vi.spyOn(auditLogger, 'appendAuditEntry').mockImplementation(() => {});

    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'summary' }],
    });
    const mockClient = {
      models: { list: vi.fn() },
      messages: { create },
    } as unknown as Anthropic;
    const provider = new ClaudeProvider('test-key', mockClient);

    const result = await processAiSummary({
      ...baseArgs,
      body,
      mergedFrontmatter: {},
      config: makeAiConfig({ backend: 'claude', model: 'claude-haiku-4-5' }),
      provider,
      adapter,
    });

    expect(result.status).toBe('summarized');

    // (a) canary absent from the captured sent payload (system + messages)
    expect(create).toHaveBeenCalledTimes(1);
    const callArgs = create.mock.calls[0]?.[0] as {
      system?: string;
      messages: Array<{ content: string }>;
    };
    const sentPayload = JSON.stringify(callArgs);
    expect(sentPayload).not.toContain(CANARY);
    expect(sentPayload).toContain('[REDACTED:IPv4]');

    // (b) ai_inference audit entry's redactionTypes includes IPv4
    const aiInferenceCall = appendSpy.mock.calls.find((c) => (c[0] as { type: string }).type === 'ai_inference');
    expect(aiInferenceCall).toBeDefined();
    const entry = aiInferenceCall![0] as Record<string, unknown>;
    expect(entry['redactionTypes']).toContain('IPv4');

    // (c) no audit entry field contains the raw canary
    for (const call of appendSpy.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain(CANARY);
    }
  });

  it('OpenAI: canary absent from sent payload and audit entries', async () => {
    const { adapter } = makeMockAdapter();
    const appendSpy = vi.spyOn(auditLogger, 'appendAuditEntry').mockImplementation(() => {});

    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'summary' } }],
    });
    const mockClient = {
      models: { list: vi.fn() },
      chat: { completions: { create } },
    } as unknown as OpenAI;
    const provider = new OpenAiProvider('test-key', mockClient);

    const result = await processAiSummary({
      ...baseArgs,
      body,
      mergedFrontmatter: {},
      config: makeAiConfig({ backend: 'openai', model: 'gpt-4o-mini' }),
      provider,
      adapter,
    });

    expect(result.status).toBe('summarized');

    // (a) canary absent from the captured sent payload (messages array)
    expect(create).toHaveBeenCalledTimes(1);
    const callArgs = create.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };
    const sentPayload = JSON.stringify(callArgs);
    expect(sentPayload).not.toContain(CANARY);
    expect(sentPayload).toContain('[REDACTED:IPv4]');

    // (b) ai_inference audit entry's redactionTypes includes IPv4
    const aiInferenceCall = appendSpy.mock.calls.find((c) => (c[0] as { type: string }).type === 'ai_inference');
    expect(aiInferenceCall).toBeDefined();
    const entry = aiInferenceCall![0] as Record<string, unknown>;
    expect(entry['redactionTypes']).toContain('IPv4');

    // (c) no audit entry field contains the raw canary
    for (const call of appendSpy.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain(CANARY);
    }
  });
});
