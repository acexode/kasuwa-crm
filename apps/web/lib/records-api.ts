import * as z from 'zod/mini';
import { appendCustomFilters, type CustomFilters } from './custom-values-filters';
import { requestRecords, type RecordsResult } from './records-request';
import { identifierShaped } from './identifier-shaped';

// The request helper and the refusal codes every records client shares live in
// `records-request` (T-0145), so a screen that only reads its programmes does
// not ship the contacts schema with them.
export { RecordsErrorCode, ImportErrorCode, DuplicatesErrorCode, NETWORK_ERROR_CODE, requestRecords, hasDetail } from './records-request';
export type { RecordsScreenErrorCode, RecordsErrorDetail, RecordsError, RecordsResult } from './records-request';

/**
 * The browser's half of `docs/api/records.openapi.yaml` — `listContacts`, the
 * read behind P04/02, P04/05 and P04/06 (T-0042). Modelled on `admin-api.ts`.
 *
 * SAME-ORIGIN. A relative `/api/v1/contacts` path, rewritten by
 * `next.config.mjs`: no API hostname in the browser, no `process.env`, and no
 * extra DNS lookup, TLS handshake or CORS preflight on a 300 ms link.
 *
 * SCOPE IS NEVER AN ARGUMENT. There is no programme parameter here and there
 * must never be one (CLAUDE.md section 2, rule 2). The session says who the
 * caller is; `user_programme` says what they reach. The contract mock records
 * any programme-named query key or header as a violation.
 *
 * WITHHELD IS NOT NULL. Field security OMITS a property and names it in
 * `withheldFields`; a present `null` means "no value". Every withholdable
 * property is therefore `.optional()` here, and a screen asks
 * `isWithheld(row, field)` before it reads one — never `row.emails ?? []`,
 * which draws a hidden field as an empty one.
 *
 * KEYSET ONLY (D-P13). `{ data, nextCursor }`, no total. `nextCursor` is opaque:
 * echoed back verbatim with the query that produced it, never parsed or built.
 *
 * SWITCH ON `code`, NEVER ON `message`. The web app localises as
 * `records.error.<code>`.
 */

export const ContactStatus = z.enum(['new', 'contacted', 'qualified', 'unqualified', 'customer']);
export type ContactStatus = z.infer<typeof ContactStatus>;

export const ContactSource = z.enum([
  'whatsapp',
  'ussd',
  'web_form',
  'missed_call',
  'import',
  'api',
  'manual',
  'referral',
  'walk_in',
]);
export type ContactSource = z.infer<typeof ContactSource>;

export const PreferredChannel = z.enum(['whatsapp', 'sms', 'voice', 'email']);
export type PreferredChannel = z.infer<typeof PreferredChannel>;

export const ConsentState = z.enum(['unknown', 'opted_in', 'pending', 'withdrawn']);
export type ConsentState = z.infer<typeof ConsentState>;

export const PhoneType = z.enum(['mobile', 'work', 'home', 'other']);
export type PhoneType = z.infer<typeof PhoneType>;

export const Phone = z.object({
  type: PhoneType,
  e164: z.string(),
});
export type Phone = z.infer<typeof Phone>;

/**
 * The owner's and the account's names a contact row embeds (T-0043, T-0061):
 * `owner.displayName` is `null` for a FORMER owner (T-0103). Each is omitted
 * when withheld and `null` when there is none. The P04 rows print them
 * (T-0133); an id is never a name.
 */
const ContactOwnerRef = z.object({ id: z.string(), displayName: z.nullable(z.string()) });
const ContactAccountRef = z.object({ id: z.string(), name: z.string() });

export const Contact = z.object({
  id: z.string(),
  programmeId: z.string(),
  version: z.int(),
  /** Omitted, and listed in `withheldFields`, when `givenNames` or `familyName` is withheld (D-L68, T-0124): never composed from a readable part. */
  displayName: z.optional(z.string()),
  givenNames: z.optional(z.nullable(z.string())),
  familyName: z.optional(z.nullable(z.string())),
  phones: z.optional(z.array(Phone)),
  emails: z.optional(z.array(z.string())),
  accountId: z.optional(z.nullable(z.string())),
  account: z.optional(z.nullable(ContactAccountRef)),
  ownerUserId: z.optional(z.nullable(z.string())),
  owner: z.optional(z.nullable(ContactOwnerRef)),
  status: z.optional(z.nullable(ContactStatus)),
  source: z.optional(z.nullable(ContactSource)),
  tags: z.optional(z.array(z.string())),
  preferredLanguage: z.optional(z.nullable(z.string())),
  preferredChannel: z.optional(z.nullable(PreferredChannel)),
  state: z.optional(z.nullable(z.string())),
  lga: z.optional(z.nullable(z.string())),
  dnd: z.optional(z.boolean()),
  whatsappOptIn: z.optional(z.boolean()),
  consentState: z.optional(ConsentState),
  phoneNetwork: z.optional(z.nullable(z.string())),
  /** Custom-field values (T-0091): withheld keys are absent and listed in `withheldFields` as `custom.<key>`. */
  custom: z.optional(z.record(z.string(), z.unknown())),
  createdAt: z.string(),
  updatedAt: z.string(),
  withheldFields: z.array(z.string()),
});
export type Contact = z.infer<typeof Contact>;

export const ContactPage = z.object({
  data: z.array(Contact),
  nextCursor: z.nullable(z.string()),
});
export type ContactPage = z.infer<typeof ContactPage>;

/** `true` when field security withheld `field` from this caller on this row. */
export function isWithheld(row: Contact, field: string): boolean {
  return row.withheldFields.includes(field);
}

/** The query `listContacts` takes. Scope is not in it, by construction. */
export interface ContactListQuery {
  readonly q?: string;
  readonly owner?: readonly string[];
  readonly status?: readonly ContactStatus[];
  readonly source?: readonly ContactSource[];
  readonly dnd?: boolean;
  readonly whatsappOptIn?: boolean;
  /** The contacts one CSV import created (T-0096, I9): sent only where `crm_import` is live. */
  readonly importId?: string;
  /** Custom-field filters (T-0091): picklist and boolean equality, and "is empty". */
  readonly custom?: CustomFilters;
  readonly cursor?: string;
  readonly limit?: number;
}

export const CONTACTS_PATH = '/api/v1/contacts';

/** The query string for `listContacts`: only declared parameters, arrays exploded. */
export function contactListSearch(query: ContactListQuery): string {
  const params = new URLSearchParams();
  const q = query.q?.trim() ?? '';
  // Never an identifier: the API refuses one (`identifier_in_url`), and it must not reach a URL (R21).
  if (q !== '' && !identifierShaped(q)) params.set('q', q.slice(0, 100));
  for (const value of query.owner ?? []) params.append('owner', value);
  for (const value of query.status ?? []) params.append('status', value);
  for (const value of query.source ?? []) params.append('source', value);
  if (query.dnd !== undefined) params.set('dnd', String(query.dnd));
  if (query.whatsappOptIn !== undefined) params.set('whatsappOptIn', String(query.whatsappOptIn));
  if (query.importId !== undefined) params.set('importId', query.importId);
  appendCustomFilters(params, query.custom);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const search = params.toString();
  return search === '' ? '' : `?${search}`;
}

export function listContacts(query: ContactListQuery, signal?: AbortSignal): Promise<RecordsResult<ContactPage>> {
  return requestRecords(`${CONTACTS_PATH}${contactListSearch(query)}`, ContactPage, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });
}
