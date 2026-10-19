import { STATUS_CODES } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { INestApplication } from '@nestjs/common';
import { TENANT_A, USER_A_SUPERVISOR } from '@kasuwa/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0121, every API answer carries the error envelope and
 * `no-store` (Agent 1, Platform & Security). Decisions: D-L90 (the `no-store`
 * follow-up), D-L96 (the raised JSON limit), D-L97, D-L100 (the T-0113
 * follow-ups that became this task).
 *
 * Written before the build (D-L23), from the task file, the decisions and the
 * published `Error` schemas, not from an implementation (D-L25).
 *
 * THE HOLE. Some answers never reach a Nest filter, so they escape the shared
 * `Error` envelope (`statusCode`, `error`, `code`, `message`) and the
 * `Cache-Control: no-store` that records and scripting routes promise:
 *   - body-parser failures other than a JSON syntax error (T-0108 R15 mapped
 *     that one): the 413 for an over-limit body, and its 415s and 400s for a
 *     charset or Content-Encoding it will not read. Their messages quote what
 *     the client sent (`unsupported charset "X"`, `... encoding "X"`);
 *   - Express's "Failed to decode param" for a malformed `%`-encoding in a
 *     path parameter, which is Express's own answer, not the route's, and
 *     quotes the parameter;
 *   - the urlencoded no-op (T-0113) is found by Nest BY FUNCTION NAME; a
 *     bundler that renames it lets Nest reinstall the real parser.
 *
 * ---------------------------------------------------------------------------
 * PINNED (the builder must honour these exactly)
 * ---------------------------------------------------------------------------
 *
 *  E0. THE ENVELOPE. Every answer below is `application/json` and a JSON
 *      object whose keys are among `statusCode`, `error`, `code`, `message`,
 *      `details`; `statusCode` is the HTTP status; `error` is Node's reason
 *      phrase for it (`http.STATUS_CODES`); `code` and `message` are strings;
 *      `details`, if present, is an array of `{ path, code }` string pairs and
 *      nothing else. No body echoes what the client sent: not a body value,
 *      not a header value, not the path, and never V8's parse text
 *      ("Unexpected token", "position", "line", "column").
 *  E1. MALFORMED JSON is 400 with exactly the body T-0108 R15 fixed:
 *      `validation_failed`, `details: [{ path: '', code: 'invalid_json' }]`,
 *      on every route family (auth, records, scripting, admin) and on a path
 *      that matches no route. (Passes on main: a pin, not new work.)
 *  E2. AN OVER-LIMIT BODY (over 512 KiB, D-L96) is 413 with ONE body, byte
 *      for byte, on every route family and on an unmatched path, whatever the
 *      size and however it got there (plain, or gzip that inflates past the
 *      limit). Its `code` is `validation_failed` (ruling R1).
 *  E3. EVERY OTHER BODY-PARSER REFUSAL is the envelope at body-parser's own
 *      status, `code: 'validation_failed'`, echoing nothing: an unsupported
 *      charset (415), an unsupported Content-Encoding (415), and a gzip body
 *      that does not inflate (400). (Ruling R2.)
 *  E4. A MALFORMED %-ENCODING IN A PATH PARAMETER gets the route's own answer:
 *      status, body, Content-Type and Cache-Control identical to the answer
 *      the same route gives for a well-formed value that is not an id
 *      (`zzz`), signed in and signed out. Never HTML, never "Failed to
 *      decode", never "URIError". Checked on a parameter in every route
 *      family, a second parameter, and a non-uuid one (`:locale`).
 *  E5. `Cache-Control: no-store`, exactly, on every answer above, and on every
 *      `/api/v1` answer generally (D-L90's follow-up: one shared middleware,
 *      not per-handler headers). Sampled where main has none today: an auth
 *      400, admin 200s, an unmatched path's 404.
 *  E6. INSTALLED BEFORE THE BODY PARSER. In the real app's Express router, a
 *      middleware that sets `Cache-Control: no-store` and calls `next()`
 *      sits before the JSON parser layer (the layer Nest itself finds by the
 *      name `jsonParser`). Setting the header in the error handler instead
 *      does not satisfy this.
 *  E7. A PATH THAT MATCHES NO ROUTE (any method) is 404 with `code:
 *      'not_found'` and does not echo the path. (Ruling R3.)
 *  E8. THE URLENCODED NO-OP sets its function name explicitly
 *      (`Object.defineProperty(fn, 'name', { value: 'urlencodedParser' })`
 *      somewhere under `apps/api/src`, tests excluded), so a minifier cannot
 *      rename it out of Nest's sight. And it still parses nothing: a form
 *      body gets the same answer as no body at all. (Static, as the task
 *      asks; the production-bundle smoke test is the builder's, see below.)
 *
 * ---------------------------------------------------------------------------
 * RULINGS (suite-writer readings; the lead may rule otherwise)
 * ---------------------------------------------------------------------------
 *  R1. 413's `code` is `validation_failed`. Every published `Error.code` enum
 *      (auth.openapi.yaml and admin.openapi.yaml, which records and scripting
 *      share) holds it, and none holds a "too large" code. An over-limit body
 *      can arrive on an auth route, so the code must be in both enums; a new
 *      code would be a contract change in four YAMLs and every e2e mock that
 *      validates against them (D-L97). The test checks membership in both
 *      enums, so a lead ruling for a new code is a contract PR first.
 *  R2. The 415s and the gzip 400 are in scope: the task's goal is "no answer
 *      ... however malformed the request", and today they quote the header
 *      the client sent. Their statuses stay body-parser's.
 *  R3. The unmatched path is in scope for the same reason: Nest answers it
 *      with `Cannot GET /the/path`, no `code`, the path echoed. `not_found`
 *      is in the admin enum (the auth enum has none; an unmatched path is no
 *      auth route).
 *
 * ---------------------------------------------------------------------------
 * THE BUILDER'S (not pinned)
 * ---------------------------------------------------------------------------
 * How the decode failure becomes the route's answer (an error middleware that
 * re-runs nothing cannot produce the route's own body; re-encoding a stray
 * `%` before routing is one way); the 413 body's `message` and `details`
 * (only its shape and its sameness are pinned); whether the shared no-store
 * middleware also covers `/health`; the production-bundle smoke test (the
 * task asks for one; its shape depends on how the API is bundled); the
 * optional route-scoped 512 KiB limit, which needs `express` as a direct
 * dependency and is a decision to raise, not to take. If it is taken, E2's
 * bodies are still over every limit.
 *
 * TRAPS THE BUILDER SHOULD KNOW ABOUT:
 *   - The decode failure is not only a route problem. `AppModule` applies
 *     `RequestTelemetryMiddleware` to `{*splat}`, a route with a parameter,
 *     so on main EVERY path with a stray `%` fails there, before any
 *     controller is chosen, including paths no controller matches (E7).
 *   - Nest finds body parsers by function name (`jsonParser`,
 *     `urlencodedParser`), and so does E6. Middleware added with
 *     `MiddlewareConsumer` is mounted at `init()`, after the parser; only
 *     something installed on the adapter before `useBodyParser` runs first.
 *   - Superagent JSON-encodes a Buffer under a JSON Content-Type unless told
 *     otherwise; this file's `sendRaw` does that, if you add cases.
 *
 * D-L23, observed on main: 80 of 90 fail, each for a reason above (a 413 and
 * the 415s and gzip 400 with no `code`, no `error`, no no-store and the
 * header quoted; "Failed to decode param '<value>'" with no `code` or
 * no-store; admin answers and unmatched paths with no no-store; Nest's
 * `Cannot GET /path`; no layer before `jsonParser`; no explicit name on the
 * no-op). The 10 passes are pins: E1 on all seven routes, E5's auth 400 and
 * `/me/programmes`, and E8's form-body behaviour. A throwaway prototype (not
 * committed) made all 90 pass, so the file asks for nothing impossible.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const API_SRC = resolve(REPO_ROOT, 'apps', 'api', 'src');

