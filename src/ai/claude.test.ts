import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeProvider } from './claude';
import { selectSummaryPrompt } from './prompts';

function makeProvider(overrides: Partial<Anthropic> = {}): ClaudeProvider {
  const client = {
    models: { list: vi.fn() },
    messages: { create: vi.fn() },
    ...overrides,
  } as unknown as Anthropic;
  return new ClaudeProvider('test-key', client);
}

describe('ClaudeProvider.isAvailable() — fails closed (Pitfall 1)', () => {
  it('returns true when models.list resolves', async () => {
    const provider = makeProvider({
      models: { list: vi.fn().mockResolvedValue({ data: [] }) } as never,
    });

    expect(await provider.isAvailable()).toBe(true);
  });

  it('returns false (never throws) when models.list rejects', async () => {
    const provider = makeProvider({
      models: { list: vi.fn().mockRejectedValue(new Error('401 unauthorized')) } as never,
    });

    await expect(provider.isAvailable()).resolves.toBe(false);
  });
});

describe('ClaudeProvider.summarize() — Messages API with system parameter (D-02)', () => {
  it('passes system = selectSummaryPrompt(redactedText) and a single user message, returning a trimmed summary', async () => {
    const createMock = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '  A short summary.  ' }],
    });
    const provider = makeProvider({
      messages: { create: createMock } as never,
    });

    const redactedText = 'redacted body text';
    const result = await provider.summarize(redactedText, 'claude-haiku-4-5');

    expect(createMock).toHaveBeenCalledTimes(1);
    const requestBody = createMock.mock.calls[0][0];

    expect(requestBody.model).toBe('claude-haiku-4-5');
    expect(requestBody.max_tokens).toBe(1024);
    expect(requestBody.system).toBe(selectSummaryPrompt(redactedText));
    expect(requestBody.messages).toEqual([{ role: 'user', content: redactedText }]);

    expect(result.summary).toBe('A short summary.');
    expect(result.inputBytes).toBe(
      Buffer.byteLength(selectSummaryPrompt(redactedText) + redactedText, 'utf-8'),
    );
    expect(result.outputBytes).toBe(Buffer.byteLength('  A short summary.  ', 'utf-8'));
  });

  it('returns an empty summary when no text content block is present', async () => {
    const createMock = vi.fn().mockResolvedValue({
      content: [{ type: 'tool_use', id: 'x', name: 'noop', input: {} }],
    });
    const provider = makeProvider({
      messages: { create: createMock } as never,
    });

    const result = await provider.summarize('redacted body text', 'claude-haiku-4-5');

    expect(result.summary).toBe('');
    expect(result.outputBytes).toBe(0);
  });

  it('throws when messages.create rejects (Pitfall 1 — no swallowed errors)', async () => {
    const createMock = vi.fn().mockRejectedValue(new Error('400 invalid model'));
    const provider = makeProvider({
      messages: { create: createMock } as never,
    });

    await expect(provider.summarize('text', 'invalid-model')).rejects.toThrow();
  });
});
