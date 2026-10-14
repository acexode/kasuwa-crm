/**
 * Who a deal names: its owner and the user behind each requirement check
 * (D-P23, D-L127, T-0123).
 *
 * A person is named only while they have a `user_programme` row in THE DEAL'S
 * programme at the time of the read. The tenant-admin flag is not
 * membership, and neither is membership of another programme, even one the
 * reader also reaches. A non-member is a former owner or a former checker:
 * the id, and `displayName: null`. Re-added, they are named again, because
 * the test is made on every read and nothing is snapshotted.
 *
 * Both halves of the rule live here so that every deal read (the deals API
 * and the board) judges owners and checkers by the same test:
 *   - `dealProgrammeMember`, the SQL predicate, correlated on the row the
 *     statement already reads, so it adds no statement and is never a
 *     directory of anything the statement does not return;
 *   - `dealActorOf`, which turns the predicate's answer and the name read
 *     beside it into the wire actor.
 */

/** A deal actor on the wire: `DealActor` (records.openapi.yaml). */
export interface DealActor {
  id: string;
  displayName: string | null;
}

/**
 * The membership test in the deal's programme, as an `EXISTS` on
 * user_programme. Every argument is a SQL column reference chosen by the
 * caller's own statement (a constant), never input.
 *
 * tenancy-reviewed: keyed on the row's own tenant, the deal's programme and
 * the user; RLS on user_programme besides.
 */
export function dealProgrammeMember(
  alias: string,
  refs: { tenantId: string; programmeId: string; userId: string },
): string {
  return `EXISTS (
    SELECT 1 FROM user_programme ${alias}
     WHERE ${alias}.tenant_id = ${refs.tenantId}
       AND ${alias}.programme_id = ${refs.programmeId}
       AND ${alias}.user_id = ${refs.userId})`;
}

/**
 * A member of the deal's programme whose name could not be read.
 * user_programme's composite FK to "user" (0001) makes this impossible;
 * failing is better than serving a member as a former one. Carries no
 * identifier.
 */
export class DealActorUnresolvedError extends Error {
  constructor() {
    super('A deal actor who is a programme member could not be resolved to a user');
    this.name = 'DealActorUnresolvedError';
  }
}

/**
 * The actor from a user id, whether that user is a member of the deal's
 * programme (`dealProgrammeMember`), and the name read beside it. A
 * non-member is unnamed whatever name was read; `id` is always served.
 */
export function dealActorOf(
  userId: string,
  isMember: boolean | null,
  displayName: string | null,
): DealActor {
  if (isMember !== true) return { id: userId, displayName: null };
  if (displayName === null) throw new DealActorUnresolvedError();
  return { id: userId, displayName };
}
