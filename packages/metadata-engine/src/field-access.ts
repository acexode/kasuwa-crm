import type { TenantTx } from '@kasuwa/db';
import { z } from 'zod';
import { apiNameSchema } from './api-name';
import {
  DEFAULT_FIELD_ACCESS_LEVEL,
  FIELD_ACCESS_LEVELS,
  fieldAccessLevelSchema,
  LOCKED_FIELD_ACCESS_LEVEL,
  type FieldAccessLevel,
} from './field-security';
import { UnknownObjectDefError } from './repository';

/**
 * What the CALLER may do with each field of one object, per programme it
 * reaches (T-0053; generalises T-0041's contact-only loader).
 *
 * The matrix (`field-security.ts`) says what each permission SET may do. This
 * answers the question a record read or write actually asks: for this session,
 * in programme P, is field F `none`, `read` or `edit`? The set that counts is
 * the one the session's user holds IN THAT PROGRAMME
 * (`user_programme.permission_set_id`, D-P9), so the answer is per programme.
 *
 * Semantics, unchanged from T-0026 / T-0041:
 *   - a stored decision for the held set wins;
 *   - a locked set (Admin) is always `edit`, whatever is stored;
 *   - a cell nobody saved is `edit` (D-L45);
 *   - a membership with NO set gets, per field, the weakest level any unlocked
 *     set has: having no set never sees more than having the weakest one;
 *   - a programme in the session's scope with no membership row in this read
 *     (revoked mid-request) is `none` for every field: FAIL CLOSED.
 *
 * FAILS CLOSED ON THE OBJECT TOO. An unknown object, another tenant's object
 * and a malformed name all reject with the same `UnknownObjectDefError` and
 * the same message, which names nothing. Rejecting, not returning an empty
 * map: an unsaved cell defaults to `edit`, so a caller reading "absent" as
 * "default" would fail open on an empty answer.
 *
 * Metadata is tenant-scoped, NOT programme-scoped (0002 header): the object
 * and its fields are the tenant's; only the memberships are per programme.
 */

/**
 * Programme id -> field api_name -> level.
 *
 * Read it with `fieldLevel`, not `.get()`: `.get()` answers `undefined` for a
 * programme or field the map does not carry, and a caller that treats
 * `undefined` as "no decision, so the D-L45 default" fails OPEN.
 */
export type FieldAccess = ReadonlyMap<string, ReadonlyMap<string, FieldAccessLevel>>;

/**
 * The caller's level for one field in one programme. Anything the access map
 * does not carry - a programme outside the session's scope, a field the object
 * does not have - is `none`: fail closed, never the default.
 */
export function fieldLevel(
  access: FieldAccess,
  programmeId: string,
  fieldApiName: string,
): FieldAccessLevel {
  return access.get(programmeId)?.get(fieldApiName) ?? 'none';
}

export interface FieldAccessGrant {
  fieldApiName: string;
  /** permission_set.id */
  permissionSetId: string;
  locked: boolean;
  level: FieldAccessLevel;
}

export interface FieldAccessMembership {
  programmeId: string;
  /** permission_set.id held in the programme, or null for none. */
  permissionSetId: string | null;
  /** Whether that set is locked. False when there is no set. */
  locked: boolean;
}

const RANK: Readonly<Record<FieldAccessLevel, number>> = Object.fromEntries(
  FIELD_ACCESS_LEVELS.map((level, index) => [level, index]),
) as Record<FieldAccessLevel, number>;

/**
 * The pure half of `loadFieldAccess`: every rule above, no database. One
 * entry per reachable programme, in the order given; each inner map has one
 * entry per field, keyed by api_name.
 */
export function resolveFieldAccess(input: {
  fieldApiNames: readonly string[];
  grants: readonly FieldAccessGrant[];
  memberships: readonly FieldAccessMembership[];
  reachableProgrammeIds: readonly string[];
}): FieldAccess {
  const stored = new Map<string, Map<string, FieldAccessGrant>>();
  for (const grant of input.grants) {
    const cells = stored.get(grant.fieldApiName) ?? new Map<string, FieldAccessGrant>();
    cells.set(grant.permissionSetId, grant);
    stored.set(grant.fieldApiName, cells);
  }
  const memberships = new Map(
    input.memberships.map((membership) => [membership.programmeId, membership]),
  );

  const access = new Map<string, Map<string, FieldAccessLevel>>();
  for (const programmeId of input.reachableProgrammeIds) {
    const membership = memberships.get(programmeId);
    const levels = new Map<string, FieldAccessLevel>();
    for (const field of input.fieldApiNames) {
      levels.set(
        field,
        membership === undefined ? 'none' : levelFor(membership, stored.get(field)),
      );
    }
    access.set(programmeId, levels);
  }
  return access;
}

