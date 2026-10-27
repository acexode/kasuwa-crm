import { z } from 'zod';
import { apiFetch } from './api-fetch';

/**
 * How every records client asks the API and reads its refusals (T-0042), apart
 * from the contacts client in `records-api` (T-0145), which re-exports all of
 * this.
 */

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

/**
 * The refusals only the merge operations answer (T-0097, D-L148): `already_merged`
 * (409, on a merge, and on an undo whose survivor was merged away since) and
 * `undo_expired` (410). Kept out of `RecordsErrorCode` for the same reason as
 * the import codes: only the duplicates screen pays for their sentences.
 */
export const DuplicatesErrorCode = z.enum(['already_merged', 'undo_expired']);
export type DuplicatesErrorCode = z.infer<typeof DuplicatesErrorCode>;

const ApiError = z.object({
  statusCode: z.number(),
  code: z.union([RecordsErrorCode, ImportErrorCode, DuplicatesErrorCode]),
  message: z.string(),
  details: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
  /** On a 429: the earliest time a retry can succeed (the search throttle, T-0085). */
  retryAt: z.string().optional(),
});

/** The request never arrived, or the answer was not the contract's. */
export const NETWORK_ERROR_CODE = 'network' as const;
export type RecordsScreenErrorCode = RecordsErrorCode | ImportErrorCode | DuplicatesErrorCode | typeof NETWORK_ERROR_CODE;

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
  /** On a 429 that sends `Retry-After` in seconds (the duplicates scan, D-L163): how long to wait before asking again. */
  readonly retryAfterSeconds?: number;
}

export type RecordsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RecordsError };

const NETWORK_FAILURE: RecordsError = { code: NETWORK_ERROR_CODE };

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
  init: { readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; readonly body?: unknown; readonly signal?: AbortSignal } = {
    method: 'GET',
  },
): Promise<RecordsResult<T>> {
  let response: Response;
  try {
    // apiFetch never caches: every records answer carries personal data at a
    // URL that is the same for every user of every tenant (the BFF also sends
    // `Cache-Control: no-store`; that is the second layer).
    response = await apiFetch(path, {
      method: init.method,
      ...(init.body === undefined ? {} : { body: init.body }),
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
  const { code, details, retryAt } = parsed.data;
  // Delta-seconds only: an HTTP-date, a zero or a negative is no wait at all.
  const waited = Number(response.headers.get('retry-after'));
  const retryAfterSeconds = Number.isInteger(waited) && waited >= 1 ? waited : undefined;
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
