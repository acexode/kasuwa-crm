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
 *   - `dealProgrammeMember` (an EXISTS) and `dealProgrammeMemberJoin` (a
 *     LEFT JOIN, the same three keys), correlated on the row the statement
 *     already reads, so they add no statement and are never a directory of
 *     anything the statement does not return;
 *   - `dealActorOf`, which turns the predicate's answer and the name read
 *     beside it into the wire actor.
 */

/** A deal actor on the wire: `DealActor` (records.openapi.yaml). */
export interface DealActor {
  id: string;
  displayName: string | null;
}

/** A column reference: `column` or `alias.column`, lower-case identifiers only. */
const COLUMN_REF = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/**
 * Refused: an argument to the membership SQL builders that is not a plain
 * column reference. They interpolate their arguments, so only constants
 * chosen by the caller's own statement may reach them, never input. Carries
 * no value.
 */
export class DealMembershipSqlError extends Error {
  constructor() {
    super('A deal membership predicate was given something other than a column reference');
    this.name = 'DealMembershipSqlError';
  }
}

export interface DealMembershipRefs {
  tenantId: string;
  programmeId: string;
  userId: string;
}

/** The three keys of the membership test, every argument checked first. */
function membershipKeys(alias: string, refs: DealMembershipRefs): string {
  for (const ref of [alias, refs.tenantId, refs.programmeId, refs.userId]) {
    if (!COLUMN_REF.test(ref)) throw new DealMembershipSqlError();
  }
  if (alias.includes('.')) throw new DealMembershipSqlError();
  return `${alias}.tenant_id = ${refs.tenantId}
       AND ${alias}.programme_id = ${refs.programmeId}
       AND ${alias}.user_id = ${refs.userId}`;
}

/**
 * The membership test in the deal's programme, as an `EXISTS` on
 * user_programme (the owner's form). Every argument must be a column
 * reference (`DealMembershipSqlError` otherwise).
 *
 * tenancy-reviewed: keyed on the row's own tenant, the deal's programme and
 * the user; RLS on user_programme besides.
 */
export function dealProgrammeMember(alias: string, refs: DealMembershipRefs): string {
  return `EXISTS (
    SELECT 1 FROM user_programme ${alias}
     WHERE ${membershipKeys(alias, refs)})`;
}

/**
 * The same test as a `LEFT JOIN` (the checkers' form), so a statement that
 * needs both the flag and the guarded name probes user_programme once per
 * row: at most one row joins, by the PK (user_id, programme_id). The member
 * flag is then `dealProgrammeMemberFlag(alias)`.
 *
 * tenancy-reviewed: the same three keys as `dealProgrammeMember`.
 */
export function dealProgrammeMemberJoin(alias: string, refs: DealMembershipRefs): string {
  return `LEFT JOIN user_programme ${alias}
      ON ${membershipKeys(alias, refs)}`;
}

/** Whether `dealProgrammeMemberJoin`'s row was found. */
export function dealProgrammeMemberFlag(alias: string): string {
  if (!COLUMN_REF.test(alias) || alias.includes('.')) throw new DealMembershipSqlError();
  return `(${alias}.user_id IS NOT NULL)`;
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
