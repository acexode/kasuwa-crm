import { z } from 'zod';
import { Contact, requestRecords, type RecordsResult } from './records-api';

/**
 * The browser's half of the five duplicates and merge operations in
 * `docs/api/records.openapi.yaml` (tag `duplicates`, T-0093, served by T-0095)
 * plus `listMyProgrammes`, for the P28 duplicates screen (T-0097).
 *
 * SAME-ORIGIN, RELATIVE PATHS, through `requestRecords`: no API hostname in
 * the browser, never from or into the HTTP cache, and no header argument.
 * SCOPE IS NEVER AN ARGUMENT (CLAUDE.md 2.2): the programme is the path of
 * `listDuplicates` (the one the person chose from their own list, D-L148),
 * `listContactMerges` takes `cursor` and `limit` only, and the session decides
 * what the caller reaches.
 *
 * ONLY WHAT IS SERVED. A set is `{ matchOn, contacts }` with a name (or `null`
 * when withheld) and `updatedAt`: no phone, no email, no matched value and no
 * score exist in the contract, so none exists here (D-P12). `nextCursor` is
 * opaque: echoed back unchanged, never read or built. A merge names two
 * contacts by id and, where field security allows it, by name; there is no
 * "merged into" pointer.
 *
 * NOTHING HERE IS LOGGED OR KEPT. A name in an answer goes to the screen and
 * nowhere else.
 */

export const DUPLICATES_PATH = '/api/v1/programmes';
export const MERGES_PATH = '/api/v1/contact-merges';
export const PREVIEW_PATH = '/api/v1/contacts';
export const PROGRAMMES_PATH = '/api/v1/me/programmes';

export const MATCH_ON = ['phone', 'email'] as const;
export const MatchOn = z.enum(MATCH_ON);
export type MatchOn = z.infer<typeof MatchOn>;

const Id = z.uuid();
const Instant = z.iso.datetime();

const DuplicateContact = z.object({
  id: Id,
  /** `null` when field security withholds it: drawn as a label, never as the word "null". */
  displayName: z.string().nullable(),
  updatedAt: Instant,
});
export type DuplicateContact = z.infer<typeof DuplicateContact>;

const DuplicateSet = z.object({ matchOn: MatchOn, contacts: z.array(DuplicateContact).min(2) });
export type DuplicateSet = z.infer<typeof DuplicateSet>;

const DuplicatePage = z.object({ data: z.array(DuplicateSet), nextCursor: z.string().nullable() });
export type DuplicatePage = z.infer<typeof DuplicatePage>;

/** The standard fields a merge may choose (`MergeField`). Never a compliance field. */
export const MERGE_FIELDS = [
  'displayName',
  'givenNames',
  'familyName',
  'companyName',
  'phones',
  'emails',
  'accountId',
  'ownerUserId',
  'status',
  'source',
  'tags',
  'preferredLanguage',
  'preferredChannel',
  'state',
  'lga',
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

/** Dnd, WhatsApp opt-in and consent: shown, locked, and the most restrictive outcome wins (D-P28). */
export const COMPLIANCE_FIELDS = ['dnd', 'whatsappOptIn', 'consentState'] as const;
export type ComplianceField = (typeof COMPLIANCE_FIELDS)[number];

export const MergeSide = z.enum(['survivor', 'merged']);
export type MergeSide = z.infer<typeof MergeSide>;

/** A preview's record: a Contact, plus the company the merge may choose. */
const PreviewContact = Contact.extend({ companyName: z.string().nullable().optional() });
export type PreviewContact = z.infer<typeof PreviewContact>;

const ComplianceOutcome = z.object({
  dnd: z.boolean().optional(),
  whatsappOptIn: z.boolean().optional(),
  consentState: z.enum(['unknown', 'opted_in', 'pending', 'withdrawn']).optional(),
  withheldFields: z.array(z.enum(COMPLIANCE_FIELDS)),
});
export type ComplianceOutcome = z.infer<typeof ComplianceOutcome>;

const ContactMergePreview = z.object({
  survivor: PreviewContact,
  merged: PreviewContact,
  /** Keys: every field the caller may edit (a `MergeField` or `custom.<key>`); a key outside it is never sent. */
  defaults: z.record(z.string(), MergeSide),
  compliance: ComplianceOutcome,
});
export type ContactMergePreview = z.infer<typeof ContactMergePreview>;

const MergeParty = z.object({ id: Id, displayName: z.string().nullable() });

const ContactMerge = z.object({
  id: Id,
  programmeId: Id,
  survivor: MergeParty,
  merged: MergeParty,
  mergedByUserId: Id,
  mergedAt: Instant,
  undoUntil: Instant,
  undoneAt: Instant.nullable(),
  undoneByUserId: Id.nullable(),
  survivorReverted: z.boolean().nullable(),
});
export type ContactMerge = z.infer<typeof ContactMerge>;

const ContactMergePage = z.object({ data: z.array(ContactMerge), nextCursor: z.string().nullable() });
export type ContactMergePage = z.infer<typeof ContactMergePage>;

const Programmes = z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) });
export type Programme = z.infer<typeof Programmes>['data'][number];

export type DuplicatesResult<T> = RecordsResult<T>;

export function listMyProgrammes(signal?: AbortSignal): Promise<DuplicatesResult<readonly Programme[]>> {
  return requestRecords(PROGRAMMES_PATH, Programmes.transform((answer) => answer.data), { method: 'GET', ...(signal ? { signal } : {}) });
}

function cursorQuery(cursor: string | undefined): string {
  return cursor === undefined ? '' : `?${new URLSearchParams({ cursor }).toString()}`;
}

/** One page of a programme's duplicate sets: each page is a whole-programme scan, so ask sparingly (D-L163). */
export function listDuplicates(programmeId: string, cursor?: string, signal?: AbortSignal): Promise<DuplicatesResult<DuplicatePage>> {
  return requestRecords(`${DUPLICATES_PATH}/${encodeURIComponent(programmeId)}/duplicates${cursorQuery(cursor)}`, DuplicatePage, {
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
}

/** Both records, the default pick per field and the compliance outcome. `contactId` is the main record. */
export function getContactMergePreview(contactId: string, withId: string, signal?: AbortSignal): Promise<DuplicatesResult<ContactMergePreview>> {
  const query = new URLSearchParams({ with: withId }).toString();
  return requestRecords(`${PREVIEW_PATH}/${encodeURIComponent(contactId)}/merge-preview?${query}`, ContactMergePreview, {
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
}

export interface CreateMergeBody {
  readonly survivorId: string;
  readonly mergedId: string;
  readonly survivorVersion: number;
  readonly mergedVersion: number;
  readonly choices: Readonly<Record<string, MergeSide>>;
}

export function createContactMerge(body: CreateMergeBody): Promise<DuplicatesResult<ContactMerge>> {
  return requestRecords(MERGES_PATH, ContactMerge, { method: 'POST', body });
}

/** The merge history, newest first: Phase 2's recycle bin (D-P27). */
export function listContactMerges(cursor?: string, signal?: AbortSignal): Promise<DuplicatesResult<ContactMergePage>> {
  return requestRecords(`${MERGES_PATH}${cursorQuery(cursor)}`, ContactMergePage, { method: 'GET', ...(signal ? { signal } : {}) });
}

/** Takes no body. */
export function undoContactMerge(mergeId: string): Promise<DuplicatesResult<ContactMerge>> {
  return requestRecords(`${MERGES_PATH}/${encodeURIComponent(mergeId)}/undo`, ContactMerge, { method: 'POST' });
}
