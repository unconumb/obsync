import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AuditEntry } from './types';
import { expandHome } from '../utils/paths';

/**
 * Returns the absolute path to the audit log file.
 *
 * If configuredPath is provided, it is expanded (~ → homedir) and resolved.
 * Otherwise, the default path ~/.obsync/audit.log is returned.
 *
 * AUDIT-04: Audit log location is configurable.
 */
export function getAuditLogPath(configuredPath?: string): string {
  if (configuredPath != null && configuredPath.length > 0) {
    return path.resolve(expandHome(configuredPath));
  }
  return path.join(os.homedir(), '.obsync', 'audit.log');
}

/**
 * Append a single typed AuditEntry to the audit log as a JSON line.
 *
 * Guarantees:
 * - Creates the log directory if it does not exist (mkdirSync recursive).
 * - Appends a single JSON line terminated by '\n' — never overwrites existing entries.
 * - Uses appendFileSync (not writeFileSync) to enforce append-only semantics.
 *
 * AUDIT-01: Append-only log with timestamp, op type, source name, file path, byte count.
 * AUDIT-03: Typed AuditEntry schema — no free-form strings, no content fields.
 * T-04-01: AuditEntry type has no content fields; logger writes JSON.stringify of typed
 *          object only — information disclosure is prevented at the type level.
 */
export function appendAuditEntry(entry: AuditEntry, logPath?: string): void {
  const resolvedPath = getAuditLogPath(logPath);
  const logDir = path.dirname(resolvedPath);

  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(resolvedPath, JSON.stringify(entry) + '\n', 'utf-8');
}
