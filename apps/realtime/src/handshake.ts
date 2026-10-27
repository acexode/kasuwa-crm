import type { IncomingHttpHeaders } from 'node:http';
import {
  FORBIDDEN_SCOPE_HEADERS,
  INSECURE_SESSION_COOKIE_NAME,
  SCOPE_HEADER_REJECTED_BODY,
  SESSION_COOKIE_NAME,
  STUB_TENANT_HEADER,
  STUB_USER_HEADER,
} from '@kasuwa/config';

/**
 * THE HANDSHAKE (T-0160, ADR-0020). Pure: headers in, a decision out.
 *
 * The credential is read at the HTTP Upgrade, before a socket exists, so a
 * refusal is an HTTP status and never a WebSocket frame. There are exactly two
 * transports:
 *
 *   - `Authorization: Bearer <token>` for a non-browser client;
 *   - the session cookie for a browser, accepted ONLY with an `Origin` equal to
 *     the one configured web origin. A WebSocket upgrade is not bound by the
 *     same-origin policy, so the Origin check is what stops another site from
 *     riding the cookie (cross-site WebSocket hijacking).
 *
 * Never a query-string token (it ends up in logs), never the stub identity
 * headers, never a Bearer and a cookie together (one request, two identities,
 * and neither is answered), and never the relaxed cookie name unless the
 * process was started with the development flag.
 *
 * EVERY refusal is one 401 with one body, whatever was wrong, and a scope
 * header is the same 400 the API gives (CLAUDE.md 2.2, 6.4).
 */

export const NOT_AUTHENTICATED_BODY = JSON.stringify({
  statusCode: 401,
  error: 'Unauthorized',
  code: 'not_authenticated',
  message: 'Not authenticated',
});

export interface HandshakeConfig {
  /** `REALTIME_ALLOWED_ORIGIN`. Unset: a cookie never authenticates. */
  readonly allowedOrigin: string | undefined;
  /** `KASUWA_SESSION_COOKIE_INSECURE=1`, development and test only. */
  readonly insecureCookie: boolean;
}

export type HandshakeDecision =
  | { readonly kind: 'accept'; readonly token: string }
  | { readonly kind: 'refuse'; readonly status: 400 | 401; readonly body: string };

const UNAUTHENTICATED: HandshakeDecision = {
  kind: 'refuse',
  status: 401,
  body: NOT_AUTHENTICATED_BODY,
};

/** The characters the API accepts in a Bearer token, so the two layers agree. */
const BEARER = /^Bearer (?<token>[A-Za-z0-9._~+/=-]{1,512})$/u;
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{1,512}$/;

/**
 * The session cookie, read by hand so a DUPLICATE is seen rather than silently
 * resolved: two cookies of the name cannot come from one browser profile, so
 * neither is believed. Mirrors `readSessionCookie` in the web app's BFF
 * (`apps/web/lib/server/session-cookie.ts`); apps cannot import each other.
 */
function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  const values: string[] = [];
  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals === -1) continue;
    if (part.slice(0, equals).trim() !== name) continue;
    values.push(part.slice(equals + 1).trim());
  }
  const [value = ''] = values;
  return values.length === 1 && TOKEN_SHAPE.test(value) ? value : null;
}

export function decideHandshake(
  headers: IncomingHttpHeaders,
  config: HandshakeConfig,
): HandshakeDecision {
  for (const header of FORBIDDEN_SCOPE_HEADERS) {
    if (headers[header] !== undefined) {
      return {
        kind: 'refuse',
        status: 400,
        body: JSON.stringify(SCOPE_HEADER_REJECTED_BODY),
      };
    }
  }

  // The stub identity is the API's development transport. Here it is no
  // credential, and a request carrying it with anything else is confused.
  if (headers[STUB_TENANT_HEADER] !== undefined || headers[STUB_USER_HEADER] !== undefined) {
    return UNAUTHENTICATED;
  }

  const cookieName = config.insecureCookie ? INSECURE_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
  const cookie = readCookie(headers.cookie, cookieName);
  const authorization = headers.authorization;

  if (authorization !== undefined) {
    if (cookie !== null || typeof authorization !== 'string') return UNAUTHENTICATED;
    const token = BEARER.exec(authorization.trim())?.groups?.token;
    return token === undefined ? UNAUTHENTICATED : { kind: 'accept', token };
  }

  if (cookie === null) return UNAUTHENTICATED;
  const origin = headers.origin;
  if (config.allowedOrigin === undefined || origin !== config.allowedOrigin) {
    return UNAUTHENTICATED;
  }
  return { kind: 'accept', token: cookie };
}