/** Stub-auth headers for a seeded user who is a tenant admin of both A programmes. */
const SIGNED_IN = asUser(TENANT_A, USER_A_SUPERVISOR);
const SIGNED_OUT: Record<string, string> = {};

/** A string that must never come back. */
const CANARY = 'T0121canaryQz7';
/** A uuid that names nothing. */
const NOBODY = '00000000-0000-4000-8000-0000000c0121';

const ENVELOPE_KEYS = new Set(['statusCode', 'error', 'code', 'message', 'details']);
/** V8's and body-parser's own words, and Express's. */
const LEAKS = /Unexpected token|Unexpected end|position \d|line \d|column \d|in JSON|SyntaxError|URIError|Failed to decode|<html|<pre|<!DOCTYPE|\bat [\w.<>]+ \(/iu;

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
interface Route {
  family: string;
  method: Method;
  path: string;
}

/** One write route per family, plus two paths no route matches. */
const BODY_ROUTES: readonly Route[] = [
  { family: 'auth', method: 'post', path: '/api/v1/auth/sign-in' },
  { family: 'records', method: 'post', path: '/api/v1/contacts' },
  { family: 'records (param)', method: 'patch', path: `/api/v1/contacts/${NOBODY}` },
  { family: 'scripting', method: 'post', path: '/api/v1/scripts' },
  { family: 'admin', method: 'post', path: '/api/v1/admin/roles' },
  { family: 'unmatched under /api/v1', method: 'post', path: '/api/v1/t0121-no-such-route' },
  { family: 'unmatched at the root', method: 'post', path: '/t0121-no-such-route' },
];

/**
 * Path-parameter routes, `{}` where the malformed value goes. One per family,
 * a second parameter, and a non-uuid one. Writes send `{}`.
 */
const PARAM_ROUTES: readonly Route[] = [
  { family: 'records: contact', method: 'get', path: '/api/v1/contacts/{}' },
  { family: 'records: contact timeline', method: 'get', path: '/api/v1/contacts/{}/timeline' },
  { family: 'records: account', method: 'get', path: '/api/v1/accounts/{}' },
  { family: 'records: deal', method: 'get', path: '/api/v1/deals/{}' },
  { family: 'records: pipeline deals', method: 'get', path: '/api/v1/pipelines/{}/deals' },
  { family: 'records: contact patch', method: 'patch', path: '/api/v1/contacts/{}' },
  { family: 'scripting: script', method: 'get', path: '/api/v1/scripts/{}' },
  { family: 'scripting: second parameter', method: 'get', path: `/api/v1/scripts/${NOBODY}/versions/{}` },
  { family: 'scripting: locale (not a uuid)', method: 'put', path: `/api/v1/scripts/${NOBODY}/translations/{}` },
  { family: 'scripting: run', method: 'get', path: '/api/v1/script-runs/{}' },
  { family: 'scripting: contact scripts', method: 'get', path: '/api/v1/contacts/{}/scripts' },
  { family: 'admin: role', method: 'get', path: '/api/v1/admin/roles/{}' },
  { family: 'admin: programme', method: 'get', path: '/api/v1/admin/programmes/{}' },
  { family: 'admin: dispositions', method: 'get', path: '/api/v1/admin/programmes/{}/dispositions' },
  { family: 'admin: audit export', method: 'get', path: '/api/v1/admin/audit/exports/{}' },
  { family: 'admin: custom field', method: 'patch', path: '/api/v1/admin/custom-fields/{}' },
];

/** Encodings `decodeURIComponent` refuses. `zzz` is the well-formed control. */
const MALFORMED = ['%E0%A4%A', '%', '%ZZ', '%C0%AF', `${CANARY}%E0`];

let app: INestApplication;
let authCodes: Set<string>;
let adminCodes: Set<string>;

function errorCodes(spec: string): Set<string> {
  const doc = parse(readFileSync(resolve(REPO_ROOT, 'docs', 'api', spec), 'utf8')) as {
    components?: { schemas?: { Error?: { properties?: { code?: { enum?: unknown } } } } };
  };
  const values = doc.components?.schemas?.Error?.properties?.code?.enum;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${spec} has no Error.code enum; this suite reads it`);
  }
  return new Set(values.map(String));
}

function send(route: Route, path: string, headers: Record<string, string>): request.Test {
  return request(app.getHttpServer())[route.method](path).set(headers);
}

/**
 * Sends `bytes` exactly as given. Without the identity serializer superagent
 * JSON-encodes a Buffer when the Content-Type is JSON, and the server then
 * sees `{"type":"Buffer",...}`, not the bytes.
 */
function sendRaw(test: request.Test, bytes: Buffer): request.Test {
  return test.serialize((body: unknown) => body as string).send(bytes);
}

function parsed(response: request.Response): Record<string, unknown> {
  expect(response.headers['content-type'] ?? '', `not JSON: ${response.text.slice(0, 200)}`).toMatch(
    /^application\/json\b/u,
  );
  const body: unknown = JSON.parse(response.text);
  expect(typeof body === 'object' && body !== null && !Array.isArray(body), 'the body is not an object').toBe(true);
  return body as Record<string, unknown>;
}

/** E0, plus `no-store` (E5). Returns the parsed body. */
function expectEnvelope(response: request.Response, status: number): Record<string, unknown> {
  expect(response.status, response.text.slice(0, 300)).toBe(status);
  const body = parsed(response);
  expect(Object.keys(body).filter((key) => !ENVELOPE_KEYS.has(key)), 'keys outside the envelope').toEqual([]);
  expect(body.statusCode).toBe(status);
  expect(body.error).toBe(STATUS_CODES[status]);
  expect(typeof body.code).toBe('string');
  expect(typeof body.message).toBe('string');
  if (body.details !== undefined) {
    expect(Array.isArray(body.details), 'details is not an array').toBe(true);
    for (const item of body.details as unknown[]) {
      expect(typeof item === 'object' && item !== null).toBe(true);
      const entry = item as Record<string, unknown>;
      expect(Object.keys(entry).sort()).toEqual(['code', 'path']);
      expect(typeof entry.path).toBe('string');
      expect(typeof entry.code).toBe('string');
    }
  }
  expect(response.text, 'the body echoes the canary').not.toContain(CANARY);
  expect(response.text, 'the body carries parser or framework text').not.toMatch(LEAKS);
  // Last, so a body that is wrong in shape says so first.
  expect(response.headers['cache-control'], 'Cache-Control is not exactly no-store').toBe('no-store');
  return body;
}

/** R1: a body-parser refusal can land on an auth route, so its code is in both enums. */
function expectSharedCode(body: Record<string, unknown>, code: string): void {
  expect(body.code).toBe(code);
  expect(authCodes.has(code), `${code} is not in auth.openapi.yaml's Error.code`).toBe(true);
  expect(adminCodes.has(code), `${code} is not in admin.openapi.yaml's Error.code`).toBe(true);
}

beforeAll(async () => {
  authCodes = errorCodes('auth.openapi.yaml');
  adminCodes = errorCodes('admin.openapi.yaml');
  app = await createApi(inject('databaseUrl'));
});

afterAll(async () => {
  await app?.close();
});

describe('E1. malformed JSON is the fixed 400 on every route family (pin, T-0108 R15)', () => {
  const MALFORMED_JSON = [
    `{"name": "${CANARY}", `,
    `{"name": "${CANARY}" "x": 1}`,
    `[${CANARY}]`,
    `"${CANARY}"`,
  ];

  it.each(BODY_ROUTES.map((route) => [route.family, route] as const))('%s', async (_family, route) => {
    const bodies = new Set<string>();
    for (const raw of MALFORMED_JSON) {
      const response = await send(route, route.path, SIGNED_IN)
        .set('Content-Type', 'application/json')
        .send(raw);
      const body = expectEnvelope(response, 400);
      expectSharedCode(body, 'validation_failed');
      expect(body.details).toEqual([{ path: '', code: 'invalid_json' }]);
      bodies.add(response.text);
    }
    expect(bodies.size, 'the body varies with the input').toBe(1);
  });
});

describe('E2. an over-limit body is ONE 413 envelope everywhere (R1)', () => {
  /** Valid JSON, well over 512 KiB, with the canary inside. */
  const over = (bytes: number): string =>
    JSON.stringify({ name: CANARY, filler: `${CANARY}${'x'.repeat(bytes)}` });

  let reference: string | undefined;

  it.each(BODY_ROUTES.map((route) => [route.family, route] as const))('%s', async (_family, route) => {
    const texts = new Set<string>();
    for (const bytes of [700 * 1024, 3 * 1024 * 1024]) {
      const response = await send(route, route.path, SIGNED_IN)
        .set('Content-Type', 'application/json')
        .send(over(bytes));
      const body = expectEnvelope(response, 413);
      expectSharedCode(body, 'validation_failed');
      texts.add(response.text);
    }
    expect(texts.size, 'the 413 body varies with the size').toBe(1);
    const [text] = [...texts];
    reference ??= text;
    expect(text, 'the 413 body differs between routes').toBe(reference);
  });

  it('a gzip body that inflates past the limit is the same 413', async () => {
    const route = BODY_ROUTES[1];
    if (route === undefined) throw new Error('no records route');
    const response = await sendRaw(
      send(route, route.path, SIGNED_IN)
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'gzip'),
      gzipSync(Buffer.from(over(2 * 1024 * 1024))),
    );
    const body = expectEnvelope(response, 413);
    expectSharedCode(body, 'validation_failed');
    if (reference !== undefined) expect(response.text).toBe(reference);
  });
});

