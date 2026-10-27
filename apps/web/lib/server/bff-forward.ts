import { promisify } from 'node:util';
import { gzip as gzipCallback } from 'node:zlib';
import { z } from 'zod';
import { INTERNAL_ERROR_BODY, NOT_FOUND_BODY, SCOPE_HEADER_REJECTED_BODY, SESSION_TOKEN_PREFIX } from '@kasuwa/config/session';
import { CSRF_REJECTED_BODY, hasRequestBody, isNavigation, passesCsrf } from './csrf';
import { FORWARDED_RESPONSE_HEADERS, hasScopeHeader, upstreamHeaders } from './header-policy';
import {
  clearSessionSetCookie,
  maxAgeUntil,
  readSessionCookie,
  sessionSetCookie,
  type CookieMode,
  type SessionCookie,
} from './session-cookie';

const gzip = promisify(gzipCallback);

/**
 * THE BROWSER'S ONLY DOOR TO THE API (ADR-0019, T-0125). SERVER ONLY.
 *
 * `app/api/v1/[...path]/route.ts` hands every method here. It moves the
 * session token from an HttpOnly cookie into `Authorization: Bearer`, and
 * NOTHING ELSE about identity: it resolves no session, reads no database and
 * decides no scope. The API resolves the session through
 * `app.resolve_session` and the scope through `user_programme`, on every
 * request, exactly as it does for any other client (CLAUDE.md 2.2). Because
 * it caches nothing about the caller, a revoked session, a disabled user or a
 * removed programme takes effect on the next request.
 *
 * In order, for every request:
 *   1. a top-level navigation is the API's unknown-route 404 (point 1, I13);
 *   2. the path is canonicalised and kept under `/api/v1/` on the configured
 *      API origin, or it is that same 404 (I17: no request, and so no token,
 *      ever goes anywhere else);
 *   3. a scope header is the API's 400 (I12);
 *   4. an unsafe method passes CSRF or is a 403 that names no check (I4);
 *   5. the allowlisted headers, the body and the cookie's token go upstream;
 *   6. the two token-issuing answers set the cookie and lose the token
 *      (point 3); sign-out clears it whatever the API said (point 5); a 401
 *      clears it (point 5);
 *   7. every answer is `no-store`, `nosniff` and `default-src 'none'`, and a
 *      JSON body over a kilobyte is gzipped, because Next does not compress
 *      route-handler responses and on a 2G link that matters more than
 *      anything else here (point 6, I15).
 *
 * NOTHING HERE LOGS. A request's headers carry the cookie and its body may
 * carry a password; a refusal's body echoes nothing it was sent (I24).
 */

export interface BffConfig {
  /** KASUWA_API_INTERNAL_URL, a bare origin. */
  readonly apiOrigin: string;
  /** KASUWA_WEB_ORIGIN, a bare origin: the only `Origin` a write may carry. */
  readonly webOrigin: string;
  /** This web process's own KASUWA_AUTH_MODE is `stub` (never under production). */
  readonly forwardStubIdentity: boolean;
  readonly cookie: CookieMode;
}

export interface BffDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
}

const API_PREFIX = '/api/v1/';

/** Requests larger than this never reach the API; the API's own JSON limit (512 KiB) refuses most before then. */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/** How long the BFF waits for the API before answering 502. */
const UPSTREAM_TIMEOUT_MS = 60_000;

/** Best-effort revocation of the session a new sign-in replaces. */
const REVOKE_TIMEOUT_MS = 5_000;

/** Bodies smaller than this are not worth gzip's ~20-byte frame. */
const COMPRESS_MIN_BYTES = 1024;

/**
 * Routes that run before a session exists (sign-in, the second factor, SSO
 * lookup, the unbuilt sign-up). They are sent NO Bearer token, whether or not
 * a cookie is present: they do not need one, and the fewer requests carry a
 * token, the fewer places it can end up. A 401 from one of them is a wrong
 * password or code, not a dead session, so it does not clear the cookie.
 * Lower-case, because Express routes case-insensitively.
 */
const PRE_SESSION_ROUTES = new Set([
  'auth/sign-in',
  'auth/mfa',
  'auth/mfa/challenge',
  'auth/mfa/enrol',
  'auth/mfa/enrol/confirm',
  'auth/sso/lookup',
  'auth/sign-up',
  'auth/verify-otp',
  'auth/verify-otp/resend',
]);

/** The two routes that issue a token (point 3). */
const TOKEN_ROUTES = new Set(['auth/mfa', 'auth/mfa/enrol/confirm']);

