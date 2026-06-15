/**
 * ObsyncConfig — Zod schema definitions and inferred TypeScript types for obsync.yml.
 *
 * This file is the single source of truth for the config shape (CONF-01 through CONF-05).
 * The loader (Plan 03) imports the schemas for safeParse validation.
 * Downstream code imports the inferred types for type-safe config access.
 *
 * Design decisions:
 * - D-01: Top-level keys: vault, ai, sources, ignore, audit_log
 * - D-02: sources is a list of SourceSchema objects with all required fields
 * - D-03: scan is an explicit enum (scattered | docs), defaults to 'scattered'
 * - D-04: scan: docs sources have an optional docs_path field
 * - D-05: ai block is top-level; per-source ai_summary defaults to false
 * - D-06: No API key fields — keys come from env vars only (SEC-04)
 * - D-07: Zod safeParse used by loader for clear, line-level error messages
 * - AUDIT-04: audit_log is an optional config field; defaults to ~/.obsync/audit.log at runtime
 * - D-31: ai.callout_type is a vault-wide Obsidian callout type for AI summaries, defaults to 'ai-summary'
 * - D-35: ai.redact_patterns holds additive custom redaction regex patterns, defaults to []
 */

import { z } from 'zod';

/**
 * SourceSchema — validates a single source entry in the sources array.
 *
 * D-02: sources is a list of objects with fields: name, path, category, scan,
 *        ai_summary, ignore, labels.
 * D-03: scan defaults to 'scattered' if omitted.
 * D-04: docs_path is optional and only meaningful when scan is 'docs'.
 */
export const SourceSchema = z.object({
  /** Human-readable source identifier used in audit log and vault folder naming. */
  name: z.string().min(1).regex(/^[^/\\]+$/, 'Source name must not contain / or \\'),
  /** Absolute or ~ path to the source root directory. */
  path: z.string().min(1),
  /** Vault category folder (e.g. '01-projects', '02-areas', '03-resources'). */
  category: z.string().min(1),
  /**
   * File discovery mode.
   * - scattered: scan entire source tree for .md files
   * - docs: scan only the docs_path subdirectory
   */
  scan: z.enum(['scattered', 'docs']).default('scattered'),
  /** Subdirectory to scan when scan is 'docs'. Relative to path. */
  docs_path: z.string().optional(),
  /** Whether to generate AI summaries for files in this source. Default false. */
  ai_summary: z.boolean().default(false),
  /** Per-source ignore patterns (glob). Added to global ignore list. */
  ignore: z.array(z.string()).default([]),
  /**
   * AI-only exclusion patterns (D-74). Files matching these patterns still
   * sync/copy normally — they are excluded ONLY from AI summarization.
   * Does not modify the source's effective `ignore` list.
   */
  ai_ignore: z.array(z.string()).default([]),
  /** Labels applied to files from this source. Used for cross-source index pages in Phase 2. */
  labels: z.array(z.string()).default([]),
});

/**
 * AiConfigSchema — validates the optional top-level ai block.
 *
 * D-05: ai block holds connection config, not secrets.
 * D-06: API keys are loaded from env vars only; this schema deliberately has no key fields.
 * CONF-04: backend enum: ollama, claude, openai, none.
 * CONF-05: model in config only — no hardcoded default in engine logic.
 */
export const AiConfigSchema = z
  .object({
    /** AI inference backend. 'none' disables AI summarization entirely. */
    backend: z.enum(['ollama', 'claude', 'openai', 'none']),
    /** Model name passed to the backend (e.g. 'qwen3.5:9b', 'claude-3-haiku'). */
    model: z.string().optional(),
    /** Ollama server URL. Only used when backend is 'ollama'. */
    ollama_url: z.string().url().optional(),
    /** Obsidian callout type for AI summaries (D-31). Vault-wide, no per-source override in v1. */
    callout_type: z.string().default('ai-summary'),
    /**
     * Optional custom redaction regex patterns (D-35) — additive to the built-in
     * IPv4/IPv6/PEM/secret patterns, never replaces them.
     *
     * WR-04: each pattern must be a compilable regular expression. Without
     * this check, an invalid pattern (e.g. unbalanced '(') throws a
     * SyntaxError inside redact() at runtime, surfacing as a recurring
     * `error` audit entry on every AI-eligible file on every run instead of
     * a single config-load-time error.
     */
    redact_patterns: z
      .array(z.string())
      .default([])
      .refine(
        (patterns) =>
          patterns.every((p) => {
            try {
              new RegExp(p);
              return true;
            } catch {
              return false;
            }
          }),
        { message: 'ai.redact_patterns must contain valid regular expressions' },
      ),
  })
  /**
   * WR-03: require a non-empty `model` whenever AI summarization is enabled
   * (backend !== 'none'). Without this, `provider.summarize(text, '')` is
   * called for every eligible file and fails per-file, surfacing as a
   * recurring silent `error` audit entry on every run instead of a single
   * config-load-time error.
   */
  .refine((config) => config.backend === 'none' || (config.model !== undefined && config.model.trim().length > 0), {
    message: "ai.model is required and must be non-empty when ai.backend is not 'none'",
    path: ['model'],
  });

/**
 * ObsyncConfigSchema — validates the full obsync.yml config file.
 *
 * CONF-01: Zod schema validation with clear, line-level errors via safeParse.
 * CONF-02: sources supports multiple entries.
 * CONF-03: global ignore list at top level.
 * AUDIT-04: audit_log is an optional string path; defaults to ~/.obsync/audit.log at runtime.
 */
export const ObsyncConfigSchema = z.object({
  /** Obsidian vault configuration. */
  vault: z.object({
    /** Absolute or ~ path to the Obsidian vault root directory. */
    path: z.string().min(1),
  }),
  /**
   * Optional AI backend configuration.
   * Omit (or set backend: 'none') to disable AI summarization entirely.
   */
  ai: AiConfigSchema.optional(),
  /**
   * List of source directories to sync from.
   * At least one source is required for obsync to do anything useful.
   */
  sources: z.array(SourceSchema).min(1),
  /** Global ignore patterns (glob). Applied to all sources in addition to per-source patterns. */
  ignore: z.array(z.string()).default([]),
  /**
   * Optional path to the audit log file.
   * AUDIT-04: configurable audit log path.
   * Defaults to ~/.obsync/audit.log at runtime if not specified.
   */
  audit_log: z.string().optional(),
});

/**
 * Source — TypeScript type inferred from SourceSchema.
 * Single source of truth — always matches SourceSchema exactly.
 */
export type Source = z.infer<typeof SourceSchema>;

/**
 * AiConfig — TypeScript type inferred from AiConfigSchema.
 * Single source of truth — always matches AiConfigSchema exactly.
 */
export type AiConfig = z.infer<typeof AiConfigSchema>;

/**
 * ObsyncConfig — TypeScript type inferred from ObsyncConfigSchema.
 * Single source of truth — always matches ObsyncConfigSchema exactly.
 *
 * The loader (Plan 03) uses ObsyncConfigSchema.safeParse() to validate at runtime.
 * The sync engine (Plan 07) and CLI commands import this type for type-safe config access.
 */
export type ObsyncConfig = z.infer<typeof ObsyncConfigSchema>;