describe('E3. every other body-parser refusal is the envelope and echoes nothing (R2)', () => {
  const cases: ReadonlyArray<[string, number, (test: request.Test) => request.Test]> = [
    [
      'an unsupported charset',
      415,
      (test) => test.set('Content-Type', `application/json; charset=${CANARY}`).send('{}'),
    ],
    [
      'a charset that is not utf-*',
      415,
      (test) => test.set('Content-Type', 'application/json; charset=latin1').send('{}'),
    ],
    [
      'an unsupported Content-Encoding',
      415,
      (test) =>
        test.set('Content-Type', 'application/json').set('Content-Encoding', `x-${CANARY}`).send('{}'),
    ],
    [
      'a gzip body that does not inflate',
      400,
      (test) =>
        sendRaw(
          test.set('Content-Type', 'application/json').set('Content-Encoding', 'gzip'),
          Buffer.from(`${CANARY} is not gzip`),
        ),
    ],
  ];

  for (const route of BODY_ROUTES) {
    it.each(cases)(`${route.family}: %s is %d`, async (_label, status, shape) => {
      const response = await shape(send(route, route.path, SIGNED_IN));
      const body = expectEnvelope(response, status);
      expectSharedCode(body, 'validation_failed');
      expect(response.text.toLowerCase(), 'the body echoes the header').not.toContain('latin1');
      expect(response.text, 'zlib text in the body').not.toMatch(/incorrect header check|zlib|Z_/u);
    });
  }
});

