import { z } from 'zod';
import { appendCustomFilters, type CustomFilters } from './custom-values-filters';
import { Account } from './accounts-api';
import { CONTACTS_PATH, Contact, requestRecords, type ContactSource, type RecordsResult } from './records-api';

/**
 * The browser's half of the leads operations in `docs/api/records.openapi.yaml`
 * (T-0056, served since T-0076): `listLeads`, the Kanban move through
 * `updateContact`, and `convertContact`. The P04 Leads screen (T-0058) reads
 * and writes leads through here and nowhere else.
 *
 * A LEAD IS A CONTACT AT A LEAD STAGE (D-P17). There is no lead id: a row's
 * `id` is a contact id. Leads are read from `listLeads`, never from
 * `listContacts` with a status filter — an older server ignores unknown
 * parameters there and would list customers as leads (D-L75).
 *
 * SAME-ORIGIN. Relative `/api/v1/...` paths, rewritten by `next.config.mjs`.
 *
 * SCOPE IS NEVER AN ARGUMENT (CLAUDE.md 2.2). No programme parameter, no
 * header: the session and `user_programme` decide what a caller reaches.
 *
 * THE SCREEN'S ONLY CONTACT WRITE IS `{ version, status }` (D-L86): a card
 * moved to another lead stage. Nothing else of the row is round-tripped, so a
 * withheld field can never be sent back as an empty one.
 *
 * CONVERT IS ONE CALL (D-P17). `convertContact` qualifies the lead and links
 * an existing account or creates one, in one transaction with one audit
 * event. Never createAccount then link. A retry after a lost answer re-sends
 * the SAME body: the contract answers an exact repeat 200 and writes nothing.
 */

export const LEADS_PATH = '/api/v1/leads';

/** listLeads' `status` enum: the four lead stages, and never `customer`. One Kanban column each. */
export const LeadStatus = z.enum(['new', 'contacted', 'qualified', 'unqualified']);
export type LeadStatus = z.infer<typeof LeadStatus>;

/** `sort`'s fixed set: every key is one field security never withholds (never `companyName`). */
export const LeadSort = z.enum(['-createdAt', 'createdAt', '-updatedAt', 'updatedAt', 'displayName', '-displayName']);
export type LeadSort = z.infer<typeof LeadSort>;

/** The server's default order: sent only when it is not this. */
export const DEFAULT_LEAD_SORT: LeadSort = '-createdAt';

/**
 * `Contact.owner`. `displayName: null` is a FORMER owner (T-0103, D-P23): no
 * longer a member of the contact's programme. The row prints the translated
 * `records.owner.former`, never the id. Always present, never omitted.
 */
export const ContactOwner = z.object({ id: z.string(), displayName: z.string().nullable() });
export type ContactOwner = z.infer<typeof ContactOwner>;
const ContactAccountSummary = z.object({ id: z.string(), name: z.string() });

/**
 * A lead row: a Contact plus the three properties this screen prints —
 * `companyName` (T-0076), and the owner's and account's names (T-0043,
 * T-0061). Each is OMITTED when withheld (listed in `withheldFields`) and
 * `null` when there is no value, so each is `.nullable().optional()`.
 */
export const Lead = Contact.extend({
  companyName: z.string().nullable().optional(),
  owner: ContactOwner.nullable().optional(),
  account: ContactAccountSummary.nullable().optional(),
});
export type Lead = z.infer<typeof Lead>;

export const LeadPage = z.object({
  data: z.array(Lead),
  nextCursor: z.string().nullable(),
});
export type LeadPage = z.infer<typeof LeadPage>;

/** The query `listLeads` takes. Scope is not in it, by construction. */
export interface LeadListQuery {
  readonly q?: string;
  readonly owner?: readonly string[];
  readonly status?: readonly LeadStatus[];
  readonly source?: readonly ContactSource[];
  readonly sort?: LeadSort;
  /** Custom-field filters (T-0091): picklist and boolean equality, and "is empty". */
  readonly custom?: CustomFilters;
  readonly cursor?: string;
  readonly limit?: number;
}

/** `q`'s `maxLength`. */
export const LEAD_QUERY_MAX = 100;

/** The query string for `listLeads`: only declared parameters, arrays exploded, `q` at most 100. */
export function leadListSearch(query: LeadListQuery): string {
  const params = new URLSearchParams();
  const q = query.q?.trim().slice(0, LEAD_QUERY_MAX).trim() ?? '';
  if (q !== '') params.set('q', q);
  for (const value of query.owner ?? []) params.append('owner', value);
  for (const value of query.status ?? []) params.append('status', value);
  for (const value of query.source ?? []) params.append('source', value);
  if (query.sort !== undefined && query.sort !== DEFAULT_LEAD_SORT) params.set('sort', query.sort);
  appendCustomFilters(params, query.custom);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const search = params.toString();
  return search === '' ? '' : `?${search}`;
}

export function listLeads(query: LeadListQuery): Promise<RecordsResult<LeadPage>> {
  return requestRecords(`${LEADS_PATH}${leadListSearch(query)}`, LeadPage);
}

function contactPath(id: string): string {
  return `${CONTACTS_PATH}/${encodeURIComponent(id)}`;
}

/** A contact as getContact returns it: where the server says a lead is, after a refused move. */
export function getLead(id: string): Promise<RecordsResult<Lead>> {
  return requestRecords(contactPath(id), Lead);
}

/** The Kanban move: EXACTLY `{ version, status }`, to a lead stage. Built here so no caller can widen it. */
export interface MoveLeadBody {
  readonly version: number;
  readonly status: LeadStatus;
}

export function moveLead(id: string, move: MoveLeadBody): Promise<RecordsResult<Lead>> {
  const body: MoveLeadBody = { version: move.version, status: move.status };
  return requestRecords(contactPath(id), Lead, { method: 'PATCH', body });
}

/** ConvertContactRequest: closed, `version` plus exactly one of `accountId` or `newAccount`. No status, no programme. */
export type ConvertLeadBody =
  | { readonly version: number; readonly accountId: string }
  | { readonly version: number; readonly newAccount: { readonly name: string } };

export const ConvertLeadResult = z.object({ contact: Lead, account: Account });
export type ConvertLeadResult = z.infer<typeof ConvertLeadResult>;

export function convertLead(id: string, body: ConvertLeadBody): Promise<RecordsResult<ConvertLeadResult>> {
  return requestRecords(`${contactPath(id)}/convert`, ConvertLeadResult, { method: 'POST', body });
}
