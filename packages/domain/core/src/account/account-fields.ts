import type { TenantTx } from '@kasuwa/db';
import { fieldLevel, loadFieldAccess, type FieldAccess } from '@kasuwa/metadata-engine';

/**
 * Field security for accounts (T-0055; D-P9, D-L45, D-L63, D-L73).
 *
 * The same rules as contacts, through the generic per-object answer T-0053
 * built: `loadFieldAccess(tx, 'account')` gives, per reachable programme, the
 * level of every account `field_def` for the set the caller holds IN THAT
 * PROGRAMME, and `fieldLevel` reads it failing closed (a programme or field
 * the answer does not carry is `none`, never the D-L45 default).
 *
 *   - `none` withholds: omitted from the object (never nulled), named in
 *     `withheldFields`, never filterable and never writable.
 *   - `read` reads but may not be written (403 `field_not_editable`).
 *   - `edit` does both.
 *   - The tenant-admin flag never lifts any of it (D-L63).
 *
 * `name` is NOT withholdable, whatever a grant row says: the contract lists
 * it as never withheld, and `sort=name` and `q` depend on that. `id`,
 * `programmeId`, `version` and the timestamps are never withheld either.
 * `owner` is derived from `ownerUserId` (D-L73) and has no field_def; the
 * wire withholds it together with `ownerUserId` (`account-wire.ts`).
 *
 * Pure apart from `loadAccountFieldAccess`, so every rule is unit-tested
 * without a database.
 */

export type AccountFieldLevel = 'none' | 'read' | 'edit';

/** The `Account` properties field security may withhold, as wire names, in contract order. */
export const WITHHOLDABLE_ACCOUNT_FIELDS = [
  'ownerUserId',
  'industry',
  'tier',
  'tags',
  'phones',
  'state',
  'lga',
  'parentAccountId',
] as const;

export type WithholdableAccountField = (typeof WITHHOLDABLE_ACCOUNT_FIELDS)[number];

const WITHHOLDABLE = new Set<string>(WITHHOLDABLE_ACCOUNT_FIELDS);

export function isWithholdableAccountField(name: string): name is WithholdableAccountField {
  return WITHHOLDABLE.has(name);
}

/** The matrix's `field_def.api_name` for a wire property: its snake_case (S3). */
export function accountFieldApiName(field: WithholdableAccountField): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Programme id -> field api_name -> level: `loadFieldAccess(tx, 'account')`. */
export type AccountFieldAccess = FieldAccess;

/**
 * The session's account field access, ONE round trip (as contacts), and none
 * for a session that reaches no programme: it can read no account at all.
 */
export async function loadAccountFieldAccess(tx: TenantTx): Promise<AccountFieldAccess> {
  if (tx.session.programmeIds.length === 0) return new Map();
  return loadFieldAccess(tx, 'account');
}

/** The caller's level for one account field in one programme. Fails closed. */
export function accountFieldLevel(
  access: AccountFieldAccess,
  programmeId: string,
  field: WithholdableAccountField,
): AccountFieldLevel {
  return fieldLevel(access, programmeId, accountFieldApiName(field));
}

/** The fields withheld from the caller in one programme, in contract order. */
export function withheldAccountFields(
  access: AccountFieldAccess,
  programmeId: string,
): WithholdableAccountField[] {
  return WITHHOLDABLE_ACCOUNT_FIELDS.filter(
    (field) => accountFieldLevel(access, programmeId, field) === 'none',
  );
}

/**
 * True when `field` is withheld from the caller in ANY programme they reach.
 * A filter on it is then refused, even if another programme shows it: the
 * filter runs across every programme, and would be an oracle in the one that
 * withholds it.
 */
export function accountFieldWithheldAnywhere(
  access: AccountFieldAccess,
  field: WithholdableAccountField,
): boolean {
  return [...access.keys()].some(
    (programmeId) => accountFieldLevel(access, programmeId, field) === 'none',
  );
}

/**
 * The properties of a write body the caller may not edit in `programmeId`,
 * in the order they were sent. Only withholdable fields are judged; an
 * unknown or server-owned property is the body schema's business (400).
 * Sending a field at all is writing it: `null` (clearing) included.
 */
export function notEditableAccountFields(
  access: AccountFieldAccess,
  programmeId: string,
  sentKeys: readonly string[],
): WithholdableAccountField[] {
  return sentKeys.filter(
    (key): key is WithholdableAccountField =>
      isWithholdableAccountField(key) && accountFieldLevel(access, programmeId, key) !== 'edit',
  );
}
