import { FORBIDDEN_SCOPE_HEADERS, STUB_TENANT_HEADER, STUB_USER_HEADER } from '@kasuwa/config/session';

/**
 * WHICH REQUEST HEADERS CROSS THE BFF (ADR-0019 point 1). SERVER ONLY.
 *
 * An ALLOWLIST, never a denylist. A header the browser sends reaches the API
 * only if it is named here; everything else is dropped, including any
 * browser-supplied `authorization` and `cookie`. The browser path is
 * cookie-only, and the BFF alone turns the cookie into a Bearer token. A
 * denylist would let the next identity-shaped header somebody invents walk
 * straight through.
 *
 * `x-kasuwa-*`:
 *   - a SCOPE header is refused before anything is forwarded (`hasScopeHeader`,
 *     answered with the API's own 400; ADR-0007 property 2, CLAUDE.md 2.2);
 *   - the two STUB IDENTITY headers are forwarded only when this web process
 *     itself runs `KASUWA_AUTH_MODE=stub` (point 7), which `webEnv()` refuses
 *     under `NODE_ENV=production`;
 *   - every other one is dropped silently, by not being on the list.
 *
 * `content-length` is not copied: the BFF sends the body it read and lets
 * `fetch` state its length. `x-forwarded-for` is copied verbatim so the API's
 * sign-in throttle keys on the same client chain it saw through the old
 * rewrite (point 9); the API decides how many hops to believe.
 */
export const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'if-match',
  'idempotency-key',
  'x-forwarded-for',
] as const;

/** Whether the request names its own programme scope. Presence is the test; the value is never read. */
export function hasScopeHeader(incoming: Headers): boolean {
  return FORBIDDEN_SCOPE_HEADERS.some((name) => incoming.has(name));
}

export interface UpstreamIdentity {
  /** The session token from the cookie, sent as Bearer; null sends no credential. */
  readonly bearer: string | null;
  /** True only in a web process whose own KASUWA_AUTH_MODE is `stub`. */
  readonly forwardStubIdentity: boolean;
}

/**
 * The headers the API receives. Built from nothing, then filled from the
 * allowlist, so an omission here can only ever drop a header, never leak one.
 */
export function upstreamHeaders(incoming: Headers, identity: UpstreamIdentity): Headers {
  const out = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value !== null) out.set(name, value);
  }
  if (identity.forwardStubIdentity) {
    for (const name of [STUB_TENANT_HEADER, STUB_USER_HEADER]) {
      const value = incoming.get(name);
      if (value !== null) out.set(name, value);
    }
  }
  if (identity.bearer !== null) {
    out.set('authorization', `Bearer ${identity.bearer}`);
  }
  return out;
}

/**
 * Which upstream response headers reach the browser. Also an allowlist: the
 * API's framing headers (`content-length`, `content-encoding`,
 * `transfer-encoding`, `connection`) describe a body the BFF re-frames, and
 * anything else the API might one day add (a `set-cookie`, a server banner)
 * stays on the server side unless it is named here. `cache-control` is never
 * copied: the BFF sets its own (point 1).
 */
export const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'content-language',
  'etag',
  'last-modified',
  'retry-after',
] as const;
