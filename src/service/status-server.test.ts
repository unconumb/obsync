import { describe, it, expect, afterEach } from 'vitest';
import { startStatusServer } from './status-server';
import type { StatusServerHandle } from './status-server';
import type { StatusPayload } from '../status/types';

function makePayload(overrides: Partial<StatusPayload> = {}): StatusPayload {
  return {
    sync: {
      state: 'idle',
      lastSyncAt: null,
      counts: { added: 0, updated: 0, moved: 0, removed: 0, unchanged: 0, errors: 0 },
      errors: [],
    },
    ai: { backend: 'none', queueDepth: 0 },
    sources: [],
    vault: { path: '/tmp/vault' },
    ...overrides,
  };
}

describe('startStatusServer', () => {
  let handle: StatusServerHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it('resolves to a handle with a numeric port > 0', async () => {
    handle = await startStatusServer(() => makePayload());
    expect(typeof handle.port).toBe('number');
    expect(handle.port).toBeGreaterThan(0);
  });

  it('GET /status returns 200, application/json, and a body matching getPayload()', async () => {
    const payload = makePayload({ ai: { backend: 'ollama', queueDepth: 2 } });
    handle = await startStatusServer(() => payload);

    const res = await fetch(`http://127.0.0.1:${handle.port}/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = await res.json();
    expect(body).toEqual(payload);
  });

  it('calls getPayload() fresh per request — mutation between requests is reflected', async () => {
    let queueDepth = 1;
    handle = await startStatusServer(() => makePayload({ ai: { backend: 'ollama', queueDepth } }));

    const res1 = await fetch(`http://127.0.0.1:${handle.port}/status`);
    const body1 = (await res1.json()) as StatusPayload;
    expect(body1.ai.queueDepth).toBe(1);

    queueDepth = 5;

    const res2 = await fetch(`http://127.0.0.1:${handle.port}/status`);
    const body2 = (await res2.json()) as StatusPayload;
    expect(body2.ai.queueDepth).toBe(5);
  });

  it('GET to any other path returns 404 with a JSON body', async () => {
    handle = await startStatusServer(() => makePayload());

    const res = await fetch(`http://127.0.0.1:${handle.port}/other`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not found' });
  });

  it('handle.close() resolves and the port stops accepting connections afterward', async () => {
    handle = await startStatusServer(() => makePayload());
    const port = handle.port;

    await handle.close();
    handle = undefined;

    await expect(fetch(`http://127.0.0.1:${port}/status`)).rejects.toThrow();
  });
});
