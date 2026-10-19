import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { NOT_FOUND_BODY, SCOPE_HEADER_REJECTED_BODY } from '@kasuwa/config/session';
import { MAX_UPSTREAM_JSON_BYTES, carriesSessionToken, createBffHandler, upstreamTarget, type BffConfig } from './bff-forward';

/**
 * The BFF against a fake upstream (ADR-0019 points 1 to 5 and 9). Invented
 * values only: the tokens are shaped like API tokens and valid nowhere.
 */

const WEB = 'http://127.0.0.1:3000';
const API = 'http://127.0.0.1:3001';
const TOKEN = 'ksw_s1_unit-not-a-real-token-AAAAAAAAAAAAAAAAAAAA';
const OLD = 'ksw_s1_unit-not-a-real-token-OOOOOOOOOOOOOOOOOOOO';
const NOW = new Date('2026-10-19T08:00:00.000Z');
const EXPIRES = '2026-10-19T20:00:00.000Z';

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

function config(overrides: Partial<BffConfig> = {}): BffConfig {
  return { apiOrigin: API, webOrigin: WEB, forwardStubIdentity: false, cookie: { insecure: false }, ...overrides };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

function harness(answer: (sent: Sent) => Response | Promise<Response> = () => json(200, { ok: true }), overrides: Partial<BffConfig> = {}) {
  const sent: Sent[] = [];
  const handle = createBffHandler(() => config(overrides), {
    now: () => NOW,
    fetch: async (input, init) => {
      const body = init?.body;
      const entry: Sent = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: body === undefined || body === null ? undefined : new TextDecoder().decode(body as Uint8Array),
      };
      sent.push(entry);
      return answer(entry);
    },
  });
  return { handle, sent };
}

function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('content-length', String(Buffer.byteLength(init.body)));
  return new Request(`${WEB}${path}`, { method: init.method ?? 'GET', headers, ...(init.body === undefined ? {} : { body: init.body }) });
}

const WRITE = { origin: WEB, 'x-requested-with': 'kasuwa-web', 'sec-fetch-site': 'same-origin' };
const JSON_WRITE = { ...WRITE, 'content-type': 'application/json' };
const cookie = (token: string) => `__Host-kasuwa_session=${token}`;

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

describe('every answer (I14)', () => {
  it('is no-store, nosniff and default-src none, whatever the API sent', async () => {
    const { handle } = harness(() => json(200, { ok: true }, { 'cache-control': 'public, max-age=600' }));
    for (const response of [
      await handle(request('/api/v1/contacts', { headers: { cookie: cookie(TOKEN) } })),
      await handle(request('/api/v1/contacts', { headers: { 'x-kasuwa-scope': 'all' } })),
      await handle(request('/api/v1/auth/sign-out', { method: 'POST' })),
      await handle(request('/api/v1/contacts', { headers: { 'sec-fetch-dest': 'document' } })),
    ]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
    }
  });
});

