/**
 * OpenAiProvider — AiProvider implementation for the OpenAI Chat Completions API.
 *
 * AI-11: OpenAI adapter implementing AiProvider via the `openai` npm package,
 *        OPENAI_API_KEY env var, fail-closed if missing.
 * D-02:  Shared prompt instruction text (src/ai/prompts.ts) is delivered as a
 *        `role: 'system'` message — Chat Completions has no separate top-level
 *        `system` field.
 * D-03/D-04: isAvailable() fails closed (never throws) via client.models.list();
 *        a revoked/invalid API key is caught by engine.ts's existing run-level
 *        fail-closed path with zero changes.
 *
 * Source: https://github.com/openai/openai-node README + api.md (Chat Completions,
 *         Models resource), fetched 2026-06-13.
 */

import OpenAI from 'openai';
import type { AiProvider, AiSummaryResult } from './provider';
import { selectSummaryPrompt } from './prompts';

export class OpenAiProvider implements AiProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string, client?: OpenAI) {
    this.client = client ?? new OpenAI({ apiKey });
  }

  /**
   * Check whether the OpenAI API is reachable and the API key is valid.
   *
   * Mirrors OllamaProvider.isAvailable()'s fail-closed shape (D-03/D-04): any
   * error (network failure, timeout, 401 for an invalid/revoked key) collapses
   * to false. Never throws. The resolved value of models.list() is never
   * inspected — only resolve-vs-throw matters (Pitfall 2).
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.client.models.list({ signal: AbortSignal.timeout(3000) });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Summarize redacted text using the given model via the Chat Completions API.
   *
   * The shared instruction text (src/ai/prompts.ts, D-01) is sent as the first
   * `role: 'system'` message (D-02 hybrid delivery); `redactedText` is the
   * `role: 'user'` message that follows.
   *
   * Note (Pitfall 4): `role: 'system'` is used here for broad compatibility with
   * non-reasoning chat models (e.g. gpt-4o-mini, the D-05 example model). Some
   * reasoning-model-family configs may require `role: 'developer'` instead — this
   * is a config-time (model-choice) concern, not hand-rolled here (Rule 7).
   *
   * @throws OpenAI.APIError (or subclass) if the request fails (e.g. invalid
   *   model name, auth failure that slipped past isAvailable(), unsupported
   *   `system` role for the configured model). This is intentional (Pitfall 1):
   *   a thrown error here means the request itself failed, NOT that the backend
   *   is unreachable — callers (processAiSummary) catch and write an `error`
   *   audit entry without aborting the run.
   */
  async summarize(redactedText: string, model: string): Promise<AiSummaryResult> {
    const systemPrompt = selectSummaryPrompt(redactedText);

    const completion = await this.client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: redactedText },
      ],
    });

    const summaryText = completion.choices[0]?.message?.content ?? '';

    return {
      summary: summaryText.trim(),
      inputBytes: Buffer.byteLength(systemPrompt + redactedText, 'utf-8'),
      outputBytes: Buffer.byteLength(summaryText, 'utf-8'),
    };
  }
}
