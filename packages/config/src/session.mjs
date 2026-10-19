// @ts-check
/**
 * `@kasuwa/config/session` — the names and fixed bodies the API and the web
 * app's BFF must agree on (ADR-0019 point 1, D-L149 #8).
 *
 * Before T-0125 these lived in `apps/api/src/tenancy/auth-context.ts`. The BFF
 * now applies the same header policy one hop earlier, and `apps/web` cannot
 * import `apps/api`, so the policy moved to a shared-scope package both may
 * use. One definition, so the two layers cannot drift: a scope header the API
 * refuses is a scope header the BFF refuses, with the same body.
 *
 * THIS MODULE READS NOTHING, and imports only the pure `./guards.mjs`. It
 * holds no secret and no environment value, so it is safe in any process and in a browser bundle.
 * It is JavaScript for the same reason as `./schemas.mjs`: nothing between it
 * and a native `import()` may need a TypeScript loader.
 */

/**
 * The two stub identity headers (ADR-0007). The API accepts them only under
 * `KASUWA_AUTH_MODE=stub`, and the BFF forwards them only when the web process
 * itself runs stub (ADR-0019 point 7), which `webEnv()` refuses under
 * `NODE_ENV=production`.
 */
export const STUB_TENANT_HEADER = 'x-kasuwa-tenant-id';
export const STUB_USER_HEADER = 'x-kasuwa-user-id';

/**
 * Headers a client might TRY to use to widen its own scope. Refused, loudly,
 * in every mode and with or without a session: a request that sets its own
 * programme scope is an attack or a bug, and both deserve a 400 rather than a
 * shrug (CLAUDE.md 2.2).
 *
 * @type {readonly ['x-kasuwa-programme-ids', 'x-kasuwa-programme-id', 'x-kasuwa-scope']}
 */
export const FORBIDDEN_SCOPE_HEADERS = Object.freeze(
  /** @type {const} */ (['x-kasuwa-programme-ids', 'x-kasuwa-programme-id', 'x-kasuwa-scope']),
);

/**
 * The response body for a request carrying a scope header (D-L63): the shared
 * `Error` envelope, `400 validation_failed`. It names no header and echoes no
 * value: the caller knows what it sent, and a body that repeated it would put
 * a forged scope into whatever logs bodies.
 *
 * @type {Readonly<{
 *   statusCode: 400;
 *   error: 'Bad Request';
 *   code: 'validation_failed';
 *   message: 'Validation failed';
 *   details: readonly [Readonly<{ path: 'headers'; code: 'scope_header_not_accepted' }>];
 * }>}
 */
export const SCOPE_HEADER_REJECTED_BODY = Object.freeze({
  statusCode: 400,
  error: 'Bad Request',
  code: 'validation_failed',
  message: 'Validation failed',
  details: Object.freeze(/** @type {const} */ ([Object.freeze({ path: 'headers', code: 'scope_header_not_accepted' })])),
});

/**
 * The 404 for a path that matches no route (T-0121). The BFF answers a
 * top-level navigation to `/api/*` with exactly this (ADR-0019 point 1,
 * amendment 4), so the refusal is indistinguishable from a route that does
 * not exist. Key order matters: both sides serialise it with JSON.stringify.
 */
export const NOT_FOUND_BODY = Object.freeze({
  statusCode: 404,
  error: 'Not Found',
  code: 'not_found',
  message: 'Not found',
});

/**
 * The fixed 500 body (T-0036). The BFF answers an unreachable or misbehaving
 * API with it (as a 502), never with the upstream address or a stack.
 */
export const INTERNAL_ERROR_BODY = Object.freeze({
  statusCode: 500,
  error: 'Internal Server Error',
  code: 'internal_error',
  message: 'Something went wrong on our side. Please try again.',
});

/**
 * The CSRF request header the web app's single fetch wrapper sends on every
 * call (ADR-0019 point 4.2). A cross-origin page can only add a custom header
 * after a CORS preflight, and nothing at the web origin answers one.
 * Deliberately not `x-kasuwa-*`, which the BFF strips.
 */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'kasuwa-web';

/**
 * The session cookie (ADR-0019 point 2). The `__Host-` prefix makes the
 * browser refuse it unless it is `Secure`, `Path=/` and has no `Domain`.
 * The relaxed name exists only under `KASUWA_SESSION_COOKIE_INSECURE=1`,
 * which `webEnv()` refuses outside development and test.
 */
export const SESSION_COOKIE_NAME = '__Host-kasuwa_session';

/**
 * Every API session token starts with this (ADR-0008). The BFF refuses, as a
 * 502, any buffered answer that carries it outside the cookie (D-L181).
 */
export const SESSION_TOKEN_PREFIX = 'ksw_s1_';
export const INSECURE_SESSION_COOKIE_NAME = 'kasuwa_session';

/**
 * Loopback, as the session layer's boot guard decides it (127.0.0.0/8,
 * `localhost`, `[::1]`; never `127.0.0.1.evil.example`). Re-exported for the
 * web app's CSP, which omits `upgrade-insecure-requests` on loopback.
 */
export { isLoopbackHostname } from './guards.mjs';
