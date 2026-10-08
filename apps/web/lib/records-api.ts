import { z } from 'zod';

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

const ApiError = z.object({
  statusCode: z.number(),
  code: RecordsErrorCode,
  message: z.string(),
  details: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
});

/** The request never arrived, or the answer was not the contract's. */
export const NETWORK_ERROR_CODE = 'network' as const;
export type RecordsScreenErrorCode = RecordsErrorCode | typeof NETWORK_ERROR_CODE;

/** One `details[]` entry: a path and a reason code, never the submitted value. */
export interface RecordsErrorDetail {
  readonly path: string;
  readonly code: string;
}

export interface RecordsError {
  readonly code: RecordsScreenErrorCode;
  /** The reasons the contract names (`field_withheld`, `field_not_editable`, ...). */
  readonly details?: readonly RecordsErrorDetail[];
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
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const search = params.toString();
  return search === '' ? '' : `?${search}`;
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
  init: { readonly method: 'GET' | 'POST' | 'PATCH'; readonly body?: unknown; readonly signal?: AbortSignal } = {
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

  const parsed = ApiError.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: NETWORK_FAILURE };
  }
  const { code, details } = parsed.data;
  return { ok: false, error: details === undefined ? { code } : { code, details } };
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
