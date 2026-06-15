/**
 * AuditEntry discriminated union — the typed schema for all audit log entries.
 *
 * AUDIT-01: Append-only audit log with timestamp, op type, source name, file path, byte count.
 * AUDIT-03: Typed AuditEntry schema — no free-form strings.
 *
 * SECURITY INVARIANT: Never add fields that could capture file content or secret values.
 * All variants are reviewed against this constraint before merging.
 *
 * Prohibited field names in any variant: content, body, rawContent, fileContent, data, payload.
 */
export type AuditEntry =
  | {
      /** A markdown file was successfully copied from source to vault. */
      type: 'file_copied';
      /** ISO 8601 timestamp of when the operation completed. */
      timestamp: string;
      /** The source name from config that owns this file. */
      sourceName: string;
      /** Source-relative or absolute path of the source file. */
      sourceFile: string;
      /** Absolute destination path in the vault where the file was written. */
      destinationFile: string;
      /** Number of bytes in the copied file (for audit, not content inspection). */
      byteCount: number;
      /**
       * Distinguishes a first-time add from a re-sync update of an existing file.
       * Optional for backward compatibility with existing callers/tests.
       * Fixed enum only — no file content or path-derived secrets (SECURITY INVARIANT).
       */
      operation?: 'added' | 'updated';
    }
  | {
      /** A file was skipped during sync (unchanged, dry-run mode, or error). */
      type: 'file_skipped';
      /** ISO 8601 timestamp. */
      timestamp: string;
      /** The source name from config that owns this file. */
      sourceName: string;
      /** Source-relative or absolute path of the source file. */
      sourceFile: string;
      /** Why the file was skipped. */
      reason: 'unchanged' | 'dry_run' | 'error' | 'toml_frontmatter';
    }
  | {
      /** A full sync run has started. */
      type: 'sync_start';
      /** ISO 8601 timestamp of when the sync run started. */
      timestamp: string;
      /** Number of configured sources that will be scanned. */
      sourceCount: number;
    }
  | {
      /** A full sync run has completed (success or partial). */
      type: 'sync_complete';
      /** ISO 8601 timestamp of when the sync run completed. */
      timestamp: string;
      /** Number of configured sources that were scanned. */
      sourceCount: number;
      /** Number of files that were successfully copied to the vault. */
      copiedCount: number;
      /** Number of files that were skipped (unchanged, dry-run, or error). */
      skippedCount: number;
      /** Number of files that encountered an error during sync. */
      errorCount: number;
    }
  | {
      /**
       * An error occurred during sync for a specific file.
       * message must describe the error type only — never include file content or secret values.
       */
      type: 'error';
      /** ISO 8601 timestamp. */
      timestamp: string;
      /** The source name from config that owns this file. */
      sourceName: string;
      /** Source-relative or absolute path of the file that caused the error. */
      sourceFile: string;
      /** Human-readable error description. Must not contain file content or secret values. */
      message: string;
    }
  | {
      /**
       * A security-relevant configuration issue was detected at startup.
       * detail describes the issue location only — never includes secret values.
       */
      type: 'config_security_warning';
      /** ISO 8601 timestamp. */
      timestamp: string;
      /** Category of security warning. */
      warningType: 'world_readable' | 'hardcoded_key' | 'path_overlap';
      /** Human-readable detail about the warning. Must not contain secret values. */
      detail: string;
    }
  | {
      /**
       * An AI inference call was made. Logged after every inference, success or failure.
       * AUDIT-02: log timestamp, source name, provider, model, byte counts — never content.
       *
       * SECURITY INVARIANT: Prohibited field names in this variant: content, body, rawContent,
       * fileContent, data, payload. Only byte counts are logged — never actual content.
       * redactionTypes is explicitly reviewed and exempt from this list — it stores
       * pattern TYPE NAMES only (e.g. 'IPv4', 'PEM_BLOCK'), never matched values or content.
       */
      type: 'ai_inference';
      /** ISO 8601 timestamp when the inference call completed. */
      timestamp: string;
      /** source.name from config. */
      sourceName: string;
      /** 'ollama' | 'claude' | 'openai' — matches AiConfig.backend values. */
      provider: string;
      /** Model name from config (e.g. 'qwen3.5:9b', 'claude-3-haiku'). */
      model: string;
      /** Byte count of content passed to inference — never the content itself. */
      inputByteCount: number;
      /** Byte count of inference response — never the content itself. */
      outputByteCount: number;
      /**
       * Pattern type names matched by redact() during the pre-inference redaction pass
       * (REDACT-02), e.g. ['IPv4', 'PEM_BLOCK']. Stores redact().matchedTypes verbatim —
       * type names only, never matched values, content, or secrets. Required (pass []
       * when no patterns matched).
       */
      redactionTypes: string[];
    };