describe('the request it sends (point 1)', () => {
  it('turns the cookie into a Bearer token and sends only allowlisted headers', async () => {
    const { handle, sent } = harness();
    await handle(
      request('/api/v1/contacts?q=Ada', {
        headers: {
          cookie: `${cookie(TOKEN)}; kasuwa_lite=1`,
          accept: 'application/json',
          'accept-language': 'ha',
          authorization: 'Bearer ksw_s1_unit-browser-supplied',
          'x-kasuwa-tenant-id': '00000000-0000-4000-8000-000000000001',
          'x-kasuwa-user-id': '00000000-0000-4000-8000-000000000002',
          'x-kasuwa-feature-flags': 'admin_live_api',
          host: 'evil.example',
          'x-forwarded-host': 'evil.example',
          forwarded: 'host=evil.example',
          'x-unknown': '1',
        },
      }),
    );
    expect(sent).toHaveLength(1);
    const [first] = sent;
    expect(first?.url).toBe(`${API}/api/v1/contacts?q=Ada`);
    expect(first?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect([...(first?.headers.keys() ?? [])].sort()).toEqual(['accept', 'accept-language', 'authorization']);
  });

  it('sends no credential at all without a cookie: the browser Authorization header is dropped', async () => {
    const { handle, sent } = harness(() => json(401, { code: 'not_authenticated' }));
    await handle(request('/api/v1/auth/me', { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(sent[0]?.headers.has('authorization')).toBe(false);
  });

  it('forwards stub identity only in a stub-mode web process (point 7)', async () => {
    const stub = { 'x-kasuwa-tenant-id': 't', 'x-kasuwa-user-id': 'u' };
    const jwt = harness();
    await jwt.handle(request('/api/v1/auth/me', { headers: stub }));
    expect(jwt.sent[0]?.headers.has('x-kasuwa-tenant-id')).toBe(false);
    expect(jwt.sent[0]?.headers.has('x-kasuwa-user-id')).toBe(false);
    const stubMode = harness(undefined, { forwardStubIdentity: true });
    await stubMode.handle(request('/api/v1/auth/me', { headers: stub }));
    expect(stubMode.sent[0]?.headers.get('x-kasuwa-tenant-id')).toBe('t');
    expect(stubMode.sent[0]?.headers.get('x-kasuwa-user-id')).toBe('u');
  });

  it('passes the client address chain on verbatim, so two clients reach two throttle keys (point 9)', async () => {
    const { handle, sent } = harness();
    await handle(request('/api/v1/auth/sign-in', { method: 'POST', headers: { ...JSON_WRITE, 'x-forwarded-for': '198.51.100.7' }, body: '{}' }));
    await handle(request('/api/v1/auth/sign-in', { method: 'POST', headers: { ...JSON_WRITE, 'x-forwarded-for': '203.0.113.9, 10.0.0.2' }, body: '{}' }));
    expect(sent.map((entry) => entry.headers.get('x-forwarded-for'))).toEqual(['198.51.100.7', '203.0.113.9, 10.0.0.2']);
  });

  it('sends no Bearer token to the pre-session routes, even with a cookie', async () => {
    const { handle, sent } = harness(() => json(200, { challengeId: 'c' }));
    await handle(request('/api/v1/auth/sign-in', { method: 'POST', headers: { ...JSON_WRITE, cookie: cookie(TOKEN) }, body: '{}' }));
    await handle(request('/api/v1/AUTH/Sign-In', { method: 'POST', headers: { ...JSON_WRITE, cookie: cookie(TOKEN) }, body: '{}' }));
    expect(sent.every((entry) => !entry.headers.has('authorization'))).toBe(true);
  });

  it('forwards the body it was sent', async () => {
    const { handle, sent } = harness();
    await handle(request('/api/v1/contacts', { method: 'POST', headers: { ...JSON_WRITE, cookie: cookie(TOKEN) }, body: '{"displayName":"Ada"}' }));
    expect(sent[0]?.body).toBe('{"displayName":"Ada"}');
    expect(sent[0]?.headers.get('content-type')).toBe('application/json');
  });
});

describe('refusals that never reach the API', () => {
  it('answers a scope header with the API 400, with or without a cookie, unechoed (I12)', async () => {
    const { handle, sent } = harness();
    for (const name of ['x-kasuwa-programme-ids', 'x-kasuwa-programme-id', 'x-kasuwa-scope']) {
      const response = await handle(request('/api/v1/contacts', { headers: { [name]: 'MARKER-scope', cookie: cookie(TOKEN) } }));
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual(SCOPE_HEADER_REJECTED_BODY);
      expect(text).not.toContain('MARKER');
    }
    expect(sent).toHaveLength(0);
  });

  it('answers CSRF failures with 403 csrf_rejected and leaves the cookie alone (I4)', async () => {
    const { handle, sent } = harness();
    for (const headers of [{}, { ...WRITE, origin: 'http://evil.example' }, { origin: WEB }, { ...WRITE, 'content-type': 'text/plain' }]) {
      const response = await handle(request('/api/v1/auth/sign-out', { method: 'POST', headers: { ...headers, cookie: cookie(TOKEN) }, ...('content-type' in headers ? { body: '{}' } : {}) }));
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe('csrf_rejected');
      expect(setCookies(response)).toEqual([]);
    }
    expect(sent).toHaveLength(0);
  });

  it('answers a navigation with the API unknown-route 404, cookie or not (I13)', async () => {
    const { handle, sent } = harness();
    for (const headers of [{ 'sec-fetch-dest': 'document' }, { 'sec-fetch-mode': 'navigate', cookie: cookie(TOKEN) }]) {
      const response = await handle(request('/api/v1/auth/me', { headers }));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(JSON.stringify(NOT_FOUND_BODY));
    }
    expect(sent).toHaveLength(0);
  });

  it('refuses a body over the cap without reading it into the API', async () => {
    const { handle, sent } = harness();
    const big = await handle(request('/api/v1/contacts', { method: 'POST', headers: JSON_WRITE, body: `"${'a'.repeat(1024 * 1024 + 1)}"` }));
    expect(big.status).toBe(413);
    expect(sent).toHaveLength(0);
  });
});

describe('the upstream target (I17)', () => {
  it('canonicalises each segment and keeps the query', () => {
    expect(upstreamTarget(`${WEB}/api/v1/contacts/abc%20def?q=Ada%20B&cursor=x`)).toEqual({
      route: 'contacts/abc def',
      path: '/api/v1/contacts/abc%20def?q=Ada%20B&cursor=x',
    });
    expect(upstreamTarget(`${WEB}/api/v1/AUTH/%6dfa`)?.route).toBe('auth/mfa');
  });

  it.each([
    '/api/v1/',
    '/api/v1//contacts',
    '/api/v1/contacts/',
    '/api/v1/%2F%2F127.0.0.1:9/steal',
    '/api/v1/%2f%2f127.0.0.1:9/steal',
    '/api/v1/..%2F..%2Fhealth',
    '/api/v1/%5C%5C127.0.0.1:9/steal',
    '/api/v1/contacts/x%00',
    '/api/v1/%E0%A4%A',
    '/api/health',
    '/health',
  ])('refuses %s', (path) => {
    expect(upstreamTarget(`${WEB}${path}`)).toBeNull();
  });

  it('never leaves the configured origin or /api/v1, whatever the path, Host or forwarding headers say', async () => {
    const { handle, sent } = harness();
    for (const path of [
      '/api/v1/%2F%2F127.0.0.1:9/steal',
      '/api/v1/@127.0.0.1:9/steal',
      '/api/v1/http:%2F%2F127.0.0.1:9/steal',
      '/api/v1/%2e%2e/%2e%2e/health',
      '/api/v1/..;/..;/health',
      '/api/v1/contacts?url=http://127.0.0.1:9/steal',
    ]) {
      await handle(request(path, { headers: { cookie: cookie(TOKEN), host: '127.0.0.1:9', 'x-forwarded-host': '127.0.0.1:9', forwarded: 'host=127.0.0.1:9' } }));
    }
    for (const entry of sent) {
      const url = new URL(entry.url);
      expect(url.origin).toBe(API);
      expect(url.pathname.startsWith('/api/v1/')).toBe(true);
    }
  });

  it('answers a refused path with the generic 404', async () => {
    const { handle } = harness();
    const response = await handle(request('/api/v1/%2F%2F127.0.0.1:9/steal'));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(JSON.stringify(NOT_FOUND_BODY));
  });
});

describe('token capture (point 3)', () => {
  const user = { id: 'u1', tenantId: 't1', email: 'x@kasuwa.example', displayName: 'X', locale: 'en' };
  const issued = { accessToken: TOKEN, tokenType: 'Bearer', expiresAt: EXPIRES, user };
  const confirmed = { ...issued, backupCodes: ['aaaaa-bbbbb', 'ccccc-ddddd'] };

  it('sets the cookie from the MFA answer and strips the token from the body', async () => {
    const { handle } = harness(() => json(200, issued));
    const response = await handle(request('/api/v1/auth/mfa', { method: 'POST', headers: JSON_WRITE, body: '{}' }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('ksw_s1_');
    expect(JSON.parse(text)).toEqual({ expiresAt: EXPIRES, user });
    expect(setCookies(response)).toEqual([`__Host-kasuwa_session=${TOKEN}; Max-Age=43200; Path=/; HttpOnly; Secure; SameSite=Lax`]);
  });

  it('does the same for enrolment confirmation, keeping the backup codes', async () => {
    const { handle } = harness(() => json(200, confirmed));
    const response = await handle(request('/api/v1/auth/mfa/enrol/confirm', { method: 'POST', headers: JSON_WRITE, body: '{}' }));
    const text = await response.text();
    expect(text).not.toContain('ksw_s1_');
    expect(JSON.parse(text)).toEqual({ expiresAt: EXPIRES, user, backupCodes: confirmed.backupCodes });
    expect(setCookies(response)).toHaveLength(1);
  });

  // D-L181 B1. Both of these passed the token straight to the page before:
  // a token route's non-JSON answer used to stream through untouched.
  it.each([
    ['text/plain', { 'content-type': 'text/plain' }],
    ['no content type', {}],
  ])('fails closed on a token route answering %s, whatever the body says', async (_label, typeHeaders) => {
    const { handle } = harness(() => new Response(JSON.stringify(issued), { status: 200, headers: typeHeaders }));
    const response = await handle(request('/api/v1/auth/mfa', { method: 'POST', headers: JSON_WRITE, body: '{}' }));
    // Parsed as the contract regardless of type: a well-formed body is captured, never streamed.
    expect(await response.text()).not.toContain('ksw_s1_');
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
  });

  it.each([
    ['text/plain', { 'content-type': 'text/plain' }, `token=${TOKEN}`],
    ['no content type', {}, `${TOKEN}`],
  ])('answers 502 to a token route answering %s that is not the contract', async (_label, typeHeaders, body) => {
    const { handle } = harness(() => new Response(body, { status: 200, headers: typeHeaders }));
    const response = await handle(request('/api/v1/auth/mfa', { method: 'POST', headers: JSON_WRITE, body: '{}' }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('ksw_s1_');
    expect(setCookies(response)).toEqual([]);
  });

  it('answers 502 to a token answer with any key the contract does not name, at any level', async () => {
    for (const body of [
      { ...issued, refreshToken: 'x' },
      { ...issued, user: { ...user, sessionId: 's' } },
      { ...issued, backupCodes: ['a'] },
      { ...issued, tokenType: 'MAC' },
    ]) {
      const { handle } = harness(() => json(200, body));
      const response = await handle(request('/api/v1/auth/mfa', { method: 'POST', headers: JSON_WRITE, body: '{}' }));
      expect(response.status, JSON.stringify(Object.keys(body))).toBe(502);
      expect(setCookies(response)).toEqual([]);
    }
  });

  it('answers 502 rather than pass on a token answer it cannot parse', async () => {
    const { handle } = harness(() => json(200, { accessToken: TOKEN, expiresAt: 'tomorrow' }));
    const response = await handle(request('/api/v1/auth/mfa', { method: 'POST', headers: JSON_WRITE, body: '{}' }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('ksw_s1_');
    expect(setCookies(response)).toEqual([]);
  });

  it('never passes a token through on any other route', async () => {
    const { handle } = harness(() => json(200, { accessToken: TOKEN }));
    const response = await handle(request('/api/v1/auth/me', { headers: { cookie: cookie(OLD) } }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('ksw_s1_');
  });

  it('passes a failed MFA through untouched and sets nothing', async () => {
    const { handle } = harness(() => json(401, { code: 'mfa_code_invalid' }));
    const response = await handle(request('/api/v1/auth/mfa', { method: 'POST', headers: { ...JSON_WRITE, cookie: cookie(OLD) }, body: '{}' }));
    expect(response.status).toBe(401);
    expect(setCookies(response)).toEqual([]);
  });

  it('revokes the session it replaces (one session per profile, I10)', async () => {
    const { handle, sent } = harness((entry) => (entry.url.endsWith('/auth/mfa') ? json(200, issued) : new Response(null, { status: 204 })));
    // (the replaced session's revocation is the second upstream call)
    const response = await handle(request('/api/v1/auth/mfa', { method: 'POST', headers: { ...JSON_WRITE, cookie: cookie(OLD) }, body: '{}' }));
    expect(response.status).toBe(200);
    expect(sent[0]?.headers.has('authorization')).toBe(false);
    expect(sent[1]?.url).toBe(`${API}/api/v1/auth/sign-out`);
    expect(sent[1]?.headers.get('authorization')).toBe(`Bearer ${OLD}`);
  });

  it('still signs in when revoking the old session fails', async () => {
    const { handle } = harness((entry) => {
      if (entry.url.endsWith('/auth/sign-out')) throw new Error('unreachable');
      return json(200, issued);
    });
    const response = await handle(request('/api/v1/auth/mfa', { method: 'POST', headers: { ...JSON_WRITE, cookie: cookie(OLD) }, body: '{}' }));
    expect(response.status).toBe(200);
    expect(setCookies(response)).toHaveLength(1);
  });
});

describe('sign-out and 401 (point 5)', () => {
  it('forwards sign-out with the Bearer token, clears the cookie and the cache', async () => {
    const { handle, sent } = harness(() => new Response(null, { status: 204 }));
    const response = await handle(request('/api/v1/auth/sign-out', { method: 'POST', headers: { ...WRITE, cookie: cookie(TOKEN) } }));
    expect(response.status).toBe(204);
    expect(sent[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(setCookies(response)).toEqual(['__Host-kasuwa_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Lax']);
    expect(response.headers.get('clear-site-data')).toBe('"cache"');
  });

  it('clears the cookie even when the API cannot be reached', async () => {
    const { handle } = harness(() => {
      throw new Error('ECONNREFUSED 127.0.0.1:3001');
    });
    const response = await handle(request('/api/v1/auth/sign-out', { method: 'POST', headers: { ...WRITE, cookie: cookie(TOKEN) } }));
    expect(response.status).toBe(502);
    expect(setCookies(response)).toHaveLength(1);
    expect(await response.text()).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
  });

  it('clears the cookie on a 401 from a session route, and passes the body verbatim', async () => {
    const body = { statusCode: 401, error: 'Unauthorized', code: 'not_authenticated', message: 'Not authenticated' };
    const { handle } = harness(() => json(401, body));
    const response = await handle(request('/api/v1/contacts', { headers: { cookie: cookie(TOKEN) } }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(body);
    expect(setCookies(response)[0]).toMatch(/^__Host-kasuwa_session=; Max-Age=0/);
  });

  it('does not clear the cookie on a wrong password', async () => {
    const { handle } = harness(() => json(401, { code: 'invalid_credentials' }));
    const response = await handle(request('/api/v1/auth/sign-in', { method: 'POST', headers: { ...JSON_WRITE, cookie: cookie(TOKEN) }, body: '{}' }));
    expect(setCookies(response)).toEqual([]);
  });

  it('never re-issues the cookie on an authenticated answer (no sliding, no rotation)', async () => {
    const { handle } = harness();
    const response = await handle(request('/api/v1/auth/me', { headers: { cookie: cookie(TOKEN) } }));
    expect(setCookies(response)).toEqual([]);
  });

  it('sends two session cookies upstream as neither (amendment 5)', async () => {
    const { handle, sent } = harness(() => json(401, { code: 'not_authenticated' }));
    const response = await handle(request('/api/v1/contacts', { headers: { cookie: `${cookie(TOKEN)}; ${cookie(OLD)}` } }));
    expect(sent[0]?.headers.has('authorization')).toBe(false);
    expect(response.status).toBe(401);
  });
});

describe('errors and the wire (points 1 and 6)', () => {
  it('answers an unreachable API with 502 and no upstream detail', async () => {
    const { handle } = harness(() => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3001');
    });
    const response = await handle(request('/api/v1/contacts', { headers: { cookie: cookie(TOKEN) } }));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|3001|\n\s+at /);
    expect((JSON.parse(text) as { code: string }).code).toBe('internal_error');
  });

  it('gzips a JSON answer over a kilobyte when the browser accepts it, and drops upstream framing headers', async () => {
    const list = { data: Array.from({ length: 40 }, (_, index) => ({ id: String(index), displayName: `Contact ${String(index)}` })) };
    const { handle } = harness(() => json(200, list, { 'content-length': '1', 'content-encoding': 'br', 'set-cookie': 'x=1' }));
    const response = await handle(request('/api/v1/contacts', { headers: { cookie: cookie(TOKEN), 'accept-encoding': 'gzip, deflate, br' } }));
    expect(response.headers.get('content-encoding')).toBe('gzip');
    const wire = Buffer.from(await response.arrayBuffer());
    expect(JSON.parse(gunzipSync(wire).toString('utf8'))).toEqual(list);
    expect(wire.byteLength).toBeLessThan(JSON.stringify(list).length);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('leaves small answers, and browsers that refuse gzip, uncompressed', async () => {
    const { handle } = harness(() => json(200, { ok: true }));
    const small = await handle(request('/api/v1/auth/me', { headers: { 'accept-encoding': 'gzip' } }));
    expect(small.headers.has('content-encoding')).toBe(false);
    const big = harness(() => json(200, { pad: 'a'.repeat(4096) }));
    const refused = await big.handle(request('/api/v1/auth/me', { headers: { 'accept-encoding': 'gzip;q=0, identity' } }));
    expect(refused.headers.has('content-encoding')).toBe(false);
  });

  it('answers HEAD with no body', async () => {
    const { handle, sent } = harness(() => json(200, { id: 'u1' }));
    const response = await handle(request('/api/v1/auth/me', { method: 'HEAD', headers: { cookie: cookie(TOKEN) } }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(sent[0]?.method).toBe('HEAD');
  });
});

describe('no token on any other answer (D-L181 N1)', () => {
  it.each([
    [200, { data: [{ note: `${TOKEN}` }] }],
    [404, { code: 'not_found', hint: TOKEN }],
    [401, { code: 'not_authenticated', nested: { deep: [{ [TOKEN]: 1 }] } }],
  ])('answers 502 to a %s JSON answer carrying the prefix anywhere', async (status, body) => {
    const { handle } = harness(() => json(status, body));
    const response = await handle(request('/api/v1/contacts', { headers: { cookie: cookie(OLD) } }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('ksw_s1_');
  });

  it('sees an escaped prefix too', () => {
    expect(carriesSessionToken('{"a":"\\u006bsw_s1_x"}')).toBe(true);
    expect(carriesSessionToken('{"a":"kswXs1"}')).toBe(false);
    expect(carriesSessionToken('not json')).toBe(false);
  });

  it('keeps streaming a non-JSON answer untouched', async () => {
    const { handle } = harness(() => new Response(`id,note\n1,${TOKEN}\n`, { status: 200, headers: { 'content-type': 'text/csv' } }));
    const response = await handle(request('/api/v1/admin/audit/export', { headers: { cookie: cookie(TOKEN) } }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id,note');
  });

  it('caps a buffered JSON answer at 8 MiB (D-L181 N6)', async () => {
    const big = `{"pad":"${'a'.repeat(MAX_UPSTREAM_JSON_BYTES)}"}`;
    const { handle } = harness(() => new Response(big, { status: 200, headers: { 'content-type': 'application/json' } }));
    const response = await handle(request('/api/v1/contacts', { headers: { cookie: cookie(TOKEN) } }));
    expect(response.status).toBe(502);
  });
});

describe('what counts as a body (D-L181 N5)', () => {
  it('passes an empty body stream as bodyless, whatever Content-Length claims', async () => {
    const { handle, sent } = harness(() => new Response(null, { status: 204 }));
    const lying = new Request(`${WEB}/api/v1/auth/sign-out`, { method: 'POST', headers: { ...WRITE, 'content-length': '5', cookie: cookie(TOKEN) }, body: '' });
    const response = await handle(lying);
    expect(response.status).toBe(204);
    expect(sent[0]?.body).toBeUndefined();
  });

  it('refuses bytes with no JSON type even when no length header announced them', async () => {
    const { handle, sent } = harness();
    const chunked = new Request(`${WEB}/api/v1/contacts`, {
      method: 'POST',
      headers: { ...WRITE, cookie: cookie(TOKEN) },
      body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('a=1')); controller.close(); } }),
      duplex: 'half',
    } as RequestInit);
    const response = await handle(chunked);
    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});
