import { describe, it, expect, vi, afterEach } from 'vitest';
import { OllamaProvider } from './ollama';

describe('OllamaProvider.isAvailable() — fails closed (Pitfall 1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when fetch to /api/tags resolves res.ok', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }) as unknown as Response,
    );

    const provider = new OllamaProvider('http://localhost:11434');

    expect(await provider.isAvailable()).toBe(true);
  });

  it('returns false (never throws) when fetch rejects', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('connection refused'));

    const provider = new OllamaProvider('http://localhost:11434');

    await expect(provider.isAvailable()).resolves.toBe(false);
  });

  it('returns false when fetch resolves with res.ok === false', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 500 }) as unknown as Response,
    );

    const provider = new OllamaProvider('http://localhost:11434');

    expect(await provider.isAvailable()).toBe(false);
  });
});

describe('OllamaProvider.summarize() — POST /api/generate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to ${baseUrl}/api/generate with { model, prompt, stream: false } and returns trimmed summary', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ response: '  A short summary.  ' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response,
    );

    const provider = new OllamaProvider('http://localhost:11434');
    const result = await provider.summarize('redacted body text', 'qwen3.5:9b');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:11434/api/generate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );

    const callArgs = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(callArgs.body as string) as {
      model: string;
      prompt: string;
      stream: boolean;
      think: boolean;
      options: { num_ctx: number };
    };
    expect(body.model).toBe('qwen3.5:9b');
    expect(body.stream).toBe(false);
    expect(body.prompt).toContain('redacted body text');

    expect(result.summary).toBe('A short summary.');
    expect(result.inputBytes).toBe(Buffer.byteLength(body.prompt, 'utf-8'));
    expect(result.outputBytes).toBe(Buffer.byteLength('  A short summary.  ', 'utf-8'));
  });

  it('disables thinking mode and requests a context window large enough for MAX_PROMPT_BYTES', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ response: 'summary' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response,
    );

    const provider = new OllamaProvider('http://localhost:11434');
    await provider.summarize('redacted body text', 'qwen3.5:9b');

    const callArgs = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(callArgs.body as string) as {
      think: boolean;
      options: { num_ctx: number };
    };

    // Hybrid-thinking models (e.g. qwen3.5) otherwise spend the whole context
    // window on hidden reasoning and return an empty response on long prompts.
    expect(body.think).toBe(false);
    // MAX_PROMPT_BYTES (24000 bytes, ~6000 tokens) plus room for the response
    // exceeds Ollama's default num_ctx (4096) for some models — request 8192.
    expect(body.options.num_ctx).toBe(8192);
  });

  it('throws when res.ok is false (e.g. 404 missing model)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('not found', { status: 404, statusText: 'Not Found' }) as unknown as Response,
    );

    const provider = new OllamaProvider('http://localhost:11434');

    await expect(provider.summarize('text', 'missing-model')).rejects.toThrow();
  });
});

describe('OllamaProvider.summarize() — adaptive prompt by doc length (D-32 revised)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function promptFor(redactedText: string): Promise<string> {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ response: 'summary' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response,
    );

    const provider = new OllamaProvider('http://localhost:11434');
    await provider.summarize(redactedText, 'qwen3:latest');

    const callArgs = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(callArgs.body as string) as { prompt: string };
    return body.prompt;
  }

  it('uses the short 2-4 sentence prompt for short documents', async () => {
    const prompt = await promptFor('A short doc.');

    expect(prompt).toContain('2-4 sentences');
    expect(prompt).not.toContain('bullet');
  });

  it('uses a bullet-point prompt for long, multi-section documents', async () => {
    const longDoc = '## Section\n\nSome content.\n\n'.repeat(200);
    const prompt = await promptFor(longDoc);

    expect(prompt).toContain('bullet');
    expect(prompt).not.toContain('2-4 sentences');
    expect(prompt).toContain(longDoc);
  });
});
