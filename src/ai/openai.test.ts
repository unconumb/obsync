import { describe, it, expect, vi } from 'vitest';
import OpenAI from 'openai';
import { OpenAiProvider } from './openai';
import { selectSummaryPrompt } from './prompts';

function makeProvider(overrides: Partial<OpenAI> = {}): OpenAiProvider {
  const client = {
    models: { list: vi.fn() },
    chat: { completions: { create: vi.fn() } },
    ...overrides,
  } as unknown as OpenAI;
  return new OpenAiProvider('test-key', client);
}

describe('OpenAiProvider.isAvailable() — fails closed (Pitfall 1)', () => {
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

describe('OpenAiProvider.summarize() — Chat Completions with system-role message (D-02)', () => {
  it('sends a system message with selectSummaryPrompt(redactedText) followed by a user message, returning a trimmed summary', async () => {
    const createMock = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '  A short summary.  ' } }],
    });
    const provider = makeProvider({
      chat: { completions: { create: createMock } } as never,
    });

    const redactedText = 'redacted body text';
    const result = await provider.summarize(redactedText, 'gpt-4o-mini');

    expect(createMock).toHaveBeenCalledTimes(1);
    const requestBody = createMock.mock.calls[0][0];

    expect(requestBody.model).toBe('gpt-4o-mini');
    expect(requestBody.messages).toEqual([
      { role: 'system', content: selectSummaryPrompt(redactedText) },
      { role: 'user', content: redactedText },
    ]);
    expect(requestBody.messages[0].role).toBe('system');

    expect(result.summary).toBe('A short summary.');
    expect(result.inputBytes).toBe(
      Buffer.byteLength(selectSummaryPrompt(redactedText) + redactedText, 'utf-8'),
    );
    expect(result.outputBytes).toBe(Buffer.byteLength('  A short summary.  ', 'utf-8'));
  });

  it('returns an empty summary when no message content is present', async () => {
    const createMock = vi.fn().mockResolvedValue({
      choices: [{ message: { content: null } }],
    });
    const provider = makeProvider({
      chat: { completions: { create: createMock } } as never,
    });

    const result = await provider.summarize('redacted body text', 'gpt-4o-mini');

    expect(result.summary).toBe('');
    expect(result.outputBytes).toBe(0);
  });

  it('throws when chat.completions.create rejects (Pitfall 1 — no swallowed errors)', async () => {
    const createMock = vi.fn().mockRejectedValue(new Error('400 invalid model'));
    const provider = makeProvider({
      chat: { completions: { create: createMock } } as never,
    });

    await expect(provider.summarize('text', 'invalid-model')).rejects.toThrow();
  });
});