describe('E4. a malformed %-encoding in a path parameter is the route’s own answer', () => {
  for (const [who, headers] of [
    ['signed in', SIGNED_IN],
    ['signed out', SIGNED_OUT],
  ] as const) {
    it.each(PARAM_ROUTES.map((route) => [route.family, route] as const))(
      `${who}: %s`,
      async (_family, route) => {
        const control = await send(route, route.path.replace('{}', 'zzz'), headers).send(
          route.method === 'get' ? undefined : {},
        );
        // The control is the route's own refusal of a value that is not an id.
        expect(control.status, `the control was not refused: ${control.text.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
        expect(control.status).toBeLessThan(500);

        for (const value of MALFORMED) {
          const response = await send(route, route.path.replace('{}', value), headers).send(
            route.method === 'get' ? undefined : {},
          );
          const label = `${route.method.toUpperCase()} ${route.path.replace('{}', value)}`;
          expect(response.text, `${label}: framework text`).not.toMatch(LEAKS);
          expect(
            {
              status: response.status,
              contentType: response.headers['content-type'],
              cacheControl: response.headers['cache-control'],
              body: response.text,
            },
            `${label} is not the route's own answer`,
          ).toEqual({
            status: control.status,
            contentType: control.headers['content-type'],
            cacheControl: control.headers['cache-control'],
            body: control.text,
          });
        }
        // And the route's own answer is itself the envelope, with no-store
        // (E5: admin routes have none on main, so this fails there too).
        expectEnvelope(control, control.status);
      },
    );
  }
});

