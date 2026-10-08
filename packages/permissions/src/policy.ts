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
 *   - Every other set is read-only for admin writes this round. The
 *     exceptions: D-P14 gives `agent` `contact.claim_and_set_status`, a
 *     field-limited contact update (`canUpdateContact`), and since D-P18 so
 *     do `team_lead` and `programme_manager` (T-0077); D-P18 (T-0061) gives
 *     `agent`, `team_lead` and `programme_manager` `activity.write`, and
 *     `team_lead` and `programme_manager` also `activity.reassign`
 *     (`canWriteActivity`).
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
   * the record's programme on update, `programmeId` on create. Held by
   * `admin` only; `agent`, `team_lead` and `programme_manager` hold the
   * narrow grant below and nothing more.
   */
  'contact.write',
  /**
   * D-P14 (answered 2026-10-04): updateContact limited to `status`, and to
   * `ownerUserId` set to the caller's OWN user id, in the record's programme.
   * Never create, never another field, never another owner, never clearing
   * the owner. Which bodies it covers is `contactUpdateWithinClaim`; the whole
   * decision is `canUpdateContact`. Held by `agent` and, since D-P18
   * (answered 2026-10-06, T-0077), by `team_lead` and `programme_manager`.
   * Implied by `admin`, as every programme action is.
   */
  'contact.claim_and_set_status',
  /**
   * createAccount and updateAccount (T-0055), in the TARGET programme: the
   * record's programme on update, `programmeId` on create. Held by `admin`
   * only (D-L69; D-P18 answered 2026-10-06: account writes stay admin-only).
   * No other set holds it, and no narrow grant exists: the agent's D-P14
   * contact rights do not carry over to accounts.
   */
  'account.write',
  /**
   * D-P18 (answered 2026-10-06), T-0061: createActivity and updateActivity in
   * the ACTIVITY'S programme (its target's, on create): log a note, a task or
   * a call, and complete a task. Held by `agent`, `team_lead`,
   * `programme_manager` and `admin`, and by the tenant-admin flag. Giving an
   * activity to anyone but the caller also needs `activity.reassign`.
   */
  'activity.write',
  /**
   * D-L81 (D-P14's rule, carried to activities): set an activity's owner to
   * any member of its programme, or clear it. Held by `team_lead`,
   * `programme_manager` and `admin`, and by the tenant-admin flag. The `agent`
   * set may only take an activity itself.
   */
  'activity.reassign',
  /**
   * D-L88, D-L91 (T-0113): author the programme's in-call scripts - read a
   * script and its versions, edit the draft, translate it, publish it
   * (docs/api/scripting.openapi.yaml). Held by `admin` only, and by the
   * tenant-admin flag. Reading authoring needs it too: anyone else gets 404.
   * Running a published script is `script.run`, which T-0114 adds.
   */
  'script.write',
] as const;

export type TenantAction = (typeof TENANT_ACTIONS)[number];
export type ProgrammeAction = (typeof PROGRAMME_ACTIONS)[number];

/**
 * The key of the seeded, locked `admin` permission set. Matched by key, not by
 * the `locked` flag: a set someone else marks locked is not thereby an admin
 * set, and `(tenant_id, key)` is unique, so there is exactly one per tenant.
 */
export const ADMIN_PERMISSION_SET_KEY = 'admin';

/** The key of the seeded `agent` permission set (D-P14), matched by key like `admin`. */
export const AGENT_PERMISSION_SET_KEY = 'agent';

/** The seeded supervisory sets (D-P18), matched by key like `admin`. */
export const TEAM_LEAD_PERMISSION_SET_KEY = 'team_lead';
export const PROGRAMME_MANAGER_PERMISSION_SET_KEY = 'programme_manager';

/**
 * What each permission set permits, by key. A key that is not listed - or a
 * NULL set - permits nothing. Deliberately an allow-list: a new set grants
 * nothing until somebody writes it down here.
 */
