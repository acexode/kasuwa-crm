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
 * Pure. Since T-0053 the matrix rules above are applied by
 * `loadFieldAccess(tx, 'contact')` in @kasuwa/metadata-engine (and unit-tested
 * there); this file maps that answer to wire names and answers the questions
 * the contacts API asks of it.
 */

export type ContactFieldLevel = 'none' | 'read' | 'edit';

/**
 * The `Contact` properties field security may withhold, as wire names, in the
 * contract's order. `id`, `programmeId`, `version`, the timestamps and
 * `withheldFields` are never withheld. `displayName` is withheld too, but has
 * no matrix row: it follows its name parts (`displayNameReadable`, below).
 */
export const WITHHOLDABLE_CONTACT_FIELDS = [
  'givenNames',
  'familyName',
  'companyName',
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

/** Programme id -> wire field -> level, for every programme the session reaches. */
export type ContactFieldAccess = ReadonlyMap<
  string,
  ReadonlyMap<WithholdableContactField, ContactFieldLevel>
>;

/**
 * Contact field access from the generic per-object answer (T-0053):
 * `loadFieldAccess(tx, 'contact')` keys fields by `field_def.api_name`; this
 * re-keys them by wire name for every reachable programme.
 *
 * FAIL CLOSED on anything missing: a reachable programme the generic answer
 * does not carry, or a withholdable field with no `field_def`, is `none`.
 * Since T-0053 every tenant has a standard, undeletable `field_def` for each
 * withholdable property, so a gap means a broken catalogue, never "no
 * decision saved" - and a broken catalogue must not read as `edit`.
 */
export function contactFieldAccessFromObjectAccess(
  objectAccess: ReadonlyMap<string, ReadonlyMap<string, ContactFieldLevel>>,
  reachableProgrammeIds: readonly string[],
): ContactFieldAccess {
  const access = new Map<string, Map<WithholdableContactField, ContactFieldLevel>>();
  for (const programmeId of reachableProgrammeIds) {
    const fields = objectAccess.get(programmeId);
    const levels = new Map<WithholdableContactField, ContactFieldLevel>();
    for (const field of WITHHOLDABLE_CONTACT_FIELDS) {
      levels.set(field, fields?.get(contactFieldApiName(field)) ?? 'none');
    }
    access.set(programmeId, levels);
  }
  return access;
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

// --- displayName (D-L68, T-0085 R8, T-0124 I1) ---------------------------------

/**
 * The name parts `displayName` follows. `displayName` has no `field_def` and
 * no grant of its own: it is readable exactly when BOTH parts are readable
 * (`read` or `edit`) in the record's programme, and withheld when either is
 * `none`, whatever the part's value (a NULL part that is withheld still
 * withholds it). It is never composed from the readable part: a name that
 * survived a withheld part would hand back what field security took away.
 *
 * THIS IS THE ONE PLACE THE RULE IS WRITTEN. Every read path that answers a
 * contact's or a lead's name (the record wire, the deal, activity, duplicate
 * and merge summaries, `q`, the timeline, scripts, search) asks one of the
 * functions below, never `contactFieldLevel` on the parts directly.
 */
export const DISPLAY_NAME_PARTS = [
  'givenNames',
  'familyName',
] as const satisfies readonly WithholdableContactField[];

/** True when the caller may read a contact's `displayName` in `programmeId`. */
export function displayNameReadable(access: ContactFieldAccess, programmeId: string): boolean {
  return DISPLAY_NAME_PARTS.every(
    (part) => contactFieldLevel(access, programmeId, part) !== 'none',
  );
}

/** Programmes in which the caller may read (and so `q` may match) `displayName`. */
export function programmesReadingDisplayName(access: ContactFieldAccess): string[] {
  return [...access.keys()].filter((programmeId) => displayNameReadable(access, programmeId));
}

/** True when `displayName` is withheld from the caller in ANY programme they reach. */
export function displayNameWithheldAnywhere(access: ContactFieldAccess): boolean {
  return [...access.keys()].some((programmeId) => !displayNameReadable(access, programmeId));
}

/**
 * A contact named inside another answer (a closed `{ id, displayName }`
 * summary, T-0124 I3): the name when readable in the contact's programme,
 * otherwise `null`. A summary has no `withheldFields`, so `null` is how it
 * says "withheld".
 */
export function summaryDisplayName(
  access: ContactFieldAccess,
  programmeId: string,
  displayName: string | null,
): string | null {
  return displayName !== null && displayNameReadable(access, programmeId) ? displayName : null;
}

/**
 * The properties of a write body the caller may not edit in `programmeId`,
 * in the order they were sent. Only withholdable fields are judged here; an
 * unknown or server-owned property is the body schema's business (400).
 *
 * `displayName` is NOT judged here, because createContact and the importer
 * use this too, and whether a caller missing a name part may create contacts
 * is an open product call (T-0124 I11). Updates use
 * `notEditableContactUpdateFields`, which adds it.
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

/**
 * `notEditableContactFields` for an update, plus `displayName` when it is
 * withheld (T-0124 I11): a caller cannot write a field they cannot read. In
 * the order sent. Whether a `read` part makes `displayName` read-only is left
 * open (I11), so only a withheld name is refused.
 */
export function notEditableContactUpdateFields(
  access: ContactFieldAccess,
  programmeId: string,
  sentKeys: readonly string[],
): (WithholdableContactField | 'displayName')[] {
  const nameLocked = !displayNameReadable(access, programmeId);
  return sentKeys.filter(
    (key): key is WithholdableContactField | 'displayName' =>
      (key === 'displayName' && nameLocked) ||
      (isWithholdableContactField(key) && contactFieldLevel(access, programmeId, key) !== 'edit'),
  );
}
