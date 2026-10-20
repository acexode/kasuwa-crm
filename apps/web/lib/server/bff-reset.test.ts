import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBffHandler, isConnectionReset, type BffConfig } from './bff-forward';

/**
 * THE KEEP-ALIVE RACE (the demo's intermittent 502s, after T-0125). The API
 * closes an idle pooled socket just as Node's fetch reuses it, and the request
 * dies with ECONNRESET before any answer. Here a real node:http upstream
 * resets the connection on its first request, and the BFF uses Node's real
 * fetch: a read must survive by retrying once, and a write must never be sent
 * twice.
 */

const WEB = 'http://127.0.0.1:3000';
let server: Server;
let apiOrigin = '';
let seen: string[] = [];
let resetsLeft = 0;

function upstream(request: IncomingMessage, response: ServerResponse): void {
  seen.push(`${request.method ?? ''} ${request.url ?? ''}`);
  if (resetsLeft > 0) {
    resetsLeft -= 1;
    request.socket.destroy();
    return;
  }
  request.resume();
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ ok: true }));
}

beforeAll(async () => {
  server = createServer(upstream);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  apiOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  seen = [];
  resetsLeft = 0;
});

function handler() {
  const config = (): BffConfig => ({ apiOrigin, webOrigin: WEB, forwardStubIdentity: false, cookie: { insecure: false } });
  return createBffHandler(config, { fetch: (input, init) => fetch(input, init), now: () => new Date() });
}

const COOKIE = { cookie: '__Host-kasuwa_session=ksw_s1_unit-not-a-real-token-AAAAAAAAAAAAAAAAAAAA' };
const WRITE = { ...COOKIE, origin: WEB, 'x-requested-with': 'kasuwa-web', 'content-type': 'application/json' };

describe('a reset pooled connection (the keep-alive race)', () => {
  it('a read is retried once and answers', async () => {
    resetsLeft = 1;
    const response = await handler()(new Request(`${WEB}/api/v1/auth/me`, { headers: COOKIE }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen).toEqual(['GET /api/v1/auth/me', 'GET /api/v1/auth/me']);
  });

  it('a HEAD is retried too', async () => {
    resetsLeft = 1;
    const response = await handler()(new Request(`${WEB}/api/v1/auth/me`, { method: 'HEAD', headers: COOKIE }));
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  it('a read is retried only once: a second reset is the 502', async () => {
    resetsLeft = 2;
    const response = await handler()(new Request(`${WEB}/api/v1/auth/me`, { headers: COOKIE }));
    expect(response.status).toBe(502);
    expect(seen).toHaveLength(2);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('a %s is never sent twice: it answers 502', async (method) => {
    resetsLeft = 1;
    const response = await handler()(
      new Request(`${WEB}/api/v1/contacts/x`, { method, headers: WRITE, ...(method === 'DELETE' ? {} : { body: '{}' }) }),
    );
    expect(response.status).toBe(502);
    expect(seen).toHaveLength(1);
  });

  it('knows a reset from a timeout or an abort', () => {
    expect(isConnectionReset(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe(true);
    expect(isConnectionReset(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }))).toBe(true);
    expect(isConnectionReset(new DOMException('The operation was aborted.', 'AbortError'))).toBe(false);
    expect(isConnectionReset(new DOMException('The operation timed out.', 'TimeoutError'))).toBe(false);
    expect(isConnectionReset(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe(false);
  });
});
