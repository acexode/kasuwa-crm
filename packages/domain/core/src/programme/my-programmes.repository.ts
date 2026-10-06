import type { TenantTx } from '@kasuwa/db';

/**
 * The caller's own programmes, with their display names (T-0043, D-L64).
 *
 * `listMyProgrammes` in records.openapi.yaml. A records screen may never print
 * a UUID, so it needs a name for every `programmeId` it shows, and it may only
 * learn the names of programmes the caller belongs to.
 *
 * SCOPE IS THE SESSION'S, TWICE OVER. The rows are the session user's
 * `user_programme` memberships (the user id comes from `tx.session`, never an
 * argument), AND each programme must be in `tx.session.programmeIds`, AND the
 * tenant is the session's on both tables; RLS on `user_programme` and
 * `programme` besides. Nothing here takes an argument but the transaction, so
 * nothing a caller sends can choose whose programmes are listed.
 *
 * THE TENANT-ADMIN FLAG IS NOT READ (D-L53). It decides admin writes, never
 * what a person can see: an admin gets their own memberships, like anyone.
 *
 * CLOSED SHAPE. `{ id, name }` only: `client_name` is the BPO's customer, a
 * separate and confidential fact, and is not selected at all, so no later
 * mapping slip can send it.
 */

export interface MyProgramme {
  id: string;
  name: string;
}

export async function listMyProgrammes(tx: TenantTx): Promise<MyProgramme[]> {
  // tenancy-reviewed: the session's tenant on both tables, the session's user
  // on the membership, and the session's resolved programme ids on both the
  // membership and the programme; RLS on both tables besides. Every value is a
  // bound parameter and none comes from the request.
  return tx.query<MyProgramme>(
    `SELECT p.id, p.name
       FROM user_programme up
       JOIN programme p
         ON p.tenant_id = up.tenant_id
        AND p.id = up.programme_id
      WHERE up.tenant_id = $1
        AND p.tenant_id = $1
        AND up.user_id = $2
        AND up.programme_id = ANY($3::uuid[])
        AND p.id = ANY($3::uuid[])
      ORDER BY p.name, p.id`,
    [tx.session.tenantId, tx.session.userId, [...tx.session.programmeIds]],
  );
}
