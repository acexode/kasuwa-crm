import type { TenantTx } from '@kasuwa/db';
import {
  LEAD_STATUSES,
  listContacts,
  loadContactFieldAccess,
  loadTenantDefaultCountry,
  phoneSearchE164,
  programmesReading,
  withheldAnywhere,
  type ContactFilters,
  type ContactSearch,
} from '@kasuwa/domain-core';
import { validationFailed, type AdminErrorDetail } from '../admin/common/admin-errors';
import {
  customFiltersFrom,
  customWiresFor,
  EMPTY_CUSTOM_WIRE,
  loadCustom,
} from '../custom-fields/custom-values';
import { toContactWire, type ContactWire } from '../contacts/contact-wire';
import { LEAD_FILTER_FIELDS, type ListLeadsQuery } from './leads.schemas';

/**
 * listLeads (T-0076; D-P17, D-L75): a VIEW of contacts, served through the
 * contacts list path. The same repository query as listContacts, the same
 * scope (the session's programmes, never a parameter), the same keyset paging
 * and the same field security on every row; only the status set is fixed to
 * the lead statuses. There is no lead record and no lead id.
 *
 * NOTHING HERE LOGS: `q` is a name, a number or a company (D-L64), and every
 * row is a person's data.
 */
export async function listLeadsFor(
  tx: TenantTx,
  query: ListLeadsQuery,
  rawQuery: unknown,
): Promise<{ data: ContactWire[]; nextCursor: string | null }> {
  const access = await loadContactFieldAccess(tx);
  const custom = await loadCustom(tx, 'contact');

  // A row's presence says "this contact is a lead, not a customer": the view
  // IS a filter on status. So a status withheld from the caller in ANY
  // programme they reach refuses the whole list, parameter or not, rather
  // than leak the value one row at a time. Every other filter on a withheld
  // field is 400 as on listContacts, never silently ignored.
  const withheld: AdminErrorDetail[] = [];
  for (const [parameter, field] of Object.entries(LEAD_FILTER_FIELDS)) {
    const present =
      parameter === 'status' || query[parameter as keyof typeof LEAD_FILTER_FIELDS] !== undefined;
    if (present && withheldAnywhere(access, field)) {
      withheld.push({ path: parameter, code: 'field_withheld' });
    }
  }
  if (withheld.length > 0) throw validationFailed(withheld);
  // T-0089: custom[key] and customEmpty, as on listContacts.
  const customFilters = customFiltersFrom(custom, rawQuery);

  const owners = query.owner ?? [];
  const filters: ContactFilters = {
    ownerUserIds: owners
      .filter((owner) => owner !== 'unassigned')
      .map((owner) => (owner === 'me' ? tx.session.userId : owner)),
    ownerUnassigned: owners.includes('unassigned'),
    // Never wider than the lead statuses: the parameter can only narrow.
    status: query.status ?? LEAD_STATUSES,
    source: query.source,
    custom: customFilters,
  };

  let search: ContactSearch | undefined;
  if (query.q !== undefined) {
    const country = await loadTenantDefaultCountry(tx);
    search = {
      text: query.q,
      phoneE164: phoneSearchE164(query.q, country),
      phoneProgrammeIds: programmesReading(access, 'phones'),
      givenNamesProgrammeIds: programmesReading(access, 'givenNames'),
      familyNameProgrammeIds: programmesReading(access, 'familyName'),
      // Per row: a company withheld in a programme is never matched there.
      companyNameProgrammeIds: programmesReading(access, 'companyName'),
    };
  }

  const page = await listContacts(tx, {
    limit: query.limit,
    cursor: query.cursor,
    sort: query.sort,
    search,
    filters,
  });
  const wires = await customWiresFor(tx, custom, page.data);
  return {
    data: page.data.map((contact) =>
      toContactWire(contact, access, wires.get(contact.id) ?? EMPTY_CUSTOM_WIRE),
    ),
    nextCursor: page.nextCursor,
  };
}
