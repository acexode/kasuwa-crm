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

export class ScopeHeaderRejectedError extends Error {
  constructor(header: string) {
    super(
      `Request carried ${header}; programme scope is resolved server-side and cannot be supplied`,
    );
    this.name = 'ScopeHeaderRejectedError';
  }
}
