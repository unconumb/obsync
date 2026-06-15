import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAiProvider, getMissingApiKeyReason } from './provider';
import { OllamaProvider } from './ollama';
import { ClaudeProvider } from './claude';
import { OpenAiProvider } from './openai';
import type { AiConfig } from '../config/types';

describe('createAiProvider — factory (AI-02/AI-03)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns an OllamaProvider instance for backend "ollama"', () => {
    const config: AiConfig = {
      backend: 'ollama',
      model: 'qwen3.5:9b',
      ollama_url: 'http://localhost:11434',
      callout_type: 'ai-summary',
      redact_patterns: [],
    };

    const provider = createAiProvider(config);

    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  it('returns null for backend "none"', () => {
    const config: AiConfig = {
      backend: 'none',
      callout_type: 'ai-summary',
      redact_patterns: [],
    };

    expect(createAiProvider(config)).toBeNull();
  });

  it('returns a ClaudeProvider instance for backend "claude" when ANTHROPIC_API_KEY is set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const config: AiConfig = {
      backend: 'claude',
      model: 'claude-haiku-4-5',
      callout_type: 'ai-summary',
      redact_patterns: [],
    };

    expect(createAiProvider(config)).toBeInstanceOf(ClaudeProvider);
  });

  it('returns null for backend "claude" when ANTHROPIC_API_KEY is absent', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const config: AiConfig = {
      backend: 'claude',
      callout_type: 'ai-summary',
      redact_patterns: [],
    };

    expect(createAiProvider(config)).toBeNull();
  });

  it('returns an OpenAiProvider instance for backend "openai" when OPENAI_API_KEY is set', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const config: AiConfig = {
      backend: 'openai',
      model: 'gpt-4o-mini',
      callout_type: 'ai-summary',
      redact_patterns: [],
    };

    expect(createAiProvider(config)).toBeInstanceOf(OpenAiProvider);
  });

  it('returns null for backend "openai" when OPENAI_API_KEY is absent', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const config: AiConfig = {
      backend: 'openai',
      callout_type: 'ai-summary',
      redact_patterns: [],
    };

    expect(createAiProvider(config)).toBeNull();
  });

  it('defaults ollama_url when not provided in config', () => {
    const config: AiConfig = {
      backend: 'ollama',
      callout_type: 'ai-summary',
      redact_patterns: [],
    };

    const provider = createAiProvider(config);

    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  it('AI-12: returns an OllamaProvider for the default backend with no API key env vars set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    const config: AiConfig = {
      backend: 'ollama',
      callout_type: 'ai-summary',
      redact_patterns: [],
    };

    expect(createAiProvider(config)).toBeInstanceOf(OllamaProvider);
  });
});

describe('getMissingApiKeyReason (D-06)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the ANTHROPIC_API_KEY message when backend is claude and key is unset', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(
      getMissingApiKeyReason({ backend: 'claude', callout_type: 'ai-summary', redact_patterns: [] }),
    ).toBe('ANTHROPIC_API_KEY is not set');
  });

  it('returns the OPENAI_API_KEY message when backend is openai and key is unset', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(
      getMissingApiKeyReason({ backend: 'openai', callout_type: 'ai-summary', redact_patterns: [] }),
    ).toBe('OPENAI_API_KEY is not set');
  });

  it('returns undefined for backend "ollama" regardless of env (AI-12)', () => {
    expect(
      getMissingApiKeyReason({ backend: 'ollama', callout_type: 'ai-summary', redact_patterns: [] }),
    ).toBeUndefined();
  });

  it('returns undefined for backend "none" regardless of env', () => {
    expect(
      getMissingApiKeyReason({ backend: 'none', callout_type: 'ai-summary', redact_patterns: [] }),
    ).toBeUndefined();
  });
});
