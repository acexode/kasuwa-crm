import type { TenantTx } from '@kasuwa/db';
import { readFieldAccess, type FieldAccess } from './field-access';

/**
 * ANOTHER user's field access for one object (T-0100, D-L174). A SUB-PATH
 * export (`@kasuwa/metadata-engine/field-access-for-user`) for
 * `@kasuwa/domain-core` only: it is off the package barrel and apps are
 * lint-banned from the sub-path.
 *
 * The one deliberate exception to "no argument names a user": the
 * notifications consumer runs as the ACTOR of an event and must judge what the
 * RECIPIENT may read before it writes them a row, because "you were assigned
 * X" must not reveal a field the recipient's set withholds (D-L157). It is the
 * same read `loadFieldAccess` does, under the caller's own RLS.
 *
 * THE PROGRAMMES ARE CLAMPED to `tx.session.programmeIds`: a programme the
 * session does not reach is never asked about, whatever the caller passes, so
 * this cannot be turned into a probe of another programme's memberships. A
 * user with no membership in a programme gets `none` for every field there
 * (fail closed). Never call it with an id that came from a request.
 */
export async function loadFieldAccessForUser(
  tx: TenantTx,
  objectApiName: string,
  userId: string,
  programmeIds: readonly string[],
): Promise<FieldAccess> {
  const reachable = new Set(tx.session.programmeIds);
  return readFieldAccess(
    tx,
    objectApiName,
    userId,
    programmeIds.filter((id) => reachable.has(id)),
  );
}
