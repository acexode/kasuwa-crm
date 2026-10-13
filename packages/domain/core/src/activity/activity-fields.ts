import type { TenantTx } from '@kasuwa/db';
import { loadFieldAccess } from '@kasuwa/metadata-engine';

/**
 * Field security for activities (T-0061; the contact rules of T-0041/T-0053,
 * D-L63, applied to the `activity` object 0027 catalogued).
 *
 * The level that counts is the one the caller holds in the ACTIVITY'S
 * programme (its target's programme: the composite keys of 0027 keep a
 * target in the activity's own programme). `none` withholds (omitted, never
 * nulled, and named in `withheldFields`), `read` reads but may not be
 * written (403 `field_not_editable`), `edit` does both. The tenant-admin flag
 * does not lift it (D-L63).
 *
 * `type` is NOT withholdable on the wire: an activity without its type is
 * not an activity a screen can draw, so it is always sent, as a contact's
 * `displayName` is. Its matrix row still decides whether it may be WRITTEN.
 *
 * Pure apart from `loadActivityFieldAccess`, which is one round trip through
 * the generic loader.
 */

export type ActivityFieldLevel = 'none' | 'read' | 'edit';

/** The Activity properties field security may withhold, as wire names. */
export const WITHHOLDABLE_ACTIVITY_FIELDS = [
  'subject',
  'body',
  'dueAt',
  'completedAt',
  // A meeting's times (0034, T-0082): `starts_at` and `ends_at` in the matrix.
  'startsAt',
  'endsAt',
  'ownerUserId',
  'contactId',
  'accountId',
  // The deal link (0037, T-0111): `deal_id` in the matrix (R5).
  'dealId',
] as const;

export type WithholdableActivityField = (typeof WITHHOLDABLE_ACTIVITY_FIELDS)[number];

/** Every Activity property the matrix governs (withholdable, plus `type`, which only edit judges). */
export const SECURED_ACTIVITY_FIELDS = ['type', ...WITHHOLDABLE_ACTIVITY_FIELDS] as const;

export type SecuredActivityField = (typeof SECURED_ACTIVITY_FIELDS)[number];

const SECURED = new Set<string>(SECURED_ACTIVITY_FIELDS);

export function isSecuredActivityField(name: string): name is SecuredActivityField {
  return SECURED.has(name);
}

/** The matrix's `field_def.api_name` for a wire property: its snake_case. */
export function activityFieldApiName(field: SecuredActivityField): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Programme id -> wire field -> level, for every programme the session reaches. */
export type ActivityFieldAccess = ReadonlyMap<
  string,
  ReadonlyMap<SecuredActivityField, ActivityFieldLevel>
>;

/**
 * Activity field access from the generic per-object answer. FAILS CLOSED: a
 * reachable programme the answer does not carry, or a field with no
 * `field_def`, is `none` (every tenant has the standard catalogue since 0027,
 * so a gap is a broken catalogue, never "no decision saved").
 */
export function activityFieldAccessFromObjectAccess(
  objectAccess: ReadonlyMap<string, ReadonlyMap<string, ActivityFieldLevel>>,
  reachableProgrammeIds: readonly string[],
): ActivityFieldAccess {
  const access = new Map<string, Map<SecuredActivityField, ActivityFieldLevel>>();
  for (const programmeId of reachableProgrammeIds) {
    const fields = objectAccess.get(programmeId);
    const levels = new Map<SecuredActivityField, ActivityFieldLevel>();
    for (const field of SECURED_ACTIVITY_FIELDS) {
      levels.set(field, fields?.get(activityFieldApiName(field)) ?? 'none');
    }
    access.set(programmeId, levels);
  }
  return access;
}

/** The caller's level for one field in one programme; unknown is `none`. */
export function activityFieldLevel(
  access: ActivityFieldAccess,
  programmeId: string,
  field: SecuredActivityField,
): ActivityFieldLevel {
  return access.get(programmeId)?.get(field) ?? 'none';
}

/** The fields withheld from the caller in one programme, in contract order. */
export function withheldActivityFields(
  access: ActivityFieldAccess,
  programmeId: string,
): WithholdableActivityField[] {
  return WITHHOLDABLE_ACTIVITY_FIELDS.filter(
    (field) => activityFieldLevel(access, programmeId, field) === 'none',
  );
}

/**
 * The secured fields a write touches that the caller may not edit in
 * `programmeId`, in the order given. Only secured fields are judged; an
 * unknown property is the body schema's business (400).
 */
export function notEditableActivityFields(
  access: ActivityFieldAccess,
  programmeId: string,
  touched: readonly string[],
): SecuredActivityField[] {
  return touched.filter(
    (key): key is SecuredActivityField =>
      isSecuredActivityField(key) && activityFieldLevel(access, programmeId, key) !== 'edit',
  );
}

/**
 * Loads the caller's activity field access: `loadFieldAccess(tx,
 * 'activity')`, re-keyed by wire name. None at all for a session that
 * reaches no programme.
 */
export async function loadActivityFieldAccess(tx: TenantTx): Promise<ActivityFieldAccess> {
  const { programmeIds } = tx.session;
  if (programmeIds.length === 0) return new Map();
  const access = await loadFieldAccess(tx, 'activity');
  return activityFieldAccessFromObjectAccess(access, programmeIds);
}
