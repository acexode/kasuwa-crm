import type { TenantTx } from '@kasuwa/db';
import { fieldLevel, loadFieldAccess, type FieldAccess } from '@kasuwa/metadata-engine';

/**
 * Field security for deals (T-0108; the activity rules of T-0061 applied to
 * the standard `deal` object 0036 catalogued).
 *
 * The level that counts is the one the caller holds in the DEAL'S programme.
 * `none` withholds (omitted, never nulled, named in `withheldFields`), `read`
 * reads but may not be written (403 `field_not_editable`), `edit` does both.
 * The locked admin set is always `edit`; the tenant-admin flag lifts nothing
 * (D-L63): `loadFieldAccess` never reads it.
 *
 * `name` is NEVER withheld on the wire (R13): a deal without its name is not a
 * card a screen can draw, as a contact's display name. Its matrix row still
 * decides whether it may be WRITTEN.
 *
 * Fails closed: a programme or field the access map does not carry is `none`.
 */

export type DealFieldLevel = 'none' | 'read' | 'edit';

/** The Deal properties field security may withhold, in contract order (DealWithheldField). */
export const WITHHOLDABLE_DEAL_FIELDS = [
  'amount',
  'expectedCloseDate',
  'ownerUserId',
  'primaryContactId',
  'accountId',
  'nextStep',
] as const;
export type WithholdableDealField = (typeof WITHHOLDABLE_DEAL_FIELDS)[number];

/** Every Deal property the matrix governs: the withholdable six, plus `name`. */
export const SECURED_DEAL_FIELDS = ['name', ...WITHHOLDABLE_DEAL_FIELDS] as const;
export type SecuredDealField = (typeof SECURED_DEAL_FIELDS)[number];

const SECURED = new Set<string>(SECURED_DEAL_FIELDS);

export function isSecuredDealField(name: string): name is SecuredDealField {
  return SECURED.has(name);
}

/** The matrix's `field_def.api_name` for a wire property: its snake_case (0036). */
export function dealFieldApiName(field: SecuredDealField): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** The wire name of a requirement's stored api_name (0036 R2), or null for anything else. */
export function dealWireField(apiName: string): SecuredDealField | null {
  const wire = apiName.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  return isSecuredDealField(wire) && dealFieldApiName(wire) === apiName ? wire : null;
}

/** The caller's level for one deal field in one programme; unknown is `none`. */
export function dealFieldLevel(
  access: FieldAccess,
  programmeId: string,
  field: SecuredDealField,
): DealFieldLevel {
  return fieldLevel(access, programmeId, dealFieldApiName(field));
}

/** The fields withheld from the caller in one programme, in contract order. */
export function withheldDealFields(
  access: FieldAccess,
  programmeId: string,
): WithholdableDealField[] {
  return WITHHOLDABLE_DEAL_FIELDS.filter(
    (field) => dealFieldLevel(access, programmeId, field) === 'none',
  );
}

/** The secured keys of `touched` the caller may not edit in `programmeId`, in the order given. */
export function notEditableDealFields(
  access: FieldAccess,
  programmeId: string,
  touched: readonly string[],
): SecuredDealField[] {
  return touched.filter(
    (key): key is SecuredDealField =>
      isSecuredDealField(key) && dealFieldLevel(access, programmeId, key) !== 'edit',
  );
}

/** The session's deal field access, per programme it reaches. None for a session that reaches none. */
export async function loadDealFieldAccess(tx: TenantTx): Promise<FieldAccess> {
  if (tx.session.programmeIds.length === 0) return new Map();
  return loadFieldAccess(tx, 'deal');
}
