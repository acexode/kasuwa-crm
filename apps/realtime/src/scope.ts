import { UnknownSessionUserError, withTenantTransaction, type SessionIdentity } from '@kasuwa/db';
import type { Pool } from 'pg';

/**
 * A session's live scope, read the way the API reads it on every request
 * (apps/api `interceptInTenantTransaction`): inside a tenant transaction, so
 * RLS applies, with the programmes resolved from `user_programme` by
 * `withTenantTransaction`, and the session row re-read under RLS with explicit
 * tenant and user predicates. `app.resolve_session` (the one SECURITY DEFINER
 * read) only finds the identity; this is the second, independent check.
 *
 * Returns null for anything that is no longer a live session of an active user
 * (revoked, expired, disabled, removed), and never says which.
 */
export interface LiveScope {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly programmeIds: readonly string[];
  readonly expiresAt: Date;
}

export async function readLiveScope(
  pool: Pool,
  identity: SessionIdentity,
): Promise<LiveScope | null> {
  try {
    return await withTenantTransaction(
      pool,
      { tenantId: identity.tenantId, userId: identity.userId },
      async (tx) => {
        const live = await tx.query<{ expires_at: Date }>(
          `SELECT expires_at
             FROM auth_session
            WHERE id = $1
              AND tenant_id = $2
              AND user_id = $3
              AND revoked_at IS NULL
              AND expires_at > now()`,
          [identity.sessionId, identity.tenantId, identity.userId],
        );
        const row = live[0];
        if (row === undefined) return null;
        return {
          sessionId: identity.sessionId,
          tenantId: tx.session.tenantId,
          userId: tx.session.userId,
          programmeIds: [...tx.session.programmeIds],
          expiresAt: new Date(row.expires_at),
        };
      },
    );
  } catch (error) {
    if (error instanceof UnknownSessionUserError) return null;
    throw error;
  }
}

/** True when `current` still holds every programme `held` did: a lost one ends the socket. */
export function keepsEveryProgramme(
  held: ReadonlySet<string>,
  current: readonly string[],
): boolean {
  const now = new Set(current);
  for (const id of held) {
    if (!now.has(id)) return false;
  }
  return true;
}
