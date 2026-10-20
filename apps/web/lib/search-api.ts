import { z } from 'zod';
import { requestRecords, type RecordsResult } from './records-api';

/**
 * The browser's half of `searchRecords` (GET `/api/v1/search`) and
 * `lookupRecords` (POST `/api/v1/search/lookup`) in
 * `docs/api/records.openapi.yaml` (T-0085), for the P27 screen and the
 * command palette (T-0087).
 *
 * SAME-ORIGIN, RELATIVE PATHS, through `requestRecords`: no API hostname in
 * the browser, never from or into the HTTP cache, and no header argument.
 *
 * SCOPE IS NEVER AN ARGUMENT (CLAUDE.md 2.2). There is no programme, owner or
 * type narrowing here: the session decides what the caller reaches, and every
 * search asks for all four types.
 *
 * AN IDENTIFIER TRAVELS IN A BODY, NEVER IN A URL (the contract's R21,
 * D-L135). `searchRecords` takes a name as `q`; a phone number or an email
 * address goes to `lookupRecords` as the closed JSON body `{ phone }` or
 * `{ email }`. Which one a text is, is `planSearch` in `lib/search-query.ts`.
 *
 * ONLY WHAT IS SERVED (contract R9, R17; D-L68). A group whose `type` this
 * client does not know is IGNORED, not a failure of the whole answer: types
 * are additive. A hit that does not parse is dropped, the rest kept. Ids are
 * read as strings and linked only when they are well-formed uuids
 * (`hitHref`). A withheld name field is absent, never null.
 */

export const SEARCH_PATH = '/api/v1/search';
export const LOOKUP_PATH = '/api/v1/search/lookup';

export const SEARCH_TYPES = ['contact', 'lead', 'account', 'deal'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** A lead's status, served on lead hits only (LeadSearchHit); the P27 rows draw it as a status pill (T-0138). */
export const LEAD_HIT_STATUSES = ['new', 'contacted', 'qualified', 'unqualified'] as const;
export type LeadHitStatus = (typeof LEAD_HIT_STATUSES)[number];

const PersonHit = z.object({
  id: z.string(),
  programmeId: z.string().optional(),
  status: z.enum(LEAD_HIT_STATUSES).optional().catch(undefined),
  displayName: z.string().optional(),
  givenNames: z.string().nullable().optional(),
  familyName: z.string().nullable().optional(),
  companyName: z.string().nullable().optional(),
  withheldFields: z.array(z.string()),
});

const NamedHit = z.object({
  id: z.string(),
  programmeId: z.string().optional(),
  name: z.string(),
});

export interface PersonSearchHit {
  readonly kind: 'person';
  readonly id: string;
  /** The hit's programme, as served; P27 names it only behind `programme_scope_search` (T-0138). */
  readonly programmeId?: string | undefined;
  /** A lead hit's status (contacts carry none). */
  readonly status?: LeadHitStatus | undefined;
  readonly displayName?: string | undefined;
  readonly givenNames?: string | null | undefined;
  readonly familyName?: string | null | undefined;
  readonly companyName?: string | null | undefined;
  readonly withheldFields: readonly string[];
}

export interface NamedSearchHit {
  readonly kind: 'named';
  readonly id: string;
  readonly programmeId?: string | undefined;
  readonly name: string;
}

export type SearchHit = PersonSearchHit | NamedSearchHit;

export interface SearchGroup {
  readonly type: SearchType;
  readonly hits: readonly SearchHit[];
}

/** At most three hits per group (the contract's `maxItems`); never more drawn. */
export const HITS_PER_GROUP = 3;

function parseHit(type: SearchType, raw: unknown): SearchHit | null {
  if (type === 'contact' || type === 'lead') {
    const parsed = PersonHit.safeParse(raw);
    return parsed.success ? { kind: 'person', ...parsed.data } : null;
  }
  const parsed = NamedHit.safeParse(raw);
  return parsed.success ? { kind: 'named', ...parsed.data } : null;
}

const RawAnswer = z.object({
  groups: z.array(z.object({ type: z.string(), hits: z.array(z.unknown()) }).passthrough()),
});

/**
 * The answer, in the served order and the served hit order (never re-sorted),
 * with unknown group types ignored and at most three hits per group.
 */
export const SearchAnswer = RawAnswer.transform((answer): readonly SearchGroup[] =>
  answer.groups.flatMap((group) => {
    const type = SEARCH_TYPES.find((known) => known === group.type);
    if (type === undefined) return [];
    const hits = group.hits
      .slice(0, HITS_PER_GROUP)
      .map((raw) => parseHit(type, raw))
      .filter((hit): hit is SearchHit => hit !== null);
    return [{ type, hits }];
  }),
);

/** searchRecords for a name. `q` is already planned (`planSearch`): never an identifier. */
export function searchRecords(q: string, signal?: AbortSignal): Promise<RecordsResult<readonly SearchGroup[]>> {
  const params = new URLSearchParams();
  params.set('q', q);
  return requestRecords(`${SEARCH_PATH}?${params.toString()}`, SearchAnswer, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * lookupRecords for one whole phone number or email address, in the body.
 * No `types`: absent means all four, and the contract answers accounts and
 * deals empty for a lookup.
 */
export function lookupRecords(
  field: 'phone' | 'email',
  value: string,
  signal?: AbortSignal,
): Promise<RecordsResult<readonly SearchGroup[]>> {
  const body = field === 'phone' ? { phone: value } : { email: value };
  return requestRecords(LOOKUP_PATH, SearchAnswer, {
    method: 'POST',
    body,
    ...(signal === undefined ? {} : { signal }),
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a hit opens, or `null`. Only from a well-formed uuid, URL-encoded:
 * contacts and leads open the contact record (a lead's id is a contact id),
 * accounts the account record, and deals the deal record — but a deal only
 * while its screen answers in this process (`crm_pipeline`, which the caller
 * knows from `crmLiveNav()` as `deals`); otherwise it links nowhere (D-L137).
 */
export function hitHref(type: SearchType, id: string, dealsLive = false): string | null {
  if (!UUID.test(id)) return null;
  if (type === 'contact' || type === 'lead') return `/contacts/${encodeURIComponent(id)}`;
  if (type === 'account') return `/accounts/${encodeURIComponent(id)}`;
  return dealsLive ? `/deals/${encodeURIComponent(id)}` : null;
}

/** Where "see all" goes for a name query: the type's own list with `q` and nothing else (R8). Never deals. */
export function seeAllHref(type: SearchType, q: string): string | null {
  const list = type === 'contact' ? '/contacts' : type === 'lead' ? '/leads' : type === 'account' ? '/accounts' : null;
  if (list === null) return null;
  const params = new URLSearchParams();
  params.set('q', q);
  return `${list}?${params.toString()}`;
}

/**
 * The name a person hit draws, or `null` for "no readable name" (a lock).
 * `displayName` exactly as served, never composed from its parts (D-L68).
 * When it is withheld, one readable name part, and nothing guessed.
 */
export function personName(hit: PersonSearchHit): string | null {
  for (const value of [hit.displayName, hit.givenNames, hit.familyName]) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}