const SIGN_OUT_ROUTE = 'auth/sign-out';

/** Set on a 401 that means the browser is signed out; the web app's fetch wrapper then goes to sign-in. */
export const SESSION_ENDED_HEADER = 'x-kasuwa-session';

/**
 * What a token route's 2xx must be, EXACTLY, before the BFF trusts it (D-L181
 * B1): `SessionEstablished` and `SessionWithBackupCodes` in
 * docs/api/auth.openapi.yaml, with `CurrentUser` as the user. Strict, never
 * passthrough: an unknown key is a 502, because the BFF cannot know that a key
 * it has never heard of is not a second credential.
 */
const IssuedUser = z.strictObject({ id: z.string(), tenantId: z.string(), email: z.string(), displayName: z.string(), locale: z.string() });
const SessionEstablished = z.strictObject({
  accessToken: z.string().min(1),
  tokenType: z.literal('Bearer'),
  expiresAt: z.iso.datetime({ offset: true }),
  user: IssuedUser,
});
const SessionWithBackupCodes = SessionEstablished.extend({
  backupCodes: z.array(z.string()).min(1).max(10),
}).strict();

const ISSUED_SESSION: Readonly<Record<string, typeof SessionEstablished | typeof SessionWithBackupCodes>> = {
  'auth/mfa': SessionEstablished,
  'auth/mfa/enrol/confirm': SessionWithBackupCodes,
};

/** The most upstream JSON the BFF will hold in memory to inspect (D-L181 N6). */
export const MAX_UPSTREAM_JSON_BYTES = 8 * 1024 * 1024;

const BAD_GATEWAY_BODY = Object.freeze({ ...INTERNAL_ERROR_BODY, statusCode: 502, error: 'Bad Gateway' });

const PAYLOAD_TOO_LARGE_BODY = Object.freeze({
  statusCode: 413,
  error: 'Payload Too Large',
  code: 'validation_failed',
  message: 'The request body could not be read.',
});

const BFF_CSP = "default-src 'none'; frame-ancestors 'none'";

/** The canonical route below `/api/v1/` (lower-case, decoded), and the upstream path to request. */
export interface UpstreamTarget {
  readonly route: string;
  readonly path: string;
}

/**
 * Canonicalises the request target. Each segment is percent-decoded and
 * re-encoded, so `%2F`, `%5C`, `%2e%2e` and friends can never become a
 * separator, a dot segment or a host on the way out. A segment that decodes
 * to nothing, to `.` or `..`, or to anything holding a slash, a backslash or
 * a control character is refused: no API id contains one, and a request that
 * needs one is a probe. Returns null for a refusal.
 */
export function upstreamTarget(requestUrl: string): UpstreamTarget | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (!url.pathname.startsWith(API_PREFIX)) return null;
  const segments: string[] = [];
  for (const raw of url.pathname.slice(API_PREFIX.length).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    // eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
    if (segment === '' || segment === '.' || segment === '..' || /[/\\\u0000-\u001f\u007f]/.test(segment)) {
      return null;
    }
    segments.push(segment);
  }
  return {
    route: segments.join('/').toLowerCase(),
    path: `${API_PREFIX}${segments.map(encodeURIComponent).join('/')}${url.search}`,
  };
}

/** The absolute upstream URL, proven to be on the configured origin and under `/api/v1/`. */
function upstreamUrl(config: BffConfig, target: UpstreamTarget): string | null {
  const url = new URL(target.path, config.apiOrigin);
  if (url.origin !== config.apiOrigin || !url.pathname.startsWith(API_PREFIX)) return null;
  return url.toString();
}

function securityHeaders(headers: Headers): Headers {
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-security-policy', BFF_CSP);
  return headers;
}