const SET_PERMITS: Readonly<Record<string, readonly ProgrammeAction[]>> = {
  [ADMIN_PERMISSION_SET_KEY]: PROGRAMME_ACTIONS,
  // D-P14: an agent works its queue (status, and taking a record) and does
  // not rewrite customer data. D-P18: it logs and completes activities, and
  // may take one itself, never hand one to somebody else (D-L81). A
  // supervisor has at least the agent's rights (D-P18, T-0077), and also
  // reassigns activities (D-L81). Every other set stays read-only (D-L53).
  [AGENT_PERMISSION_SET_KEY]: ['contact.claim_and_set_status', 'activity.write'],
  [TEAM_LEAD_PERMISSION_SET_KEY]: [
    'contact.claim_and_set_status',
    'activity.write',
    'activity.reassign',
  ],
  [PROGRAMME_MANAGER_PERMISSION_SET_KEY]: [
    'contact.claim_and_set_status',
    'activity.write',
    'activity.reassign',
  ],
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

/**
 * The updateContact properties `contact.claim_and_set_status` may carry
 * (D-P14), plus `version`, which is the concurrency token and writes nothing.
 * Wire names, as the request body spells them.
 */
const CLAIM_AND_STATUS_KEYS: ReadonlySet<string> = new Set(['version', 'status', 'ownerUserId']);

/**
 * Whether an updateContact body stays inside `contact.claim_and_set_status`:
 * a plain object naming no property but `version`, `status` and `ownerUserId`,
 * where `ownerUserId`, if sent, is the caller's own user id. `null` (clearing
 * the owner) and anybody else's id are outside it.
 *
 * Judged on the RAW body, before validation, so a body outside the grant is
 * `403` whatever its values (D-L53: an unpermitted caller learns nothing from
 * validation). Anything that is not a plain object is outside it too. The
 * values of `status` and `version` are not decided here; the caller validates
 * them afterwards and answers `400`, as it does for any permitted writer.
 *
 * UUIDs compare case-insensitively: the caller's own id in upper case is
 * still the caller.
 */
export function contactUpdateWithinClaim(body: unknown, callerUserId: string): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  for (const [key, value] of Object.entries(body)) {
    if (!CLAIM_AND_STATUS_KEYS.has(key)) return false;
    if (
      key === 'ownerUserId' &&
      (typeof value !== 'string' || value.toLowerCase() !== callerUserId.toLowerCase())
    ) {
      return false;
    }
  }
  return true;
}

/**
 * May this session apply this updateContact body to a record in `programmeId`?
 * Yes with `contact.write` there, whatever the body; otherwise only with
 * `contact.claim_and_set_status` there AND a body inside that grant. A body
 * mixing an allowed field with any other is refused whole (D-P14).
 *
 * `callerUserId` must be the session's user (`tx.session.userId`), never a
 * value from the request. Field security is a separate, later check: this
 * answers the action, not the field (D-L63).
 */
export function canUpdateContact(
  grants: Grants,
  programmeId: string,
  callerUserId: string,
  body: unknown,
): boolean {
  if (canProgramme(grants, 'contact.write', programmeId)) return true;
  return (
    canProgramme(grants, 'contact.claim_and_set_status', programmeId) &&
    contactUpdateWithinClaim(body, callerUserId)
  );
}

/**
 * Whether an activity write body gives the activity to somebody other than
 * the caller: it names `ownerUserId` (as an own property) with anything but
 * the caller's own id. On update, `null` (clearing the owner) counts: it takes
 * the activity off whoever holds it. On create there is no holder yet, so
 * `allowNull` lets an unowned activity through.
 *
 * Judged on the RAW body, before validation, as `contactUpdateWithinClaim` is,
 * so an agent's attempt is `403` whatever the value. A body that is not a
 * plain object assigns nothing (the schema answers it `400`). UUIDs compare
 * case-insensitively: the caller's own id in upper case is still the caller.
 */
export function activityBodyAssignsOther(
  body: unknown,
  callerUserId: string,
  allowNull = false,
): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  if (!Object.prototype.hasOwnProperty.call(body, 'ownerUserId')) return false;
  const value: unknown = (body as Record<string, unknown>).ownerUserId;
  if (value === null) return !allowNull;
  return typeof value !== 'string' || value.toLowerCase() !== callerUserId.toLowerCase();
}

/**
 * May this session write this activity body (createActivity or
 * updateActivity) in `programmeId`, the activity's programme?
 * `activity.write` there always; and when the body gives the activity to
 * anyone but the caller, `activity.reassign` there too (D-L81: the `agent`
 * set may set the owner to itself only; `team_lead`, `programme_manager`,
 * `admin` and the tenant-admin flag may assign any member).
 *
 * `callerUserId` must be the session's user (`tx.session.userId`), never a
 * value from the request. Whether the owner is a member of the programme
 * (D-L67) and field security are separate, later checks.
 */
export function canWriteActivity(
  grants: Grants,
  programmeId: string,
  callerUserId: string,
  body: unknown,
  mode: 'create' | 'update',
): boolean {
  if (!canProgramme(grants, 'activity.write', programmeId)) return false;
  return (
    !activityBodyAssignsOther(body, callerUserId, mode === 'create') ||
    canProgramme(grants, 'activity.reassign', programmeId)
  );
}
