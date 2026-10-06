/**
 * Field security for contacts (T-0041; D-P9, D-L45, D-L63).
 *
 * The T-0026 matrix decides, per field and per permission set, `none`, `read`
 * or `edit`. For a contact the set that counts is the one the caller holds IN
 * THE RECORD'S PROGRAMME (`user_programme.permission_set_id`), so the answer
 * is per row: one person can see emails in A1 and not in A2.
 *
 *   - `none` withholds: the property is omitted (never nulled) and named in
 *     `withheldFields`; it cannot be filtered on, matched by `q`, or written.
 *   - `read` reads but may not be written (403 `field_not_editable`).
 *   - `edit` does both. A cell nobody saved is `edit` (D-L45), and the locked
 *     `admin` set is always `edit` (the matrix already says so).
 *   - The TENANT-ADMIN FLAG IS NOT A PERMISSION SET (D-L63). It decides admin
 *     writes and never what a person can see, so nothing here reads it.
 *   - A membership with NO set gets, per field, the least any unlocked set
 *     gets: having no set must never see more than having the weakest one.
 *   - A reachable programme with NO membership row at all (a revocation that
 *     committed mid-request) is `none` for every field: fail closed.
 *
 * Pure: the caller loads the matrix (metadata-engine) and the memberships
 * (permissions) and hands them in. Every rule here is unit-tested.
 */

export type ContactFieldLevel = 'none' | 'read' | 'edit';

/**
 * The `Contact` properties field security may withhold, as wire names, in the
 * contract's order. `id`, `programmeId`, `version`, `displayName`, the
 * timestamps and `withheldFields` are never withheld.
 */
export const WITHHOLDABLE_CONTACT_FIELDS = [
  'givenNames',
  'familyName',
  'phones',
  'emails',
  'accountId',
  'ownerUserId',
  'status',
  'source',
  'tags',
  'preferredLanguage',
  'preferredChannel',
  'state',
  'lga',
  'dnd',
  'whatsappOptIn',
  'consentState',
  'phoneNetwork',
] as const;

export type WithholdableContactField = (typeof WITHHOLDABLE_CONTACT_FIELDS)[number];

const WITHHOLDABLE = new Set<string>(WITHHOLDABLE_CONTACT_FIELDS);

export function isWithholdableContactField(name: string): name is WithholdableContactField {
  return WITHHOLDABLE.has(name);
}

/** The matrix's `field_def.api_name` for a wire property: its snake_case (S3). */
export function contactFieldApiName(field: WithholdableContactField): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

const RANK: Record<ContactFieldLevel, number> = { none: 0, read: 1, edit: 2 };

/** D-L45: a cell nobody saved. */
const DEFAULT_LEVEL: ContactFieldLevel = 'edit';

/** The matrix for `contact`, as metadata-engine reads it (only what is needed). */
export interface ContactMatrixRow {
  fieldApiName: string;
  cells: readonly { permissionSetId: string; level: ContactFieldLevel; locked: boolean }[];
}

/** Programme id -> wire field -> level, for every programme the session reaches. */
export type ContactFieldAccess = ReadonlyMap<
  string,
  ReadonlyMap<WithholdableContactField, ContactFieldLevel>
>;

/**
 * Resolves the caller's level for every withholdable field in every programme
 * they reach. `matrix` is null when the tenant has no `contact` object yet,
 * which means no decision was ever saved: everything is `edit` (D-L45).
 */
export function resolveContactFieldAccess(input: {
  /** Programme id -> the set key held there, or null for no set. */
  programmeSets: ReadonlyMap<string, string | null>;
  reachableProgrammeIds: readonly string[];
  matrix: readonly ContactMatrixRow[] | null;
}): ContactFieldAccess {
  const rows = new Map((input.matrix ?? []).map((row) => [row.fieldApiName, row]));
  const access = new Map<string, Map<WithholdableContactField, ContactFieldLevel>>();
  for (const programmeId of input.reachableProgrammeIds) {
    const levels = new Map<WithholdableContactField, ContactFieldLevel>();
    if (!input.programmeSets.has(programmeId)) {
      // FAIL CLOSED. A programme in the session's scope with no membership
      // row in this read (revoked mid-request, or a read that returned
      // nothing) has no known set, and the matrix that came with it cannot be
      // trusted to be complete: every field is `none`, never the default.
      for (const field of WITHHOLDABLE_CONTACT_FIELDS) levels.set(field, 'none');
      access.set(programmeId, levels);
      continue;
    }
    const setKey = input.programmeSets.get(programmeId) ?? null;
    for (const field of WITHHOLDABLE_CONTACT_FIELDS) {
      const row = rows.get(contactFieldApiName(field));
      levels.set(field, row === undefined ? DEFAULT_LEVEL : levelFor(row, setKey));
    }
    access.set(programmeId, levels);
  }
  return access;
}

function levelFor(row: ContactMatrixRow, setKey: string | null): ContactFieldLevel {
  if (setKey !== null) {
    return row.cells.find((cell) => cell.permissionSetId === setKey)?.level ?? DEFAULT_LEVEL;
  }
  // No set: never more than the weakest unlocked set.
  let weakest: ContactFieldLevel = DEFAULT_LEVEL;
  for (const cell of row.cells) {
    if (!cell.locked && RANK[cell.level] < RANK[weakest]) weakest = cell.level;
  }
  return weakest;
}

/**
 * The caller's level for one field in one programme. A programme the access
 * map does not know is `none`: fail closed, never open.
 */
export function contactFieldLevel(
  access: ContactFieldAccess,
  programmeId: string,
  field: WithholdableContactField,
): ContactFieldLevel {
  return access.get(programmeId)?.get(field) ?? 'none';
}

/** The fields withheld from the caller in one programme, in contract order. */
export function withheldContactFields(
  access: ContactFieldAccess,
  programmeId: string,
): WithholdableContactField[] {
  return WITHHOLDABLE_CONTACT_FIELDS.filter(
    (field) => contactFieldLevel(access, programmeId, field) === 'none',
  );
}

/** Programmes in which the caller may read `field`. */
export function programmesReading(
  access: ContactFieldAccess,
  field: WithholdableContactField,
): string[] {
  return [...access.keys()].filter(
    (programmeId) => contactFieldLevel(access, programmeId, field) !== 'none',
  );
}

/** True when `field` is withheld from the caller in ANY programme they reach. */
export function withheldAnywhere(
  access: ContactFieldAccess,
  field: WithholdableContactField,
): boolean {
  return [...access.keys()].some(
    (programmeId) => contactFieldLevel(access, programmeId, field) === 'none',
  );
}

/**
 * The properties of a write body the caller may not edit in `programmeId`,
 * in the order they were sent. Only withholdable fields are judged here; an
 * unknown or server-owned property is the body schema's business (400).
 */
export function notEditableContactFields(
  access: ContactFieldAccess,
  programmeId: string,
  sentKeys: readonly string[],
): WithholdableContactField[] {
  return sentKeys.filter(
    (key): key is WithholdableContactField =>
      isWithholdableContactField(key) && contactFieldLevel(access, programmeId, key) !== 'edit',
  );
}
