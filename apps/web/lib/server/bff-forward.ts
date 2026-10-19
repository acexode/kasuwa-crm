import { promisify } from 'node:util';
import { gzip as gzipCallback } from 'node:zlib';
import { z } from 'zod';
import { INTERNAL_ERROR_BODY, NOT_FOUND_BODY, SCOPE_HEADER_REJECTED_BODY } from '@kasuwa/config/session';
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

/** What the API's token-issuing 200 must look like before the BFF trusts it. Unknown keys (backup codes) pass through. */
const IssuedSession = z
  .object({
    accessToken: z.string().min(1),
    tokenType: z.string(),
    expiresAt: z.string().datetime({ offset: true }),
    user: z.object({ id: z.string(), tenantId: z.string() }).passthrough(),
  })
  .passthrough();

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

/** Reads at most `limit` bytes of a request body; null when it is larger. */
async function readBounded(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
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

    if (!passesCsrf(method, incoming, config.webOrigin)) return jsonAnswer(403, CSRF_REJECTED_BODY);

    const preSession = PRE_SESSION_ROUTES.has(target.route);
    const cookie: SessionCookie = readSessionCookie(incoming.get('cookie'), config.cookie);
    const bearer = cookie.kind === 'token' && !preSession ? cookie.token : null;

    let body: Uint8Array<ArrayBuffer> | undefined;
    if (method !== 'GET' && method !== 'HEAD' && hasRequestBody(incoming)) {
      const read = await readBounded(request, MAX_REQUEST_BODY_BYTES);
      if (read === null) return jsonAnswer(413, PAYLOAD_TOO_LARGE_BODY);
      body = read;
    }

    const isSignOut = method === 'POST' && target.route === SIGN_OUT_ROUTE;
    const signOutCookies = isSignOut ? [clearSessionSetCookie(config.cookie)] : [];

    let upstream: Response;
    try {
      upstream = await deps.fetch(destination, {
        method,
        headers: upstreamHeaders(incoming, { bearer, forwardStubIdentity: config.forwardStubIdentity }),
        ...(body === undefined ? {} : { body }),
        cache: 'no-store',
        redirect: 'manual',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
      });
    } catch {
      const answer = jsonAnswer(502, BAD_GATEWAY_BODY, signOutCookies);
      if (isSignOut) answer.headers.set('clear-site-data', '"cache"');
      return answer;
    }

    const headers = answerHeaders(upstream);
    for (const line of signOutCookies) headers.append('set-cookie', line);
    if (isSignOut) headers.set('clear-site-data', '"cache"');
    if (upstream.status === 401 && !preSession && !isSignOut) {
      headers.append('set-cookie', clearSessionSetCookie(config.cookie));
    }

    if (method === 'HEAD' || nullBodyStatus(upstream.status)) {
      await upstream.body?.cancel();
      return new Response(null, { status: upstream.status, headers });
    }

    const contentType = upstream.headers.get('content-type');
    if (!isJsonType(contentType)) {
      // Not JSON (an export, a file): streamed through untouched.
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = new Uint8Array(await upstream.arrayBuffer());
    } catch {
      return jsonAnswer(502, BAD_GATEWAY_BODY, signOutCookies);
    }

    if (upstream.ok) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        parsed = undefined;
      }
      const issuesToken = method === 'POST' && TOKEN_ROUTES.has(target.route);
      const carriesToken = typeof parsed === 'object' && parsed !== null && 'accessToken' in parsed;
      if (issuesToken) {
        const issued = IssuedSession.safeParse(parsed);
        if (!issued.success) return jsonAnswer(502, BAD_GATEWAY_BODY);
        const { accessToken } = issued.data;
        const forBrowser = Object.fromEntries(
          Object.entries(issued.data).filter(([key]) => key !== 'accessToken' && key !== 'tokenType'),
        );
        const maxAge = maxAgeUntil(new Date(issued.data.expiresAt), deps.now());
        if (maxAge <= 0) return jsonAnswer(502, BAD_GATEWAY_BODY);
        let setCookie: string;
        try {
          setCookie = sessionSetCookie(accessToken, maxAge, config.cookie);
        } catch {
          return jsonAnswer(502, BAD_GATEWAY_BODY);
        }
        // One browser profile holds one session: the one this sign-in
        // replaces is ended, not orphaned (point 3, I10).
        if (cookie.kind === 'token' && cookie.token !== accessToken) {
          await revokePrevious(config, deps, cookie.token);
        }
        headers.append('set-cookie', setCookie);
        bytes = new TextEncoder().encode(JSON.stringify(forBrowser));
      } else if (carriesToken) {
        // A token on any other route would reach page JavaScript. The API has
        // no such route; if one ever appears, it fails closed here.
        return jsonAnswer(502, BAD_GATEWAY_BODY);
      }
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
