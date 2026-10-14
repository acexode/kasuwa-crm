import type { TenantTx } from '@kasuwa/db';
import {
  CONTACT_FOLDED_COLUMNS,
  LEAD_STATUSES,
  contactFieldLevel,
  loadContactFieldAccess,
  loadTenantDefaultCountry,
  lookupContacts,
  programmesReading,
  searchAccountsByPrefix,
  searchContactsByPrefix,
  searchDealsByPrefix,
  wholePhoneE164,
  withheldAnywhere,
  type ContactFieldAccess,
  type ContactFoldedColumn,
  type ContactLookupTerm,
  type ContactSearchRow,
  type PrefixRange,
  type SearchBranch,
} from '@kasuwa/domain-core';
import { loadGrants, programmesReadingPipelines } from '@kasuwa/permissions';
import { validationFailed } from '../admin/common/admin-errors';
import {
  parseEmail,
  parseLookupShape,
  parseLookupTypes,
  parsePhone,
  parseSearchQuery,
  type Parsed,
  type SearchType,
} from './search.schemas';

/**
 * Global search (T-0086): searchRecords and lookupRecords, served over the
 * scoped repositories inside the request's ONE tenant transaction
 * (`currentTx()` in the controller). Scope is `tx.session`'s; field security
 * and rights come from the database, re-read on every request.
 *
 * WHO READS WHAT, per type and per programme of the session (CR9):
 *   - contacts and leads: every membership, field security per field (D-L64);
 *     the lead group is empty when `status` is withheld in ANY programme the
 *     caller reaches, as listLeads refuses that caller (CR10, R13);
 *   - accounts: every membership; `name` is never withheld;
 *   - deals: the programmes whose pipelines the caller reads
 *     (`programmesReadingPipelines`, listDeals' own rule: the staff sets and
 *     the tenant-admin flag, never `client_portal` or a custom set; D-L115,
 *     D-L127, R12).
 * A type the caller reads nowhere is an empty group, never an error.
 *
 * FIELD SECURITY (CR7, CR8, D-L68). Per field and per programme: a field
 * withheld in a programme gets no search branch there (never compared, never
 * choosing hits), and is omitted from that programme's hits and listed in
 * `withheldFields`. `displayName` is readable exactly when both `givenNames`
 * and `familyName` are, even a null one; it is never composed. In a lookup,
 * a programme where the compared field (phones or emails) is withheld is not
 * searched at all, so the answer is the answer for a number nobody has.
 *
 * WRITES NOTHING (R21): no audit event, no row, nothing about the query.
 * NOTHING HERE LOGS (R22): not `q`, not the body, not the normalised number,
 * not a hit's name, and no error built here carries any of them.
 */

export interface ContactSearchHitWire {
  type: 'contact' | 'lead';
  id: string;
  programmeId: string;
  displayName?: string;
  givenNames?: string | null;
  familyName?: string | null;
  companyName?: string | null;
  status?: string;
  withheldFields: SearchNameField[];
}

export interface AccountSearchHitWire {
  type: 'account';
  id: string;
  programmeId: string;
  name: string;
}

export interface DealSearchHitWire {
  type: 'deal';
  id: string;
  programmeId: string;
  pipelineId: string;
  name: string;
}

export type SearchHitWire = ContactSearchHitWire | AccountSearchHitWire | DealSearchHitWire;

export interface SearchResultsWire {
  groups: { type: SearchType; hits: SearchHitWire[] }[];
}

/** `SearchNameWithheldField`, in the contract's order. */
const NAME_FIELDS = ['displayName', 'givenNames', 'familyName', 'companyName'] as const;
type SearchNameField = (typeof NAME_FIELDS)[number];

/** Which name fields the caller reads in one programme (D-L68 for displayName). */
export interface NameAccess {
  displayName: boolean;
  givenNames: boolean;
  familyName: boolean;
  companyName: boolean;
}

export function nameAccess(access: ContactFieldAccess, programmeId: string): NameAccess {
  const reads = (field: 'givenNames' | 'familyName' | 'companyName') =>
    contactFieldLevel(access, programmeId, field) !== 'none';
  const givenNames = reads('givenNames');
  const familyName = reads('familyName');
  return {
    displayName: givenNames && familyName,
    givenNames,
    familyName,
    companyName: reads('companyName'),
  };
}

const FOLDED_COLUMN_OF: Record<SearchNameField, ContactFoldedColumn> = {
  displayName: 'display_name_search',
  givenNames: 'given_names_search',
  familyName: 'family_name_search',
  companyName: 'company_name_search',
};

/** One branch per (programme, name field readable there): what may be compared. */
export function contactBranches(
  access: ContactFieldAccess,
  programmeIds: readonly string[],
): SearchBranch<ContactFoldedColumn>[] {
  const branches: SearchBranch<ContactFoldedColumn>[] = [];
  for (const programmeId of programmeIds) {
    const reads = nameAccess(access, programmeId);
    for (const field of NAME_FIELDS) {
      if (reads[field]) branches.push({ programmeId, column: FOLDED_COLUMN_OF[field] });
    }
  }
  // A guard against drift between the two lists, never expected to fire.
  if (branches.some((branch) => !CONTACT_FOLDED_COLUMNS.includes(branch.column))) {
    throw new Error('A contact search branch names an unknown column');
  }
  return branches;
}

