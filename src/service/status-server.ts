/**
 * status-server.ts — loopback-only HTTP server for the /status endpoint
 * (STATUS-01).
 *
 * - D-06: only started by `obsync watch` — never by `sync`/`status`.
 * - D-07: binds via `http.createServer().listen(0, '127.0.0.1')` — an
 *   ephemeral loopback port, no new dependency (Node `http` built-in only).
 * - D-08: the bound port is persisted into status.json's `port` field by
 *   the caller (Plan 03), not by this module.
 * - D-09 (by omission): `startStatusServer()` takes no port argument — no
 *   config-file port option is introduced.
 *
 * T-09-02 (Information Disclosure, mitigate): the server MUST bind
 * explicitly to `127.0.0.1` — never `0.0.0.0` or an omitted host, which
 * would make /status reachable from the local network.
 *
 * The `getPayload` closure is the dependency-injection seam (analog of
 * launchctl's ExecFn) — it is called FRESH inside the request handler on
 * every request, never cached (D-05: buildStatusPayload is the single
 * producer; this server must always serve its latest output).
 */

import * as http from 'http';
import type { StatusPayload } from '../status/types';

/** StatusServerHandle — returned by startStatusServer once bound. */
export interface StatusServerHandle {
  /** The ephemeral port the server is bound to on 127.0.0.1. */
  port: number;
  /** Close the server. Resolves once the underlying socket is closed. */
  close: () => Promise<void>;
}

/**
 * startStatusServer — bind a loopback-only HTTP server serving the
 * current status payload on GET /status.
 *
 * @param getPayload - Called fresh on every request to /status. Must
 *   return the current StatusPayload (no caching here — D-05).
 */
export function startStatusServer(getPayload: () => StatusPayload): Promise<StatusServerHandle> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getPayload()));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('status server: unexpected address() result'));
        return;
      }
      resolve({
        port: addr.port,
        close: () => new Promise((res2) => server.close(() => res2())),
      });
    });
  });
}
