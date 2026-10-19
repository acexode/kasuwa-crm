import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBffHandler, type BffConfig } from './bff-forward';

/**
 * FRAMING (the T-0125 Windows gate's question). Every BFF answer must be one a
 * client can tell is finished: either no body, or a body whose length is
 * stated correctly or chunk-framed, so a keep-alive client never waits for a
 * socket timeout. The handler never states a length itself; these tests prove
 * it never forwards an upstream one either, and serve every path through a
 * real node:http server (writing the Response the way Next's node adapter
 * does: headers, then the body stream piped) to a raw client, each of which
 * must complete in well under a second.
 */

const TOKEN = 'ksw_s1_unit-not-a-real-token-AAAAAAAAAAAAAAAAAAAA';
let webOrigin = '';
let server: Server;

type Answer = () => Response;
let answer: Answer = () => new Response(null, { status: 204 });

function config(): BffConfig {
  return { apiOrigin: 'http://127.0.0.1:9', webOrigin, forwardStubIdentity: false, cookie: { insecure: false } };
}

const handle = createBffHandler(config, {
  now: () => new Date('2026-10-19T08:00:00.000Z'),
  fetch: async () => answer(),
});

async function serve(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
  const request = new Request(`${webOrigin}${incoming.url ?? '/'}`, {
    method: incoming.method ?? 'GET',
    headers,
    ...(hasBody ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
  } as RequestInit);
  const response = await handle(request);
  const lines: [string, string][] = [];
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') lines.push([name, value]);
  });
  outgoing.writeHead(response.status, [...lines.flat(), ...response.headers.getSetCookie().flatMap((line) => ['set-cookie', line])]);
  if (response.body === null || incoming.method === 'HEAD') {
    outgoing.end();
    return;
  }
  Readable.fromWeb(response.body as NodeReadableStream).pipe(outgoing);
}

beforeAll(async () => {
  server = createServer((incoming, outgoing) => {
    void serve(incoming, outgoing);
  });
  server.keepAliveTimeout = 30_000;
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  webOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

interface Received {
  status: number;
  headers: IncomingMessage['headers'];
  body: Buffer;
  ms: number;
}

/** A raw keep-alive request; resolves only when the client sees the end of the answer. */
function fetchRaw(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Received> {
  const started = Date.now();
  return new Promise((done, fail) => {
    const sent = httpRequest(
      { host: '127.0.0.1', port: new URL(webOrigin).port, method, path, headers: { connection: 'keep-alive', ...headers, ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }) } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => done({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks), ms: Date.now() - started }));
        response.on('error', fail);
      },
    );
    sent.setTimeout(3_000, () => sent.destroy(new Error(`${method} ${path} did not finish within 3 s`)));
    sent.on('error', fail);
    sent.end(body);
  });
}

function jsonAnswer(status: number, body: unknown, extra: Record<string, string> = {}): Answer {
  return () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });
}

const READ = { accept: 'application/json', cookie: `__Host-kasuwa_session=${TOKEN}` };
const BIG = { data: Array.from({ length: 200 }, (_, index) => ({ id: String(index), displayName: `Contact ${String(index)}` })) };

/** The answer is finished by its framing: a correct length, or chunks, never neither. */
function framed(received: Received, expectBody: boolean): void {
  const length = received.headers['content-length'];
  const chunked = (received.headers['transfer-encoding'] ?? '').includes('chunked');
  if (expectBody) expect(length !== undefined || chunked, 'neither a length nor chunked framing').toBe(true);
  if (length !== undefined) expect(Number(length)).toBe(received.body.byteLength);
  expect(received.ms, 'the client waited for the answer to end').toBeLessThan(1_000);
}