/** A contact or lead row as a closed hit: withheld means omitted and listed, never nulled. */
export function toContactHit(
  type: 'contact' | 'lead',
  row: ContactSearchRow,
  access: ContactFieldAccess,
): ContactSearchHitWire {
  const reads = nameAccess(access, row.programmeId);
  const hit: ContactSearchHitWire = {
    type,
    id: row.id,
    programmeId: row.programmeId,
    withheldFields: NAME_FIELDS.filter((field) => !reads[field]),
  };
  if (reads.displayName) hit.displayName = row.displayName;
  if (reads.givenNames) hit.givenNames = row.givenNames;
  if (reads.familyName) hit.familyName = row.familyName;
  if (reads.companyName) hit.companyName = row.companyName;
  if (type === 'lead' && row.status !== null) hit.status = row.status;
  // Key order as the contract lists them; `withheldFields` last.
  const { withheldFields, ...rest } = hit;
  return { ...rest, withheldFields };
}

/** No contact field read anywhere: what a search that asks for no contact type needs. */
const NO_ACCESS: ContactFieldAccess = new Map();

function unwrap<T>(parsed: Parsed<T>): T {
  if (!parsed.ok) throw validationFailed(parsed.details);
  return parsed.value;
}

/** The lead statuses, or null when the lead group must be empty for this caller (R13). */
function leadStatusesFor(access: ContactFieldAccess): readonly string[] | null {
  return withheldAnywhere(access, 'status') ? null : LEAD_STATUSES;
}

/** searchRecords: `GET /api/v1/search`. */
export async function searchRecordsFor(
  tx: TenantTx,
  rawQuery: unknown,
): Promise<SearchResultsWire> {
  // Every 400 is decided here, from the request alone, before any read.
  const { range, types } = unwrap(parseSearchQuery(rawQuery));
  const programmeIds = tx.session.programmeIds;
  const groups: SearchResultsWire['groups'] = [];
  const access =
    types.includes('contact') || types.includes('lead')
      ? await loadContactFieldAccess(tx)
      : NO_ACCESS;
  for (const type of types) {
    groups.push({ type, hits: await searchType(tx, type, range, access, programmeIds) });
  }
  return { groups };
}

async function searchType(
  tx: TenantTx,
  type: SearchType,
  range: PrefixRange,
  access: ContactFieldAccess,
  programmeIds: readonly string[],
): Promise<SearchHitWire[]> {
  switch (type) {
    case 'contact': {
      const rows = await searchContactsByPrefix(tx, {
        range,
        branches: contactBranches(access, programmeIds),
      });
      return rows.map((row) => toContactHit('contact', row, access));
    }
    case 'lead': {
      const statuses = leadStatusesFor(access);
      if (statuses === null) return [];
      const rows = await searchContactsByPrefix(tx, {
        range,
        branches: contactBranches(access, programmeIds),
        statuses,
      });
      return rows.map((row) => toContactHit('lead', row, access));
    }
    case 'account': {
      const rows = await searchAccountsByPrefix(tx, range, programmeIds);
      return rows.map((row) => ({
        type: 'account',
        id: row.id,
        programmeId: row.programmeId,
        name: row.name,
      }));
    }
    case 'deal': {
      const readers = programmesReadingPipelines(await loadGrants(tx));
      const rows = await searchDealsByPrefix(tx, range, readers);
      return rows.map((row) => ({
        type: 'deal',
        id: row.id,
        programmeId: row.programmeId,
        pipelineId: row.pipelineId,
        name: row.name,
      }));
    }
  }
}

/** lookupRecords: `POST /api/v1/search/lookup`. Contacts and leads only. */
export async function lookupRecordsFor(tx: TenantTx, body: unknown): Promise<SearchResultsWire> {
  // The contract's order: the body's shape, one term, the term's own shape
  // (the phone with the tenant's default country), then types. Every 400 is
  // decided before any record is read.
  const shape = unwrap(parseLookupShape(body));
  let term: ContactLookupTerm;
  if (shape.term.kind === 'phone') {
    const country = await loadTenantDefaultCountry(tx);
    const e164 = unwrap(parsePhone(shape.term.raw, (phone) => wholePhoneE164(phone, country)));
    term = { kind: 'phone', e164 };
  } else {
    term = { kind: 'email', address: unwrap(parseEmail(shape.term.raw)) };
  }
  const types = unwrap(parseLookupTypes(shape.types));

  const access =
    types.includes('contact') || types.includes('lead')
      ? await loadContactFieldAccess(tx)
      : NO_ACCESS;
  // Never compared where withheld (CR7): only programmes reading the field.
  const programmeIds = programmesReading(access, term.kind === 'phone' ? 'phones' : 'emails');
  const readsContacts = types.includes('contact') || types.includes('lead');
  const found = readsContacts
    ? await lookupContacts(tx, {
        term,
        programmeIds,
        leadStatuses: types.includes('lead') ? leadStatusesFor(access) : null,
      })
    : { contacts: [], leads: [] };
  const groups: SearchResultsWire['groups'] = types.map((type) => {
    if (type === 'contact') {
      return { type, hits: found.contacts.map((row) => toContactHit('contact', row, access)) };
    }
    if (type === 'lead') {
      return { type, hits: found.leads.map((row) => toContactHit('lead', row, access)) };
    }
    // Accounts and deals are never compared with an identifier (CR5).
    return { type, hits: [] };
  });
  return { groups };
}
