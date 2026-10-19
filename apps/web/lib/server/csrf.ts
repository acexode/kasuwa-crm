import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@kasuwa/config/session';

/**
 * CSRF FOR EVERY UNSAFE METHOD (ADR-0019 point 4). SERVER ONLY.
 *
 * Every request whose method is not GET, HEAD or OPTIONS must pass ALL of
 * these, with or without a session cookie. Unauthenticated routes are
 * included: sign-in and MFA are login-CSRF targets (an attacker signing the
 * victim into the attacker's tenant).
 *
 *   1. `Origin` string-equal to KASUWA_WEB_ORIGIN. Missing, `null`, a trailing
 *      slash, another scheme or port: refused. Compared with configuration,
 *      never with `Host` or `X-Forwarded-Host`, which a client or a
 *      misconfigured proxy can set. `Sec-Fetch-Site`, when present, must be
 *      exactly `same-origin`.
 *   2. `x-requested-with: kasuwa-web`, which only the web app's fetch wrapper
 *      sends. A cross-origin page can add a custom header only after a CORS
 *      preflight, and nothing at this origin answers one. This is the control
 *      that closes BODYLESS POSTs: a form or a `no-cors` fetch can send one
 *      without a preflight, but cannot add this header.
 *   3. A request with a body is `application/json`. text/plain, form and
 *      multipart are the three a cross-site form can send; a body with no
 *      type at all is refused too. A bodyless request needs no type.
 *
 * The verdict is a boolean on purpose: the caller answers every refusal with
 * one fixed body that names no check (I4), so there is nothing to report.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Whether the request carries a body: a positive `Content-Length`, or any
 * `Transfer-Encoding` (a chunked body has no length up front). A browser sends
 * `Content-Length: 0` on a bodyless POST.
 */
export function hasRequestBody(headers: Headers): boolean {
  if (headers.has('transfer-encoding')) return true;
  const length = headers.get('content-length');
  if (length === null) return false;
  return !/^\s*0+\s*$/.test(length);
}

/** `application/json`, with or without parameters (a charset), case-insensitive on the type. */
export function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const [type = ''] = value.split(';');
  return type.trim().toLowerCase() === 'application/json';
}

/** True when the request may proceed; false when it is refused as CSRF. */
export function passesCsrf(method: string, headers: Headers, webOrigin: string): boolean {
  if (isSafeMethod(method)) return true;
  if (headers.get('origin') !== webOrigin) return false;
  const site = headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return false;
  if (headers.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) return false;
  if (hasRequestBody(headers) && !isJsonContentType(headers.get('content-type'))) return false;
  return true;
}

/**
 * The one refusal body (I4): 403, a fixed code, and a message that names no
 * check. It never echoes anything the request carried.
 */
export const CSRF_REJECTED_BODY = Object.freeze({
  statusCode: 403,
  error: 'Forbidden',
  code: 'csrf_rejected',
  message: 'Request refused.',
});

/**
 * A top-level navigation to `/api/*` (point 1, I13). No screen navigates to
 * the API, and refusing it removes the one case in which a `Lax` cookie rides
 * a cross-site request.
 */
export function isNavigation(headers: Headers): boolean {
  return headers.get('sec-fetch-dest') === 'document' || headers.get('sec-fetch-mode') === 'navigate';
}
