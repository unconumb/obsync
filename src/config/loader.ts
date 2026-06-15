/**
 * loader.ts — Config loader with security checks, YAML parse, Zod validation, and path expansion.
 *
 * loadConfig() is the trust boundary for all user-provided configuration (D-21).
 * Security checks execute in strict order before any YAML parsing or engine operations.
 *
 * Security check order (D-21):
 *   1. Root check (SEC-07) — process.getuid() === 0 guard
 *   2. World-readable check (SEC-02) — file mode & 0o004
 *   3. Hardcoded API key scan (SEC-03) — raw bytes before YAML parse
 *   4. YAML parse
 *   5. Zod schema validation (CONF-01)
 *   6. Path expansion (~ → os.homedir())
 *   7. Path overlap validation (SEC-09)
 */

import * as fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { ObsyncConfigSchema } from './types';
import { checkPathOverlap, expandHome } from '../utils/paths';
import type { ObsyncConfig } from './types';

/**
 * ConfigLoadError — typed error thrown by loadConfig for all rejection paths.
 * CLI callers can catch and handle this specifically without catching generic Error.
 */
export class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigLoadError';
  }
}

/**
 * Regex patterns for detecting hardcoded API keys in raw config content.
 * SEC-03: Scanned against raw bytes before YAML parse to catch keys in comments.
 *
 * Patterns:
 *   - OpenAI-style: sk-[a-zA-Z0-9]{20,}
 *   - Google API key: AIza[0-9A-Za-z-_]{35}
 *   - Bearer token: Bearer\s+[a-zA-Z0-9._-]{20,}
 */
const HARDCODED_KEY_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,
  /AIza[0-9A-Za-z\-_]{35}/,
  /Bearer\s+[a-zA-Z0-9._\-]{20,}/,
];

/**
 * Format Zod validation errors as '[path.to.field]: message' lines.
 * Pitfall 7: Each issue gets its own line for easy user diagnosis.
 */
function formatZodErrors(issues: Array<{ path: (string | number)[]; message: string }>): string {
  return issues
    .map((issue) => {
      const fieldPath = issue.path.join('.');
      const label = fieldPath ? `[${fieldPath}]` : '[config]';
      return `${label}: ${issue.message}`;
    })
    .join('\n');
}

/**
 * loadConfig — load, validate, and return a typed ObsyncConfig.
 *
 * Throws ConfigLoadError for all rejection paths with descriptive messages.
 * Never includes raw YAML content in error messages (T-03-06).
 *
 * @param configPath - Path to obsync.yml (absolute or relative; resolved internally)
 * @returns Validated, path-expanded ObsyncConfig
 */
export function loadConfig(configPath: string): ObsyncConfig {
  // Step 1: Root check — refuse to run as root (SEC-07, D-24)
  // Optional chaining handles Windows where process.getuid is undefined.
  if (process.getuid?.() === 0) {
    throw new ConfigLoadError(
      'obsync must not run as root (SEC-07). Run as a non-root user.'
    );
  }

  // Step 2: Resolve configPath to absolute path
  const resolvedConfigPath = path.resolve(configPath);

  // Step 3: Read raw bytes as utf-8 string (synchronous — read once at startup)
  let rawYaml: string;
  try {
    rawYaml = fs.readFileSync(resolvedConfigPath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigLoadError(`Failed to read config at ${resolvedConfigPath}: ${msg}`);
  }

  // Step 4: World-readable check — reject if mode & 0o004 (SEC-02)
  // NOTE: Skipped on Windows — fs.statSync().mode does not represent POSIX permission bits on
  // Windows; all readable files have 0o004 set, so the check would always throw (Pitfall 6).
  // TODO(XPLAT-01): investigate Windows ACL-based permission enforcement.
  if (process.platform !== 'win32') {
    const stat = fs.statSync(resolvedConfigPath);
    if (stat.mode & 0o004) {
      throw new ConfigLoadError(
        `Config file ${resolvedConfigPath} is world-readable (SEC-02). ` +
        'Run: chmod 600 obsync.yml to restrict permissions.'
      );
    }
  }

  // Step 5: Hardcoded API key scan — check raw bytes before YAML parse (SEC-03)
  for (const pattern of HARDCODED_KEY_PATTERNS) {
    if (pattern.test(rawYaml)) {
      throw new ConfigLoadError(
        'Config file contains a hardcoded API key pattern (SEC-03). ' +
        'Move API keys to a .env file and load via environment variables.'
      );
    }
  }

  // Step 6: YAML parse — wrap in try/catch to emit position-aware error
  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigLoadError(`Config YAML parse error: ${msg}`);
  }

  // Step 7: Zod schema validation — format errors as [path]: message lines (CONF-01, Pitfall 7)
  const result = ObsyncConfigSchema.safeParse(parsed);
  if (!result.success) {
    const formatted = formatZodErrors(result.error.issues);
    throw new ConfigLoadError(`Config validation failed:\n${formatted}`);
  }

  const config = result.data;

  // Step 7b: docs_path-required warning (IN-01) — non-blocking. A `scan: 'docs'`
  // source without docs_path falls back to scanning source.path like `scattered`
  // (see getScanRoot in sync/scanner.ts); warn so the user notices the
  // misconfiguration without breaking config load.
  for (const source of config.sources) {
    if (source.scan === 'docs' && (source.docs_path == null || source.docs_path.trim() === '')) {
      process.stderr.write(
        `[obsync] warning: source "${source.name}" has scan: 'docs' but no docs_path set — ` +
        'it will scan the entire source path like scan: \'scattered\'\n',
      );
    }
  }

  // Step 8: Path expansion — replace leading ~ with os.homedir() then path.resolve
  const expandedConfig: ObsyncConfig = {
    ...config,
    vault: {
      ...config.vault,
      path: path.resolve(expandHome(config.vault.path)),
    },
    sources: config.sources.map((source) => ({
      ...source,
      path: path.resolve(expandHome(source.path)),
      // docs_path is relative to source.path — must not be resolved here
      // (scanner.ts joins source.path + docs_path at scan time)
    })),
  };

  // Step 9: Path overlap check — source path must not be inside vault path or vice versa (SEC-09)
  const overlapping = checkPathOverlap(expandedConfig.vault.path, expandedConfig.sources);
  if (overlapping !== null) {
    throw new ConfigLoadError(
      `Path overlap detected (SEC-09): source '${overlapping.name}' path '${overlapping.path}' ` +
      `overlaps with vault path '${expandedConfig.vault.path}'. ` +
      'Source paths must not be inside the vault, and vice versa.'
    );
  }

  // Step 10: Return validated, path-expanded config
  return expandedConfig;
}