describe('E5. every /api/v1 answer is no-store, errors and successes alike', () => {
  it('an auth validation 400 (the handler’s @Header never reaches it)', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/sign-in')
      .set('Content-Type', 'application/json')
      .send({});
    expectEnvelope(response, 400);
  });

  it.each([
    ['GET /api/v1/admin/roles', '/api/v1/admin/roles'],
    ['GET /api/v1/admin/programmes', '/api/v1/admin/programmes'],
    ['GET /api/v1/me/programmes', '/api/v1/me/programmes'],
  ])('%s, signed in (200) and signed out (401)', async (_label, path) => {
    const ok = await request(app.getHttpServer()).get(path).set(SIGNED_IN);
    expect(ok.status, ok.text.slice(0, 200)).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');

    const anonymous = await request(app.getHttpServer()).get(path);
    expectEnvelope(anonymous, 401);
  });
});

describe('E6. no-store is installed before the body parser', () => {
  interface Layer {
    name?: unknown;
    handle?: unknown;
  }

  /** The Express router's layers, in order. */
  function layers(): Layer[] {
    const instance: unknown = app.getHttpAdapter().getInstance();
    const router: unknown = (instance as { router?: unknown } | null)?.router;
    const stack: unknown = (router as { stack?: unknown } | undefined)?.stack;
    if (!Array.isArray(stack)) throw new Error('the Express router has no stack');
    return stack as Layer[];
  }

  function nameOf(layer: Layer): string {
    const handle = layer.handle as { name?: unknown } | undefined;
    return typeof handle?.name === 'string' ? handle.name : '';
  }

  /** Runs one middleware against a bare request; true when it set no-store and called next. */
  function setsNoStore(layer: Layer): boolean {
    const handle = layer.handle;
    if (typeof handle !== 'function' || handle.length > 3) return false; // error handlers take 4
    const headers = new Map<string, string>();
    const response = {
      setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), String(value)),
      header: (name: string, value: string) => headers.set(name.toLowerCase(), String(value)),
      set: (name: string, value: string) => headers.set(name.toLowerCase(), String(value)),
      getHeader: (name: string) => headers.get(name.toLowerCase()),
      locals: {},
    };
    const requestLike = {
      method: 'GET',
      url: '/api/v1/t0121',
      originalUrl: '/api/v1/t0121',
      path: '/api/v1/t0121',
      headers: {},
      get: () => undefined,
      header: () => undefined,
    };
    let calledNext = false;
    try {
      (handle as (q: unknown, s: unknown, n: (error?: unknown) => void) => unknown)(
        requestLike,
        response,
        (error?: unknown) => {
          calledNext = error === undefined;
        },
      );
    } catch {
      return false;
    }
    return calledNext && headers.get('cache-control') === 'no-store';
  }

  it('a layer before `jsonParser` sets Cache-Control: no-store and passes the request on', () => {
    const stack = layers();
    const parser = stack.findIndex((layer) => nameOf(layer) === 'jsonParser');
    expect(parser, 'no jsonParser layer in the router').toBeGreaterThanOrEqual(0);
    const before = stack.slice(0, parser);
    expect(
      before.some((layer) => setsNoStore(layer)),
      `no layer before the parser sets no-store (before it: ${before.map(nameOf).join(', ') || 'nothing'})`,
    ).toBe(true);
  });
});