describe('every BFF answer is framed and finishes (T-0125 gate)', () => {
  it('a small JSON answer, with an upstream content-length and encoding that must not survive', async () => {
    answer = jsonAnswer(200, { id: 'u1' }, { 'content-length': '99999', 'content-encoding': 'br' });
    const received = await fetchRaw('GET', '/api/v1/auth/me', READ);
    expect(received.status).toBe(200);
    expect(received.headers['content-encoding']).toBeUndefined();
    framed(received, true);
    expect(JSON.parse(received.body.toString('utf8'))).toEqual({ id: 'u1' });
  });

  it('a gzipped JSON answer, length stated for the compressed bytes or chunked', async () => {
    answer = jsonAnswer(200, BIG, { 'content-length': '12' });
    const received = await fetchRaw('GET', '/api/v1/contacts', { ...READ, 'accept-encoding': 'gzip' });
    expect(received.headers['content-encoding']).toBe('gzip');
    framed(received, true);
    expect(JSON.parse(gunzipSync(received.body).toString('utf8'))).toEqual(BIG);
  });

  it('a streamed non-JSON answer (an export)', async () => {
    answer = () => new Response('id,name\n1,Ada\n', { status: 200, headers: { 'content-type': 'text/csv', 'content-length': '5000' } });
    const received = await fetchRaw('GET', '/api/v1/admin/audit/export', READ);
    framed(received, true);
    expect(received.body.toString('utf8')).toBe('id,name\n1,Ada\n');
  });

  it.each([400, 401, 403, 404, 409, 500, 503])('an upstream %s', async (status) => {
    answer = jsonAnswer(status, { statusCode: status, code: 'x' });
    const received = await fetchRaw('GET', '/api/v1/contacts', READ);
    expect(received.status).toBe(status);
    framed(received, true);
  });

  it('the BFF’s own refusals (404 navigation, 400 scope, 403 CSRF) and its 502', async () => {
    for (const [path, headers, status] of [
      ['/api/v1/auth/me', { 'sec-fetch-dest': 'document' }, 404],
      ['/api/v1/contacts', { 'x-kasuwa-scope': 'all' }, 400],
    ] as const) {
      const received = await fetchRaw('GET', path, headers);
      expect(received.status).toBe(status);
      framed(received, true);
    }
    const csrf = await fetchRaw('POST', '/api/v1/auth/sign-out', {});
    expect(csrf.status).toBe(403);
    framed(csrf, true);
    answer = jsonAnswer(200, { leaked: TOKEN });
    const refused = await fetchRaw('GET', '/api/v1/contacts', READ);
    expect(refused.status).toBe(502);
    framed(refused, true);
  });

  it('a 204 and a sign-out, with no body', async () => {
    answer = () => new Response(null, { status: 204, headers: { 'content-length': '10' } });
    const received = await fetchRaw('POST', '/api/v1/auth/sign-out', { origin: webOrigin, 'x-requested-with': 'kasuwa-web', cookie: `__Host-kasuwa_session=${TOKEN}` });
    expect(received.status).toBe(204);
    expect(received.body.byteLength).toBe(0);
    expect(received.ms).toBeLessThan(1_000);
  });

  it('a HEAD, with no body', async () => {
    answer = jsonAnswer(200, { id: 'u1' });
    const received = await fetchRaw('HEAD', '/api/v1/auth/me', READ);
    expect(received.status).toBe(200);
    expect(received.body.byteLength).toBe(0);
    expect(received.ms).toBeLessThan(1_000);
  });

  it('a token-route answer, captured and re-encoded', async () => {
    answer = jsonAnswer(200, {
      accessToken: TOKEN,
      tokenType: 'Bearer',
      expiresAt: '2026-10-19T20:00:00.000Z',
      user: { id: 'u1', tenantId: 't1', email: 'x@kasuwa.example', displayName: 'X', locale: 'en' },
    }, { 'content-length': '7' });
    const received = await fetchRaw('POST', '/api/v1/auth/mfa', { origin: webOrigin, 'x-requested-with': 'kasuwa-web', 'content-type': 'application/json' }, '{}');
    expect(received.status).toBe(200);
    framed(received, true);
    expect(received.body.toString('utf8')).not.toContain('ksw_s1_');
  });
});
