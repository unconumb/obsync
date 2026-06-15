/**
 * AiProvider — the interface that all AI inference backends must satisfy.
 *
 * Mirrors the OutputAdapter dependency-inversion pattern (Rule 6 / ARCH-01-equivalent,
 * see src/adapters/interface.ts): the sync engine and AI queue depend on AiProvider,
 * never on OllamaProvider (or any future backend) directly.
 *
 * AI-02: Pluggable AI provider interface — swap backends via config, no code changes.
 * AI-03: AiProvider is the seam; createAiProvider is the only place that knows about
 *        concrete implementations.
 */

import type { AiConfig } from '../config/types';
import { OllamaProvider } from './ollama';
import { ClaudeProvider } from './claude';
import { OpenAiProvider } from './openai';

/**
 * AiSummaryResult — the result of a successful AiProvider.summarize() call.
 */
export interface AiSummaryResult {
  /** The generated summary text. */
  summary: string;
  /** Byte count of the (redacted) prompt sent to the backend — for ai_inference audit entries. */
  inputBytes: number;
  /** Byte count of the raw response from the backend — for ai_inference audit entries. */
  outputBytes: number;
}

/**
 * AiProvider — the interface all AI inference backends implement.
 *
 * ARCH-01-equivalent: The core engine depends on this interface, never on a
 * concrete provider class directly.
 */
export interface AiProvider {
  /**
   * Returns true if the backend is reachable and ready to serve requests.
   * MUST fail closed: any network/timeout error returns false, never throws.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Summarize redacted text using the given model.
   * @throws if the backend returns a non-success response (e.g. missing model).
   *   Callers are responsible for catching and writing an `error` audit entry —
   *   summarize() throwing does NOT mean the backend is unavailable (Pitfall 1).
   */
  summarize(redactedText: string, model: string): Promise<AiSummaryResult>;
}

/**
 * getMissingApiKeyReason — returns a backend-specific reason why createAiProvider would
 * return null due to a missing API key, or undefined if no key is required/missing.
 *
 * D-06: Used by both createAiProvider (fail-closed check) and engine.ts (D-07, to render a
 * backend-and-reason-aware error message when provider === null).
 */
export function getMissingApiKeyReason(aiConfig: AiConfig): string | undefined {
  if (aiConfig.backend === 'claude' && !process.env.ANTHROPIC_API_KEY) {
    return 'ANTHROPIC_API_KEY is not set';
  }
  if (aiConfig.backend === 'openai' && !process.env.OPENAI_API_KEY) {
    return 'OPENAI_API_KEY is not set';
  }
  return undefined;
}

/**
 * createAiProvider — instantiate the configured AiProvider, or null if AI is disabled.
 *
 * AI-02/AI-03: The only place in the codebase that imports a concrete provider class.
 * Returns null for backend 'none' (AI disabled) and for 'claude'/'openai' when the
 * corresponding API key env var is not set (D-06, fail closed — see
 * getMissingApiKeyReason).
 */
export function createAiProvider(aiConfig: AiConfig): AiProvider | null {
  switch (aiConfig.backend) {
    case 'ollama':
      return new OllamaProvider(aiConfig.ollama_url ?? 'http://localhost:11434');
    case 'claude': {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return null;
      return new ClaudeProvider(apiKey);
    }
    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return null;
      return new OpenAiProvider(apiKey);
    }
    case 'none':
    default:
      return null;
  }
}
