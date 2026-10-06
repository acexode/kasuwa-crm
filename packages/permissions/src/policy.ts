/**
 * What a session may DO - the pure half of the permissions engine (M2, T-0032).
 *
 * What a session may SEE is not this file: that is RLS plus `withTenantTransaction`,
 * which resolves programme scope from `user_programme` (D-L06). Nothing here
 * widens scope. Every decision about a programme starts by asking whether the
 * programme is already in the session's resolved scope, and answers "no" if it
 * is not - a tenant admin included. (The caller still answers an unreachable
 * programme with 404 before it ever asks this; the scope test here is the
 * second, independent layer, CLAUDE.md 2.3.)
 *
 * The model, per team/DECISIONS.md D-L53:
 *
 *   - TENANT-LEVEL actions need the tenant-admin flag on the user
 *     (`"user".is_tenant_admin`). No permission set grants one - not even
 *     `admin` held in every programme.
 *   - PROGRAMME-SCOPED actions need the `admin` set in THAT programme
 *     (`user_programme.permission_set_id`), or the tenant-admin flag - and
 *     always only inside a programme the session can reach.
 *   - Every other set is read-only for admin writes this round.
 *
 * No I/O here, so every rule is unit-testable; `grants.ts` loads the inputs.
 */

/** Writes that belong to the whole tenant (D-L53). */
export const TENANT_ACTIONS = [
  /** createProgramme. D-L40: a programme admin must not probe sibling names. */
  'programme.create',
  /** updateProgramme. D-L40, same reason. */
  'programme.update',
  /** createRole, updateRole, deleteRole, updateRoleHierarchy. */
  'role.write',
  /** updateFieldSecurityMatrix. */
  'field_security.write',
  /** createAuditExport. */
  'audit.export',
] as const;

/** Writes inside one programme (D-L53). */
export const PROGRAMME_ACTIONS = [
  /** archiveProgramme. */
  'programme.archive',
  /** create/update/delete/reorderDisposition(s). */
  'disposition.write',
  /** invitePortalUser. */
  'portal_user.invite',
  /** updateProgrammeSla, updateProgrammeRetention. */
  'programme_policy.write',
  /**
   * createContact and updateContact (T-0041, D-L63), in the TARGET programme:
   * the record's programme on update, `programmeId` on create. Every set but
   * `admin` is read-only for contacts this round (D-P14 is open).
   */
  'contact.write',
] as const;

export type TenantAction = (typeof TENANT_ACTIONS)[number];
export type ProgrammeAction = (typeof PROGRAMME_ACTIONS)[number];

/**
 * The key of the seeded, locked `admin` permission set. Matched by key, not by
 * the `locked` flag: a set someone else marks locked is not thereby an admin
 * set, and `(tenant_id, key)` is unique, so there is exactly one per tenant.
 */
export const ADMIN_PERMISSION_SET_KEY = 'admin';

/**
 * What each permission set permits, by key. A key that is not listed - or a
 * NULL set - permits nothing. Deliberately an allow-list: a new set grants
 * nothing until somebody writes it down here.
 */
const SET_PERMITS: Readonly<Record<string, readonly ProgrammeAction[]>> = {
  [ADMIN_PERMISSION_SET_KEY]: PROGRAMME_ACTIONS,
};

/** Everything a decision needs, resolved from the database for one request. */
export interface Grants {
  /** `"user".is_tenant_admin` for the session's user. */
  readonly isTenantAdmin: boolean;
  /** The session's resolved scope (from `user_programme`, never the caller). */
  readonly reachableProgrammeIds: readonly string[];
  /**
   * Programme id -> the key of the set held there, or null for a membership
   * with no set. Only programmes in `reachableProgrammeIds` are consulted.
   */
  readonly programmeSets: ReadonlyMap<string, string | null>;
}

export function canTenant(grants: Grants, _action: TenantAction): boolean {
  return grants.isTenantAdmin;
}

export function canProgramme(
  grants: Grants,
  action: ProgrammeAction,
  programmeId: string,
): boolean {
  // D-L06: a permission is never a scope. Unreachable means no, whoever asks.
  if (!grants.reachableProgrammeIds.includes(programmeId)) {
    return false;
  }
  if (grants.isTenantAdmin) {
    return true;
  }
  const key = grants.programmeSets.get(programmeId) ?? null;
  if (key === null) {
    return false;
  }
  const permitted = Object.prototype.hasOwnProperty.call(SET_PERMITS, key)
    ? SET_PERMITS[key]
    : undefined;
  return permitted?.includes(action) ?? false;
}
