import { z } from 'zod';

/**
 * The authenticated caller, as far as the API is concerned.
 *
 * Note what is NOT here: programme ids. The caller says who they are; the
 * database says what they can reach (see withTenantTransaction in @kasuwa/db).
 * If this interface ever grows a `programmeIds` field supplied by the client,
 * the tenancy model is broken — the header-forgery acceptance tests exist to
 * catch exactly that regression.
 */
export interface AuthContext {
  tenantId: string;
  userId: string;
  /**
   * The session this request was authenticated with, or null under the stub.
   *
   * Present so the request can be re-checked against `auth_session` inside the
   * tenant transaction — under RLS, with explicit tenant and user predicates —
   * rather than trusting the lookup the guard already did. That second check is
   * what makes revoking a session, or disabling a user, take effect on the very
   * next request instead of at token expiry.
   *
   * It is an identifier, not a capability. It says which session; it never says
   * what that session may reach.
   */
  sessionId: string | null;
}

export const STUB_TENANT_HEADER = 'x-kasuwa-tenant-id';
export const STUB_USER_HEADER = 'x-kasuwa-user-id';

/**
 * Headers a client might *try* to use to widen its own scope. The stub resolver
 * rejects any request carrying them rather than ignoring them silently: a
 * request that tries to set its own programme scope is either an attack or a
 * bug, and both deserve a 400 rather than a shrug.
 */
export const FORBIDDEN_SCOPE_HEADERS = [
  'x-kasuwa-programme-ids',
  'x-kasuwa-programme-id',
  'x-kasuwa-scope',
] as const;

export const StubAuthHeaders = z.object({
  [STUB_TENANT_HEADER]: z.string().uuid(),
  [STUB_USER_HEADER]: z.string().uuid(),
});

/**
 * The response body for a request carrying a scope header (D-L63): the shared
 * `Error` envelope, `400 validation_failed`, as `ValidationFailed` in
 * records.openapi.yaml lists it. The decision is unchanged; only the body is.
 * It names no header and echoes no value: the caller knows what it sent, and a
 * body that repeated it would put a forged scope into whatever logs bodies.
 */
export const SCOPE_HEADER_REJECTED_BODY = {
  statusCode: 400,
  error: 'Bad Request',
  code: 'validation_failed',
  message: 'Validation failed',
  details: [{ path: 'headers', code: 'scope_header_not_accepted' }],
} as const;

export class ScopeHeaderRejectedError extends Error {
  constructor(header: string) {
    super(
      `Request carried ${header}; programme scope is resolved server-side and cannot be supplied`,
    );
    this.name = 'ScopeHeaderRejectedError';
  }
}
