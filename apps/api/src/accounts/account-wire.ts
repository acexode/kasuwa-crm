import {
  withheldAccountFields,
  type Account,
  type AccountFieldAccess,
  type AccountOwner,
  type ContactPhone,
  type WithholdableAccountField,
} from '@kasuwa/domain-core';

/**
 * `owner` is not in the field-security matrix (no field_def, D-L73) but is
 * DERIVED from `ownerUserId` and withheld exactly when it is: a name that
 * survived a withheld id would hand back what field security took away.
 */
type DerivedAccountField = 'owner';

const DERIVED: readonly (readonly [
  derived: DerivedAccountField,
  source: WithholdableAccountField,
])[] = [['owner', 'ownerUserId']];

/** A name `withheldFields` may carry. */
export type WithheldAccountWireField = WithholdableAccountField | DerivedAccountField;

/** Each withheld field, followed by any property derived from it. */
export function withheldAccountWireFields(
  withheld: readonly WithholdableAccountField[],
): WithheldAccountWireField[] {
  const result: WithheldAccountWireField[] = [];
  for (const field of withheld) {
    result.push(field);
    for (const [derived, source] of DERIVED) {
      if (source === field) result.push(derived);
    }
  }
  return result;
}

/**
 * `#/components/schemas/Account` on the wire, field security applied.
 *
 * WITHHELD MEANS OMITTED, NEVER NULLED (records.openapi.yaml rule 3). A field
 * the caller may not read in THIS ROW'S programme is deleted from the object
 * and named in `withheldFields`; a present `null` always means "no value".
 * Every property the contract names is either present or listed, never both
 * and never neither. Nothing else is ever added: no tenant id, no Health, no
 * counts, no children (D-L69, D-P13).
 */
export interface AccountWire {
  id: string;
  programmeId: string;
  version: number;
  name: string;
  ownerUserId?: string | null;
  owner?: AccountOwner | null;
  industry?: string | null;
  tier?: string | null;
  tags?: string[];
  phones?: ContactPhone[];
  state?: string | null;
  lga?: string | null;
  parentAccountId?: string | null;
  createdAt: string;
  updatedAt: string;
  withheldFields: WithheldAccountWireField[];
}

export function toAccountWire(account: Account, access: AccountFieldAccess): AccountWire {
  const withheld = withheldAccountWireFields(withheldAccountFields(access, account.programmeId));
  const readable: Partial<Record<WithheldAccountWireField, unknown>> = {
    ownerUserId: account.ownerUserId,
    owner:
      account.owner === null
        ? null
        : { id: account.owner.id, displayName: account.owner.displayName },
    industry: account.industry,
    tier: account.tier,
    tags: account.tags,
    phones: account.phones.map((phone) => ({ type: phone.type, e164: phone.e164 })),
    state: account.state,
    lga: account.lga,
    parentAccountId: account.parentAccountId,
  };
  for (const field of withheld) delete readable[field];
  return {
    id: account.id,
    programmeId: account.programmeId,
    version: account.version,
    name: account.name,
    ...(readable as Partial<AccountWire>),
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
    withheldFields: withheld,
  };
}