describe('E7. a path that matches no route is the 404 envelope and echoes nothing (R3)', () => {
  it.each([
    ['GET', 'get'],
    ['POST', 'post'],
    ['DELETE', 'delete'],
  ] as const)('%s /api/v1/<nothing>', async (_label, method) => {
    const path = `/api/v1/${CANARY}/nothing`;
    const response = await request(app.getHttpServer())[method](path).set(SIGNED_IN);
    const body = expectEnvelope(response, 404);
    expect(body.code).toBe('not_found');
    expect(adminCodes.has('not_found')).toBe(true);
    expect(response.text).not.toContain('/nothing');
  });

  // On main every path is decoded by the telemetry middleware's `{*splat}`
  // route, so even a path no controller matches fails with "Failed to decode
  // param". With nothing to route to, the answer is this 404.
  it.each(MALFORMED)('GET /api/v1/nothing/%s is the same 404 as /api/v1/nothing/zzz', async (value) => {
    const control = await request(app.getHttpServer()).get('/api/v1/nothing/zzz').set(SIGNED_IN);
    expect(expectEnvelope(control, 404).code).toBe('not_found');
    const response = await request(app.getHttpServer()).get(`/api/v1/nothing/${value}`).set(SIGNED_IN);
    expect({ status: response.status, body: response.text, cc: response.headers['cache-control'] }).toEqual({
      status: control.status,
      body: control.text,
      cc: control.headers['cache-control'],
    });
  });
});

