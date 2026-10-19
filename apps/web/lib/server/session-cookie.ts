import { INSECURE_SESSION_COOKIE_NAME, SESSION_COOKIE_NAME } from '@kasuwa/config/session';

/**
 * THE SESSION COOKIE (ADR-0019 point 2). SERVER ONLY.
 *
 * Its value is the API's opaque token, verbatim (ADR-0008): no second token,
 * no encryption layer. Its attributes are constants here, not configuration,
 * so no deployment can weaken them by mistake:
 *
 *   `__Host-kasuwa_session=<token>; Max-Age=<until expiresAt>; Path=/;
 *    HttpOnly; Secure; SameSite=Lax`
 *
 * and never a `Domain`. The one relaxation, KASUWA_SESSION_COOKIE_INSECURE=1,
 * drops `Secure` and the prefix (the name becomes `kasuwa_session`), and
 * `webEnv()` refuses it outside development and test (point 8).
 *
 * A process reads exactly ONE cookie name: the relaxed name never
 * authenticates where the flag is absent, so it can never outrank the
 * `__Host-` cookie (I11). A planted `kasuwa_session` is simply ignored.
 */

export interface CookieMode {
  /** KASUWA_SESSION_COOKIE_INSECURE=1, development and test only. */
  readonly insecure: boolean;
}

export function sessionCookieName(mode: CookieMode): string {
  return mode.insecure ? INSECURE_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
}

/**
 * The characters the API accepts in a Bearer token (`readBearerToken`), and a
 * length well above a real token's. A value outside it is not a token, and is
 * treated as no cookie at all rather than sent upstream.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{1,512}$/;

export type SessionCookie =
  | { readonly kind: 'none' }
  | { readonly kind: 'token'; readonly token: string };

/**
 * The session token in a `Cookie` header, read by hand rather than through a
 * jar so that duplicates are SEEN rather than silently resolved.
 *
 * Two or more cookies of the session name in one request cannot come from one
 * browser profile (a `__Host-` cookie is host-only with `Path=/`, so there is
 * exactly one slot for it); they come from a forged request or a tossed
 * cookie. Neither is answered with either session: the request goes upstream
 * with no credential, the API answers 401, and the cookie is cleared
 * (amendment 5: never mix tenants, never 5xx). An empty or malformed value is
 * no session too.
 */
export function readSessionCookie(cookieHeader: string | null, mode: CookieMode): SessionCookie {
  if (cookieHeader === null) return { kind: 'none' };
  const name = sessionCookieName(mode);
  const values: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const equals = part.indexOf('=');
    if (equals === -1) continue;
    if (part.slice(0, equals).trim() !== name) continue;
    values.push(part.slice(equals + 1).trim());
  }
  if (values.length !== 1) return { kind: 'none' };
  const [value = ''] = values;
  return TOKEN_SHAPE.test(value) ? { kind: 'token', token: value } : { kind: 'none' };
}

function attributes(mode: CookieMode): string {
  return mode.insecure ? 'Path=/; HttpOnly; SameSite=Lax' : 'Path=/; HttpOnly; Secure; SameSite=Lax';
}

/**
 * Seconds from `now` until `expiresAt`, never negative. The cookie dies with
 * the session, not after it (I7); a fraction of a second is rounded DOWN so
 * the cookie can never outlive the row.
 */
export function maxAgeUntil(expiresAt: Date, now: Date): number {
  return Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
}

/** The Set-Cookie line that stores a session. */
export function sessionSetCookie(token: string, maxAgeSeconds: number, mode: CookieMode): string {
  if (!TOKEN_SHAPE.test(token)) {
    // The API minted it; a token outside the shape is an upstream fault, and
    // a value with a `;` in it would forge attributes.
    throw new Error('session token has an unexpected shape');
  }
  return `${sessionCookieName(mode)}=${token}; Max-Age=${String(Math.max(0, Math.floor(maxAgeSeconds)))}; ${attributes(mode)}`;
}

/**
 * The Set-Cookie line that deletes it. A `__Host-` deletion is honoured only
 * with the same `Secure`, `Path=/` and no `Domain` (I5), so it carries the
 * same attributes; `Expires` in the past covers a browser that ignores
 * `Max-Age`.
 */
export function clearSessionSetCookie(mode: CookieMode): string {
  return `${sessionCookieName(mode)}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${attributes(mode)}`;
}