function levelFor(
  membership: FieldAccessMembership,
  cells: ReadonlyMap<string, FieldAccessGrant> | undefined,
): FieldAccessLevel {
  if (membership.permissionSetId !== null) {
    if (membership.locked) return LOCKED_FIELD_ACCESS_LEVEL;
    return cells?.get(membership.permissionSetId)?.level ?? DEFAULT_FIELD_ACCESS_LEVEL;
  }
  // No set: never more than the weakest unlocked set. Unsaved cells of other
  // sets are the default, which is where the minimum starts.
  let weakest: FieldAccessLevel = DEFAULT_FIELD_ACCESS_LEVEL;
  for (const cell of cells?.values() ?? []) {
    if (!cell.locked && RANK[cell.level] < RANK[weakest]) weakest = cell.level;
  }
  return weakest;
}

// --- the loader -------------------------------------------------------------

const Row = z.object({
  fields: z.array(z.string()),
  grants: z.array(
    z.object({
      field: z.string(),
      set: z.string().uuid(),
      locked: z.boolean(),
      level: fieldAccessLevelSchema,
    }),
  ),
  memberships: z.array(
    z.object({
      programme: z.string().uuid(),
      set: z.string().uuid().nullable(),
      locked: z.boolean(),
    }),
  ),
});

/**
 * ONE round trip, as T-0041's contact loader was: every record list and get
 * pays for this, and auth-availability holds a contacts read to a latency
 * bound under a sign-in burst. The object is the FROM, so an object the
 * session cannot see yields no row at all; the three aggregates hang off it.
 *
 * tenancy-reviewed: tenant, user and programmes all from `tx.session`; every
 * join on (tenant_id, id) and every table filtered on tenant_id explicitly,
 * with RLS on each besides. The api_name is validated, then bound as a
 * parameter; it is never an identifier.
 */
const FIELD_ACCESS_SQL = `
  SELECT
    (SELECT coalesce(json_agg(f.api_name ORDER BY f.api_name), '[]'::json)
       FROM field_def f
      WHERE f.tenant_id = $1 AND f.object_id = o.id) AS fields,
    (SELECT coalesce(json_agg(json_build_object(
              'field', f.api_name, 'set', gs.id, 'locked', gs.locked, 'level', g.level)),
            '[]'::json)
       FROM field_security_grant g
       JOIN field_def f
         ON f.tenant_id = g.tenant_id AND f.id = g.field_id
       JOIN permission_set gs
         ON gs.tenant_id = g.tenant_id AND gs.id = g.permission_set_id
      WHERE g.tenant_id = $1 AND f.tenant_id = $1 AND f.object_id = o.id) AS grants,
    (SELECT coalesce(json_agg(json_build_object(
              'programme', up.programme_id, 'set', ps.id,
              'locked', coalesce(ps.locked, false))),
            '[]'::json)
       FROM user_programme up
       LEFT JOIN permission_set ps
         ON ps.tenant_id = up.tenant_id AND ps.id = up.permission_set_id
      WHERE up.tenant_id = $1
        AND up.user_id = $3
        AND up.programme_id = ANY ($4::uuid[])) AS memberships
    FROM object_def o
   WHERE o.tenant_id = $1 AND o.api_name = $2`;

/**
 * The session's field access for one object, per programme it reaches.
 * Rejects with `UnknownObjectDefError` for an object the session cannot see
 * or a name that could not be one; see the header.
 */
export async function loadFieldAccess(tx: TenantTx, objectApiName: string): Promise<FieldAccess> {
  return readFieldAccess(tx, objectApiName, tx.session.userId, tx.session.programmeIds);
}

/**
 * The shared read behind `loadFieldAccess` and the sub-path-only
 * `loadFieldAccessForUser` (./field-access-for-user.ts). Deliberately NOT in
 * the package barrel (index.ts names this file's exports one by one): it takes
 * a user id, so only the sub-path may reach it.
 */
export async function readFieldAccess(
  tx: TenantTx,
  objectApiName: string,
  userId: string,
  programmeIds: readonly string[],
): Promise<FieldAccess> {
  // Malformed names never reach the database, and fail exactly as an unknown
  // object does: the caller learns nothing from the difference.
  if (!apiNameSchema.safeParse(objectApiName).success) {
    throw new UnknownObjectDefError();
  }
  // tenancy-reviewed: tenant from the session; the user and programmes are the
  // caller's (`loadFieldAccess`: the session's own; `loadFieldAccessForUser`:
  // the user named, programmes clamped to the session's); RLS besides.
  const rows = await tx.query(FIELD_ACCESS_SQL, [
    tx.session.tenantId,
    objectApiName,
    userId,
    [...programmeIds],
  ]);
  const raw = rows[0];
  if (raw === undefined) {
    throw new UnknownObjectDefError();
  }
  const row = Row.parse(raw);
  return resolveFieldAccess({
    fieldApiNames: row.fields,
    grants: row.grants.map((grant) => ({
      fieldApiName: grant.field,
      permissionSetId: grant.set,
      locked: grant.locked,
      level: grant.level,
    })),
    memberships: row.memberships.map((membership) => ({
      programmeId: membership.programme,
      permissionSetId: membership.set,
      locked: membership.locked,
    })),
    reachableProgrammeIds: programmeIds,
  });
}