function nullBodyStatus(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

function jsonAnswer(status: number, body: unknown, extra: readonly string[] = []): Response {
  const headers = securityHeaders(new Headers({ 'content-type': 'application/json; charset=utf-8' }));
  for (const line of extra) headers.append('set-cookie', line);
  return new Response(JSON.stringify(body), { status, headers });
}

function acceptsGzip(acceptEncoding: string | null): boolean {
  if (acceptEncoding === null) return false;
  return acceptEncoding.split(',').some((entry) => {
    const [coding = '', ...parameters] = entry.split(';').map((part) => part.trim().toLowerCase());
    if (coding !== 'gzip' && coding !== '*') return false;
    const q = parameters.find((parameter) => parameter.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

function isJsonType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const [type = ''] = contentType.split(';');
  const normalised = type.trim().toLowerCase();
  return normalised === 'application/json' || normalised.endsWith('+json');
}

/** Reads at most `limit` bytes of a body stream; null when it is larger. */
async function readBounded(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Every string in a parsed JSON value, keys included, at any depth. */
function* stringsIn(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    yield value;
  } else if (Array.isArray(value)) {
    for (const item of value) yield* stringsIn(item);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      yield key;
      yield* stringsIn(item);
    }
  }
}

/**
 * Whether a buffered answer carries a session token (D-L181 N1): the raw text,
 * and, when it parses, every decoded string at any depth (a `\u006b` escape
 * is still a token once the page parses it).
 */
export function carriesSessionToken(text: string): boolean {
  if (text.includes(SESSION_TOKEN_PREFIX)) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  for (const value of stringsIn(parsed)) {
    if (value.includes(SESSION_TOKEN_PREFIX)) return true;
  }
  return false;
}

/** Revokes the session a new sign-in replaces (point 3). Best effort: a failure here never fails the sign-in. */
async function revokePrevious(config: BffConfig, deps: BffDependencies, token: string): Promise<void> {
  try {
    const response = await deps.fetch(new URL(`${API_PREFIX}auth/sign-out`, config.apiOrigin).toString(), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    await response.body?.cancel();
  } catch {
    // The old session still expires on its own clock; nothing is logged.
  }
}

/**
 * Connection-level failures of a reused keep-alive socket, as Node's fetch
 * (undici) reports them: a `TypeError('fetch failed')` whose cause carries the
 * socket's code. A timeout or an abort is not one, and is never retried.
 */
const CONNECTION_RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);

export function isConnectionReset(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return [code, cause?.code].some((value) => typeof value === 'string' && CONNECTION_RESET_CODES.has(value));
}

/** The headers an upstream answer keeps (allowlisted), with the BFF's own on top. */
function answerHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return securityHeaders(headers);
}

/**
 * Builds the request handler. `config` is resolved lazily by the route (from
 * `webEnv()`, at the first request, never at module scope, which would break
 * `next build`); tests pass their own, and their own `fetch`.
 */
export function createBffHandler(resolveConfig: () => BffConfig, deps: BffDependencies) {
  return async function handle(request: Request): Promise<Response> {
    const config = resolveConfig();
    const method = request.method.toUpperCase();
    const incoming = request.headers;

    if (isNavigation(incoming)) return jsonAnswer(404, NOT_FOUND_BODY);

    const target = upstreamTarget(request.url);
    const destination = target === null ? null : upstreamUrl(config, target);
    if (target === null || destination === null) return jsonAnswer(404, NOT_FOUND_BODY);

    if (hasScopeHeader(incoming)) return jsonAnswer(400, SCOPE_HEADER_REJECTED_BODY);

    // The body is read (bounded) BEFORE the CSRF verdict, so "has a body" is
    // what arrived, never what Content-Length or Transfer-Encoding claimed
    // (D-L181 N5). Under Next every POST carries a body stream, even an empty
    // one, so a stream that yields no bytes is a bodyless request.
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (method !== 'GET' && method !== 'HEAD' && hasRequestBody(request)) {
      const declared = Number(incoming.get('content-length') ?? '0');
      const read = Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES ? null : await readBounded(request.body, MAX_REQUEST_BODY_BYTES);
      if (read === null) return jsonAnswer(413, PAYLOAD_TOO_LARGE_BODY);
      if (read.byteLength > 0) body = read;
    }

    if (!passesCsrf(method, incoming, config.webOrigin, body !== undefined)) return jsonAnswer(403, CSRF_REJECTED_BODY);

    const preSession = PRE_SESSION_ROUTES.has(target.route);
    const cookie: SessionCookie = readSessionCookie(incoming.get('cookie'), config.cookie);
    const bearer = cookie.kind === 'token' && !preSession ? cookie.token : null;

    const isSignOut = method === 'POST' && target.route === SIGN_OUT_ROUTE;
    const signOutCookies = isSignOut ? [clearSessionSetCookie(config.cookie)] : [];

    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
    const send = () =>
      deps.fetch(destination, {
        method,
        headers: upstreamHeaders(incoming, { bearer, forwardStubIdentity: config.forwardStubIdentity }),
        ...(body === undefined ? {} : { body }),
        cache: 'no-store',
        redirect: 'manual',
        signal,
      });

    let upstream: Response;
    try {
      upstream = await send();
    } catch (error) {
      // ONE retry, for a read only, when the pooled connection was reset
      // before any answer: the keep-alive race, where the API closes an idle
      // socket just as `fetch` reuses it (the demo's intermittent 502s). A
      // write is never repeated: the API may have acted on it.
      const retry = (method === 'GET' || method === 'HEAD') && !signal.aborted && isConnectionReset(error);
      try {
        if (!retry) throw error;
        upstream = await send();
      } catch {
        const answer = jsonAnswer(502, BAD_GATEWAY_BODY, signOutCookies);
        if (isSignOut) answer.headers.set('clear-site-data', '"cache"');
        return answer;
      }
    }

    const headers = answerHeaders(upstream);
    const cookieLines = [...signOutCookies];
    if (upstream.status === 401 && !preSession && !isSignOut) {
      cookieLines.push(clearSessionSetCookie(config.cookie));
      // "Go to sign-in" (I6), said only when the 401 means the browser is
      // signed out: a session cookie was presented and refused, or this
      // process runs jwt, where no cookie is no identity. In a stub-mode
      // process a cookieless 401 means "no stub identity" (a test or a
      // developer's header), and sending that page to sign-in would only
      // tear it down mid-render.
      if (cookie.kind === 'token' || !config.forwardStubIdentity) headers.set(SESSION_ENDED_HEADER, 'ended');
    }
    for (const line of cookieLines) headers.append('set-cookie', line);
    if (isSignOut) headers.set('clear-site-data', '"cache"');
    const refuse = async (): Promise<Response> => {
      await upstream.body?.cancel().catch(() => undefined);
      const answer = jsonAnswer(502, BAD_GATEWAY_BODY, cookieLines);
      if (isSignOut) answer.headers.set('clear-site-data', '"cache"');
      return answer;
    };

    if (method === 'HEAD' || nullBodyStatus(upstream.status)) {
      await upstream.body?.cancel();
      return new Response(null, { status: upstream.status, headers });
    }

    // A token route is ALWAYS buffered and inspected, whatever it says its
    // content type is (D-L181 B1). Any other non-JSON answer (an export, a
    // file) streams through untouched; any other JSON is buffered so it can
    // be checked for a token (N1).
    const issuesToken = method === 'POST' && TOKEN_ROUTES.has(target.route);
    if (!issuesToken && !isJsonType(upstream.headers.get('content-type'))) {
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    let bytes: Uint8Array<ArrayBuffer> | null;
    try {
      bytes = await readBounded(upstream.body, MAX_UPSTREAM_JSON_BYTES);
    } catch {
      bytes = null;
    }
    if (bytes === null) return refuse();

    if (issuesToken && upstream.ok) {
      const schema = ISSUED_SESSION[target.route];
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return refuse();
      }
      const issued = schema === undefined ? undefined : schema.safeParse(parsed);
      if (issued === undefined || !issued.success) return refuse();
      const { accessToken, expiresAt, user } = issued.data;
      const backupCodes = 'backupCodes' in issued.data ? issued.data.backupCodes : undefined;
      const maxAge = maxAgeUntil(new Date(expiresAt), deps.now());
      if (maxAge <= 0) return refuse();
      let setCookie: string;
      try {
        setCookie = sessionSetCookie(accessToken, maxAge, config.cookie);
      } catch {
        return refuse();
      }
      // Built from the allowlist, never by deleting keys from what arrived.
      const forBrowser = { expiresAt, user, ...(backupCodes === undefined ? {} : { backupCodes }) };
      bytes = new TextEncoder().encode(JSON.stringify(forBrowser));
      if (carriesSessionToken(new TextDecoder().decode(bytes))) return refuse();
      // One browser profile holds one session: the one this sign-in
      // replaces is ended, not orphaned (point 3, I10).
      if (cookie.kind === 'token' && cookie.token !== accessToken) {
        await revokePrevious(config, deps, cookie.token);
      }
      headers.append('set-cookie', setCookie);
      headers.set('content-type', 'application/json; charset=utf-8');
    } else if (carriesSessionToken(new TextDecoder().decode(bytes))) {
      // A token on any other answer, of any status, would reach page
      // JavaScript. The API has no such answer; if one ever appears, it
      // fails closed here (D-L181 N1).
      return refuse();
    }

    if (bytes.byteLength >= COMPRESS_MIN_BYTES && acceptsGzip(incoming.get('accept-encoding'))) {
      const compressed = await gzip(bytes);
      headers.set('content-encoding', 'gzip');
      headers.set('vary', 'accept-encoding');
      return new Response(new Uint8Array(compressed), { status: upstream.status, headers });
    }
    return new Response(bytes, { status: upstream.status, headers });
  };
}
