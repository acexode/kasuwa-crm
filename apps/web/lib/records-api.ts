import { z } from 'zod';
import { appendCustomFilters, type CustomFilters } from './custom-values-filters';

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

export const Contact = z.object({
  id: z.string(),
  programmeId: z.string(),
  version: z.number().int(),
  displayName: z.string(),
  givenNames: z.string().nullable().optional(),
  familyName: z.string().nullable().optional(),
  phones: z.array(Phone).optional(),
  emails: z.array(z.string()).optional(),
  accountId: z.string().nullable().optional(),
  ownerUserId: z.string().nullable().optional(),
  status: ContactStatus.nullable().optional(),
  source: ContactSource.nullable().optional(),
  tags: z.array(z.string()).optional(),
  preferredLanguage: z.string().nullable().optional(),
  preferredChannel: PreferredChannel.nullable().optional(),
  state: z.string().nullable().optional(),
  lga: z.string().nullable().optional(),
  dnd: z.boolean().optional(),
  whatsappOptIn: z.boolean().optional(),
  consentState: ConsentState.optional(),
  phoneNetwork: z.string().nullable().optional(),
  /** Custom-field values (T-0091): withheld keys are absent and listed in `withheldFields` as `custom.<key>`. */
  custom: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  withheldFields: z.array(z.string()),
});
export type Contact = z.infer<typeof Contact>;

export const ContactPage = z.object({
  data: z.array(Contact),
  nextCursor: z.string().nullable(),
});
export type ContactPage = z.infer<typeof ContactPage>;

/** `true` when field security withheld `field` from this caller on this row. */
export function isWithheld(row: Contact, field: string): boolean {
  return row.withheldFields.includes(field);
}

/**
 * The `code`s a records read can answer with: `listContacts` declares
 * `validation_failed` and `not_authenticated`; the rest are the shared
 * envelope's, kept so an unexpected answer still has copy.
 */
export const RecordsErrorCode = z.enum([
  'validation_failed',
  'not_authenticated',
  'not_permitted',
  'not_found',
  'stale_write',
  'too_many_requests',
  'service_unavailable',
  'internal_error',
]);
export type RecordsErrorCode = z.infer<typeof RecordsErrorCode>;

/**
 * The refusals only the import operations answer (T-0096, D-L150). Kept out of
 * `RecordsErrorCode`, which every records screen spreads into its message
 * bundle: a code a screen can never receive must not cost it a sentence on a
 * 256 kbps link.
 */
export const ImportErrorCode = z.enum(['import_status_conflict', 'upload_mismatch']);
export type ImportErrorCode = z.infer<typeof ImportErrorCode>;

const ApiError = z.object({
  statusCode: z.number(),
  code: z.union([RecordsErrorCode, ImportErrorCode]),
  message: z.string(),
  details: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
  /** On a 429: the earliest time a retry can succeed (the search throttle, T-0085). */
  retryAt: z.string().optional(),
});

/** The request never arrived, or the answer was not the contract's. */
export const NETWORK_ERROR_CODE = 'network' as const;
export type RecordsScreenErrorCode = RecordsErrorCode | ImportErrorCode | typeof NETWORK_ERROR_CODE;

/** One `details[]` entry: a path and a reason code, never the submitted value. */
export interface RecordsErrorDetail {
  readonly path: string;
  readonly code: string;
}

export interface RecordsError {
  readonly code: RecordsScreenErrorCode;
  /** The reasons the contract names (`field_withheld`, `field_not_editable`, ...). */
  readonly details?: readonly RecordsErrorDetail[];
  /** On `too_many_requests`, when the contract sends it: the earliest a retry can succeed (ISO 8601, UTC). */
  readonly retryAt?: string;
  /** On a 429 that sends `Retry-After` (notifications, D-L134): the seconds to wait, a positive whole number. */
  readonly retryAfterSeconds?: number;
}

export type RecordsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RecordsError };

const NETWORK_FAILURE: RecordsError = { code: NETWORK_ERROR_CODE };

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
  if (q !== '') params.set('q', q.slice(0, 100));
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

/** A `Retry-After` is honoured whole, but a nonsense header is not an hour-long silence: every wait taken from one is capped here (N6). */
export const RETRY_AFTER_CAP_MS = 900_000;

/** A server's `Retry-After` (seconds) as a wait in ms, capped; `fallbackMs` when it sent none. */
export function retryAfterMs(seconds: number | undefined, fallbackMs: number): number {
  return seconds === undefined ? fallbackMs : Math.min(RETRY_AFTER_CAP_MS, Math.max(0, seconds * 1000));
}

/**
 * `Retry-After` as whole seconds, or `undefined`. Only the delta-seconds form
 * the contract declares (`integer, minimum 1`) is read: an HTTP date is not
 * guessed at, because a wrong wait is worse than none.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null || !/^\d{1,6}$/.test(header.trim())) return undefined;
  const seconds = Number(header.trim());
  return seconds >= 1 ? seconds : undefined;
}

/**
 * One same-origin records request, its answer parsed with `schema`. Every
 * records client goes through here (contacts, accounts), so a refusal is read
 * the same way everywhere: by `code` and `details[].code`, never `message`.
 *
 * `path` is a RELATIVE `/api/v1/...` path, always. There is no header
 * argument: nothing a screen sends may name a scope.
 */
export async function requestRecords<T>(
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  init: {
    readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT';
    readonly body?: unknown;
    readonly signal?: AbortSignal;
    /**
     * A 429 with no envelope but a `Retry-After` is `too_many_requests` with its wait, not `network`.
     * Opt-in (notifications, T-0101): every other caller keeps reading that answer as it always has
     * (a lost answer), so no other screen changes behaviour (D-L179 N7).
     */
    readonly readBareThrottle?: boolean;
  } = {
    method: 'GET',
  },
): Promise<RecordsResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method,
      // Every records answer carries personal data at a URL that is the same
      // for every user of every tenant: never from, or into, the HTTP cache
      // (the API also sends `Cache-Control: no-store`; this is the second layer).
      cache: 'no-store',
      headers:
        init.body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
  } catch {
    return { ok: false, error: NETWORK_FAILURE };
  }

  const payload: unknown = await response.json().catch(() => null);

  if (response.ok) {
    const parsed = schema.safeParse(payload);
    // An answer the contract does not describe is not the user's fault and is
    // not dressed up as one.
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: NETWORK_FAILURE };
  }

  const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
  const parsed = ApiError.safeParse(payload);
  if (!parsed.success) {
    // A 429 from a layer in front of the API has no envelope, but a wait is still a wait.
    return init.readBareThrottle === true && response.status === 429 && retryAfterSeconds !== undefined
      ? { ok: false, error: { code: 'too_many_requests', retryAfterSeconds } }
      : { ok: false, error: NETWORK_FAILURE };
  }
  const { code, details, retryAt } = parsed.data;
  return {
    ok: false,
    error: {
      code,
      ...(details === undefined ? {} : { details }),
      ...(retryAt === undefined ? {} : { retryAt }),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
  };
}

/** `true` when a refusal names `reason` in its `details`. */
export function hasDetail(error: RecordsError | null, reason: string): boolean {
  return error?.details?.some((detail) => detail.code === reason) ?? false;
}

export function listContacts(query: ContactListQuery, signal?: AbortSignal): Promise<RecordsResult<ContactPage>> {
  return requestRecords(`${CONTACTS_PATH}${contactListSearch(query)}`, ContactPage, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });
}
