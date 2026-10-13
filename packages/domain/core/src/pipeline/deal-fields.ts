import type { TenantTx } from '@kasuwa/db';
import { fieldLevel, loadFieldAccess, type FieldAccess } from '@kasuwa/metadata-engine';

/**
 * Field security for deals (T-0107; D-L88, D-P19, D-L115), through the
 * generic per-object answer: `loadFieldAccess(tx, 'deal')` gives, per
 * reachable programme, the level of every standard `deal` field_def (0036)
 * for the set the caller holds IN THAT PROGRAMME, and `fieldLevel` reads it
 * failing closed.
 *
 * A deal lives in its pipeline's programme, so on a board field security is
 * judged once, in the pipeline's programme, and is the same for every card.
 *
 *   - `none` withholds: omitted from the card (never nulled) together with its
 *     companion (`amount` with `weightedAmount`, `ownerUserId` with `owner`,
 *     `primaryContactId` with `contact`, `accountId` with `account`), named in
 *     `withheldFields`, and never filterable (`400 field_withheld`).
 *   - `name` is never withheld (the contract), so `q` discloses nothing.
 *
 * Pure apart from `loadDealFieldAccess`.
 */

/** The `Deal` properties field security may withhold, as wire names, in contract order. */
export const WITHHOLDABLE_DEAL_FIELDS = [
  'amount',
  'expectedCloseDate',
  'ownerUserId',
  'primaryContactId',
  'accountId',
  'nextStep',
] as const;

export type WithholdableDealField = (typeof WITHHOLDABLE_DEAL_FIELDS)[number];

/** The matrix's `field_def.api_name` for a wire property: its snake_case (0036). */
export function dealFieldApiName(field: WithholdableDealField): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Programme id -> field api_name -> level: `loadFieldAccess(tx, 'deal')`. */
export type DealFieldAccess = FieldAccess;

/** One round trip; none for a session that reaches no programme. */
export async function loadDealFieldAccess(tx: TenantTx): Promise<DealFieldAccess> {
  if (tx.session.programmeIds.length === 0) return new Map();
  return loadFieldAccess(tx, 'deal');
}

/** True when `field` is withheld from the caller in `programmeId`. Fails closed. */
export function dealFieldWithheld(
  access: DealFieldAccess,
  programmeId: string,
  field: WithholdableDealField,
): boolean {
  return fieldLevel(access, programmeId, dealFieldApiName(field)) === 'none';
}

/** The fields withheld from the caller in one programme, in contract order. */
export function withheldDealFields(
  access: DealFieldAccess,
  programmeId: string,
): WithholdableDealField[] {
  return WITHHOLDABLE_DEAL_FIELDS.filter((field) => dealFieldWithheld(access, programmeId, field));
}
