import type { TenantTx } from '@kasuwa/db';
import { z } from 'zod';
import {
  canProgramme,
  canTenant,
  type Grants,
  type ProgrammeAction,
  type TenantAction,
} from './policy';

/**
 * Loads a session's grants from the database, inside the request's tenant
 * transaction - the impure half of the engine.
 *
 * Re-read on EVERY call, exactly as scope is (permissions acceptance M3): a
 * revoked flag or a changed set applies to the very next request. Nothing is
 * cached in the token, the session object or process memory.
 *
 * Who the user is comes from `tx.session` only. No argument here names a user,
 * a tenant or a programme list, so no caller can ask about anyone but itself.
 * Every statement repeats the tenant (and, for memberships, the resolved
 * programme scope) on top of RLS (CLAUDE.md 2.3).
 */

const UserRow = z.object({ is_tenant_admin: z.boolean() });
const MembershipRow = z.object({
  programme_id: z.string().uuid(),
  key: z.string().nullable(),
});

export async function loadGrants(tx: TenantTx): Promise<Grants> {
  const { tenantId, userId, programmeIds } = tx.session;

  // tenancy-reviewed: tenant_id + user id from the session, as well as RLS.
  // An inactive user has no session at all (withTenantTransaction), so status
  // is repeated here only as defence in depth.
  const users = await tx.query(
    `SELECT is_tenant_admin
       FROM "user"
      WHERE id = $1
        AND tenant_id = $2
        AND status = 'active'`,
    [userId, tenantId],
  );
  const user = users[0] === undefined ? undefined : UserRow.parse(users[0]);

  // tenancy-reviewed: tenant_id + user id + session programme ids, as well as
  // RLS. The set is joined on (tenant_id, id), the composite key 0015's FK uses.
  const memberships =
    programmeIds.length === 0
      ? []
      : await tx.query(
          `SELECT up.programme_id, ps.key
             FROM user_programme up
             LEFT JOIN permission_set ps
               ON ps.tenant_id = up.tenant_id
              AND ps.id = up.permission_set_id
            WHERE up.tenant_id = $1
              AND up.user_id = $2
              AND up.programme_id = ANY($3::uuid[])`,
          [tenantId, userId, [...programmeIds]],
        );

  const programmeSets = new Map<string, string | null>();
  for (const raw of memberships) {
    const row = MembershipRow.parse(raw);
    programmeSets.set(row.programme_id, row.key);
  }

  return {
    isTenantAdmin: user?.is_tenant_admin ?? false,
    reachableProgrammeIds: programmeIds,
    programmeSets,
  };
}

/** May this session perform a tenant-level write? Read fresh from the database. */
export async function mayTenant(tx: TenantTx, action: TenantAction): Promise<boolean> {
  return canTenant(await loadGrants(tx), action);
}

/**
 * May this session perform `action` in `programmeId`? Read fresh from the
 * database. False for a programme outside the session's scope, always.
 */
export async function mayProgramme(
  tx: TenantTx,
  action: ProgrammeAction,
  programmeId: string,
): Promise<boolean> {
  return canProgramme(await loadGrants(tx), action, programmeId);
}
