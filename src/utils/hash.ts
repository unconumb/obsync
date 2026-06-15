import * as crypto from 'crypto';

/**
 * Compute the SHA-256 hex digest of the given content.
 *
 * Accepts both a Buffer (for binary reads) and a string (for text content).
 * Always returns a 64-character lowercase hex string.
 *
 * Used by the differ (Plan 05) and the sync engine (Plan 07) to detect file
 * changes since last sync without reading stored content — only the hash is
 * retained, never the raw source bytes (SEC-07).
 */
export function sha256(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
