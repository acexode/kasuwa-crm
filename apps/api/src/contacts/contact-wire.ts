import {
  withheldContactFields,
  type Contact,
  type ContactFieldAccess,
  type ContactPhone,
  type WithholdableContactField,
} from '@kasuwa/domain-core';

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
  ownerUserId?: string | null;
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
  withheldFields: WithholdableContactField[];
}

export function toContactWire(contact: Contact, access: ContactFieldAccess): ContactWire {
  const withheld = withheldContactFields(access, contact.programmeId);
  const readable: Partial<Record<WithholdableContactField, unknown>> = {
    givenNames: contact.givenNames,
    familyName: contact.familyName,
    phones: contact.phones,
    emails: contact.emails,
    accountId: contact.accountId,
    ownerUserId: contact.ownerUserId,
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
