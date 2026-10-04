import type { TenantTx } from '@kasuwa/db';
import { z } from 'zod';
import {
  resolveContactFieldAccess,
  type ContactFieldAccess,
  type ContactFieldLevel,
  type ContactMatrixRow,
} from './contact-fields';

/**
 * Loads the caller's contact field access in ONE round trip (T-0041).
 *
 * The inputs are the T-0026 matrix's own tables, read with its semantics
 * (`effectiveLevel` in metadata-engine): a stored `field_security_grant` for
 * the `contact` object, a locked set always `edit`, and anything unsaved
 * `edit` (D-L45). Plus the set the session user holds in each programme it
 * reaches (`user_programme.permission_set_id`, D-P9).
 *
 * Why one statement rather than metadata-engine's matrix read plus the
 * permissions engine's membership read: every list and get pays for it, and
 * auth-availability holds a contacts read to a latency bound on a
 * two-connection pool under a sign-in burst. Four extra round trips per read
 * missed that bound; one does not. The semantics are pinned by the unit tests
 * of `resolveContactFieldAccess` and by the T-0041 field-security suite.
 *
 * tenancy-reviewed: tenant and user from `tx.session`, programmes limited to
 * the session's resolved scope, every join on (tenant_id, id), and RLS on
 * every table besides. The grants subquery is uncorrelated, so Postgres runs it
 * once per statement, not once per membership.
 */

const LEVEL = z.enum(['none', 'read', 'edit']);

const Row = z.object({
  programme_id: z.string().uuid(),
  set_key: z.string().nullable(),
  grants: z.array(
    z.object({
      field: z.string(),
      set: z.string(),
      locked: z.boolean(),
      level: LEVEL,
    }),
  ),
});

export async function loadContactFieldAccess(tx: TenantTx): Promise<ContactFieldAccess> {
  const { tenantId, userId, programmeIds } = tx.session;
  if (programmeIds.length === 0) {
    return resolveContactFieldAccess({
      programmeSets: new Map(),
      reachableProgrammeIds: [],
      matrix: null,
    });
  }
  const raw = await tx.query(
    `SELECT up.programme_id,
            ps.key AS set_key,
            (SELECT coalesce(json_agg(json_build_object(
                      'field', f.api_name, 'set', gs.key,
                      'locked', gs.locked, 'level', g.level)), '[]'::json)
               FROM field_security_grant g
               JOIN field_def f
                 ON f.tenant_id = g.tenant_id AND f.id = g.field_id
               JOIN object_def o
                 ON o.tenant_id = f.tenant_id AND o.id = f.object_id AND o.api_name = 'contact'
               JOIN permission_set gs
                 ON gs.tenant_id = g.tenant_id AND gs.id = g.permission_set_id
              WHERE g.tenant_id = $1) AS grants
       FROM user_programme up
       LEFT JOIN permission_set ps
         ON ps.tenant_id = up.tenant_id AND ps.id = up.permission_set_id
      WHERE up.tenant_id = $1
        AND up.user_id = $2
        AND up.programme_id = ANY($3::uuid[])`,
    [tenantId, userId, [...programmeIds]],
  );
  const rows = raw.map((row) => Row.parse(row));

  const programmeSets = new Map<string, string | null>();
  for (const row of rows) programmeSets.set(row.programme_id, row.set_key);

  const byField = new Map<string, ContactMatrixRow['cells'][number][]>();
  for (const grant of rows[0]?.grants ?? []) {
    const cells = byField.get(grant.field) ?? [];
    // A locked set is always edit, whatever is stored (LOCKED_FIELD_ACCESS_LEVEL).
    const level: ContactFieldLevel = grant.locked ? 'edit' : grant.level;
    cells.push({ permissionSetId: grant.set, level, locked: grant.locked });
    byField.set(grant.field, cells);
  }
  const matrix: ContactMatrixRow[] = [...byField].map(([fieldApiName, cells]) => ({
    fieldApiName,
    cells,
  }));

  return resolveContactFieldAccess({
    programmeSets,
    reachableProgrammeIds: programmeIds,
    matrix,
  });
}