describe('E8. the urlencoded no-op is named explicitly, and still parses nothing', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.ts$/u.test(name) && !/\.test\.ts$/u.test(name) ? [path] : [];
    });
  }

  /** `//` and block comments removed, strings kept. */
  function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:'"`])\/\/.*$/gmu, '$1');
  }

  it('Object.defineProperty(fn, "name", { value: "urlencodedParser" }) exists under apps/api/src', () => {
    const NAMED =
      /Object\.defineProperty\(\s*[\w$.]+\s*,\s*['"]name['"]\s*,\s*\{[^}]*\bvalue\s*:\s*['"]urlencodedParser['"]/u;
    const hits = sourceFiles(API_SRC).filter((file) => NAMED.test(withoutComments(readFileSync(file, 'utf8'))));
    expect(hits, 'the no-op relies on its declared name, which a minifier may rename').not.toEqual([]);
  });

  it('a form body gets the same answer as no body at all (nothing was parsed)', async () => {
    // Sign-in, because its answer depends on the body before anything else:
    // no body is the 400 validation answer, while the same fields parsed are
    // 401 invalid_credentials (an invented identity, so a counter that moves
    // locks out nobody).
    const empty = await request(app.getHttpServer()).post('/api/v1/auth/sign-in');
    const form = await request(app.getHttpServer())
      .post('/api/v1/auth/sign-in')
      .type('form')
      .send(`tenantSlug=t0121-nowhere&email=nobody%40t0121.invalid&password=${CANARY}`);
    expect(empty.status, 'the control is not the validation 400').toBe(400);
    expect({ status: form.status, body: form.text }).toEqual({ status: empty.status, body: empty.text });
    expect(form.text).not.toContain(CANARY);
  });
});
