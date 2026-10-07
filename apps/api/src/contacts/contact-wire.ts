import {
  withheldContactFields,
  type Contact,
  type ContactAccountSummary,
  type ContactFieldAccess,
  type ContactOwner,
  type ContactPhone,
  type WithholdableContactField,
} from '@kasuwa/domain-core';

/**
 * Wire properties that are not in the field-security matrix themselves but
 * are DERIVED from one that is, and are withheld exactly when it is. `owner`
 * (T-0043) is `ownerUserId` with a name attached: a name that survived a
 * withheld id would hand back what field security took away. There is no
 * matrix row for `owner`, deliberately, so the two can never disagree.
 * `account` (T-0061, D-L72) is `accountId` with the account's name attached,
 * for the same reason.
 */
type DerivedContactField = 'owner' | 'account';

const DERIVED: readonly (readonly [
  derived: DerivedContactField,
  source: WithholdableContactField,
])[] = [
  ['owner', 'ownerUserId'],
  ['account', 'accountId'],
];

/** A name `withheldFields` may carry. */
export type WithheldContactWireField = WithholdableContactField | DerivedContactField;

/**
 * The wire's `withheldFields` for the matrix's withheld list: each withheld
 * field, followed by any property derived from it, in contract order.
 */
export function withheldWireFields(
  withheld: readonly WithholdableContactField[],
): WithheldContactWireField[] {
  const result: WithheldContactWireField[] = [];
  for (const field of withheld) {
    result.push(field);
    for (const [derived, source] of DERIVED) {
      if (source === field) result.push(derived);
    }
  }
  return result;
}

/**
 * `#/components/schemas/Contact` on the wire, field security applied.
 *
 * WITHHELD MEANS OMITTED, NEVER NULLED (records.openapi.yaml rule 3). A field
 * the caller may not read in THIS ROW'S programme is deleted from the object
 * and named in `withheldFields`; a present `null` always means "no value".
 * Every property the contract names is therefore either present or listed,
 * never both and never neither. Nothing else is ever added: no tenant id, no
 * internal column.
 */
export interface ContactWire {
  id: string;
  programmeId: string;
  version: number;
  displayName: string;
  givenNames?: string | null;
  familyName?: string | null;
  phones?: ContactPhone[];
  emails?: string[];
  accountId?: string | null;
  /** T-0061: withheld with `accountId`, never on its own. */
  account?: ContactAccountSummary | null;
  ownerUserId?: string | null;
  /** T-0043: withheld with `ownerUserId`, never on its own. */
  owner?: ContactOwner | null;
  status?: string | null;
  source?: string | null;
  tags?: string[];
  preferredLanguage?: string | null;
  preferredChannel?: string | null;
  state?: string | null;
  lga?: string | null;
  dnd?: boolean;
  whatsappOptIn?: boolean;
  consentState?: string;
  phoneNetwork?: string | null;
  createdAt: string;
  updatedAt: string;
  withheldFields: WithheldContactWireField[];
}

export function toContactWire(contact: Contact, access: ContactFieldAccess): ContactWire {
  const withheld = withheldWireFields(withheldContactFields(access, contact.programmeId));
  const readable: Partial<Record<WithheldContactWireField, unknown>> = {
    givenNames: contact.givenNames,
    familyName: contact.familyName,
    phones: contact.phones,
    emails: contact.emails,
    accountId: contact.accountId,
    account: contact.account,
    ownerUserId: contact.ownerUserId,
    owner: contact.owner,
    status: contact.status,
    source: contact.source,
    tags: contact.tags,
    preferredLanguage: contact.preferredLanguage,
    preferredChannel: contact.preferredChannel,
    state: contact.state,
    lga: contact.lga,
    dnd: contact.dnd,
    whatsappOptIn: contact.whatsappOptIn,
    consentState: contact.consentState,
    phoneNetwork: contact.phoneNetwork,
  };
  for (const field of withheld) delete readable[field];
  return {
    id: contact.id,
    programmeId: contact.programmeId,
    version: contact.version,
    displayName: contact.displayName,
    ...(readable as Partial<ContactWire>),
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
    withheldFields: withheld,
  };
}
