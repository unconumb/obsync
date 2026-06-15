/**
 * ClaudeProvider — AiProvider implementation for the Anthropic Claude API.
 *
 * AI-10: Claude adapter implementing AiProvider via @anthropic-ai/sdk,
 *        ANTHROPIC_API_KEY env var, fail-closed if missing.
 * D-02:  Shared prompt instruction text (src/ai/prompts.ts) is delivered via
 *        the Messages API's top-level `system` parameter.
 * D-03/D-04: isAvailable() fails closed (never throws) via client.models.list();
 *        a revoked/invalid API key is caught by engine.ts's existing run-level
 *        fail-closed path with zero changes.
 *
 * Source: https://platform.claude.com/docs/en/api/messages (Messages API reference,
 *         fetched 2026-06-13); https://github.com/anthropics/anthropic-sdk-typescript
 *         api.md (Models resource).
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AiProvider, AiSummaryResult } from './provider';
import { selectSummaryPrompt } from './prompts';

export class ClaudeProvider implements AiProvider {
  private readonly client: Anthropic;

  constructor(apiKey: string, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey });
  }

  /**
   * Check whether the Anthropic API is reachable and the API key is valid.
   *
   * Mirrors OllamaProvider.isAvailable()'s fail-closed shape (D-03/D-04): any
   * error (network failure, timeout, 401 for an invalid/revoked key) collapses
   * to false. Never throws. The resolved value of models.list() is never
   * inspected — only resolve-vs-throw matters (Pitfall 2).
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.client.models.list({ limit: 1 }, { signal: AbortSignal.timeout(3000) });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Summarize redacted text using the given model via the Messages API.
   *
   * The shared instruction text (src/ai/prompts.ts, D-01) is passed via the
   * top-level `system` parameter (D-02); `redactedText` is the sole user
   * message content.
   *
   * @throws Anthropic.APIError (or subclass) if the request fails (e.g. invalid
   *   model name, auth failure that slipped past isAvailable()). This is
   *   intentional (Pitfall 1): a thrown error here means the request itself
   *   failed, NOT that the backend is unreachable — callers (processAiSummary)
   *   catch and write an `error` audit entry without aborting the run.
   */
  async summarize(redactedText: string, model: string): Promise<AiSummaryResult> {
    const systemPrompt = selectSummaryPrompt(redactedText);

    const message = await this.client.messages.create({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: redactedText }],
    });

    const textBlock = message.content.find(
      (block): block is Anthropic.TextBlock => block.type === 'text',
    );
    const summaryText = textBlock?.text ?? '';

    return {
      summary: summaryText.trim(),
      inputBytes: Buffer.byteLength(systemPrompt + redactedText, 'utf-8'),
      outputBytes: Buffer.byteLength(summaryText, 'utf-8'),
    };
  }
}
