/**
 * OllamaProvider — AiProvider implementation for a local Ollama server.
 *
 * AI-02: Local Ollama backend (default) — communicates via the configured base URL
 *        (typically http://localhost:11434), zero internet required.
 * D-01: Prompt templates and selection logic now live in ./prompts, shared with
 *       ClaudeProvider and OpenAiProvider.
 *
 * Source: https://docs.ollama.com/api/generate (official docs, fetched 2026-06-10)
 */

import type { AiProvider, AiSummaryResult } from './provider';
import { selectSummaryPrompt } from './prompts';

/**
 * Context window requested from Ollama for every summarize() call.
 *
 * MAX_PROMPT_BYTES (process.ts) caps the prompt at 24000 bytes (~6000 tokens).
 * Some models (e.g. qwen3.5) default to a 4096-token context, which leaves no
 * room for output once a near-MAX_PROMPT_BYTES prompt is loaded — Ollama then
 * returns an empty response with done_reason "length". 8192 covers the prompt
 * plus a multi-paragraph or multi-bullet response.
 */
const OLLAMA_NUM_CTX = 8192;

export class OllamaProvider implements AiProvider {
  constructor(private readonly baseUrl: string) {}

  /**
   * Check whether the Ollama server is reachable.
   *
   * Mirrors src/utils/git.ts getGitRef's swallow-everything pattern: any network
   * error, timeout, or non-2xx response collapses to `false`. Never throws.
   *
   * Returns false if:
   *   - The fetch rejects for any reason (connection refused, DNS failure, etc.)
   *   - The request exceeds the 3-second timeout (AbortSignal.timeout(3000))
   *   - The response status is not ok (non-2xx)
   */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Summarize redacted text using the given model via POST /api/generate.
   *
   * @throws Error if the response status is not ok (e.g. 404 for a missing model).
   *   This is intentional (Pitfall 1): a thrown error here means the request itself
   *   failed (bad model, malformed request), NOT that the server is unreachable —
   *   callers must catch and write an `error` audit entry, distinct from an
   *   isAvailable() === false health-check failure.
   */
  async summarize(redactedText: string, model: string): Promise<AiSummaryResult> {
    const prompt = selectSummaryPrompt(redactedText) + redactedText;
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        // Hybrid-thinking models (e.g. qwen3.5) otherwise spend the context
        // window on hidden reasoning instead of the summary itself.
        think: false,
        options: { num_ctx: OLLAMA_NUM_CTX },
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { response: string };

    return {
      summary: data.response.trim(),
      inputBytes: Buffer.byteLength(prompt, 'utf-8'),
      outputBytes: Buffer.byteLength(data.response, 'utf-8'),
    };
  }
}
