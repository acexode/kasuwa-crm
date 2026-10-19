import { STUB_TENANT_HEADER, STUB_USER_HEADER } from '@kasuwa/config';
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

/**
 * The stub identity headers, the scope headers refused in every mode, and the
 * 400 body for a scope header (D-L63) live in `@kasuwa/config` since T-0125
 * (ADR-0019 point 1, D-L149 #8): the web app's BFF applies the same policy one
 * hop earlier and cannot import this app, so one shared definition keeps the
 * two layers from drifting. Re-exported here so the API's imports are
 * unchanged. The 400 body names no header and echoes no value.
 */
export {
  FORBIDDEN_SCOPE_HEADERS,
  SCOPE_HEADER_REJECTED_BODY,
  STUB_TENANT_HEADER,
  STUB_USER_HEADER,
} from '@kasuwa/config';

export const StubAuthHeaders = z.object({
  [STUB_TENANT_HEADER]: z.string().uuid(),
  [STUB_USER_HEADER]: z.string().uuid(),
});

export class ScopeHeaderRejectedError extends Error {
  constructor(header: string) {
    super(
      `Request carried ${header}; programme scope is resolved server-side and cannot be supplied`,
    );
    this.name = 'ScopeHeaderRejectedError';
  }
}
