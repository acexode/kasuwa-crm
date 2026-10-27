import * as z from 'zod/mini';
import { apiFetch } from './api-fetch';

/**
 * One same-origin request to the scripting API (`docs/api/scripting.openapi.yaml`),
 * for the builder (T-0115) and the run screen (T-0116).
 *
 * SAME-ORIGIN, PARSED, NEVER SCOPED BY THE CALLER. `path` is always a relative
 * `/api/v1/...` path; there is no header argument, so nothing a screen sends
 * can name a programme or a tenant (CLAUDE.md section 2, rule 2). An answer
 * the contract does not describe is a network failure, never data.
 *
 * NEVER CACHED. Script wording, a run and its answers (classified
 * `sensitive`, D-L93) are fetched with `cache: 'no-store'`, and the API sends
 * `Cache-Control: no-store` as well. Nothing here touches device storage, and
 * nothing here logs: a run's `details` go to its own agent and nowhere else.
 *
 * SWITCH ON `code`, NEVER ON `message`. The screens localise as
 * `scripting.error.<code>`.
 */

export const SCRIPTING_ERROR_CODES = [
  'validation_failed',
  'not_authenticated',
  'not_found',
  'not_permitted',
  'stale_write',
  'script_invalid',
  'script_not_published',
  'run_completed',
  'run_stopped',
  'run_at_end',
  'compliance_unacknowledged',
  'answers_incomplete',
  'disposition_not_live',
  'disposition_requirements_unmet',
  'too_many_requests',
  'service_unavailable',
  'internal_error',
] as const;

export const ScriptingErrorCode = z.enum(SCRIPTING_ERROR_CODES);

/** The request never arrived, or the answer was not the contract's. */
export const NETWORK = 'network' as const;
export type ScriptingScreenErrorCode = z.infer<typeof ScriptingErrorCode> | typeof NETWORK;

export interface ScriptingErrorDetail {
  readonly path: string;
  readonly code: string;
}

export interface ScriptingError {
  readonly code: ScriptingScreenErrorCode;
  readonly status: number;
  readonly details: readonly ScriptingErrorDetail[];
}

export type ScriptingResult<T> =
  | { readonly ok: true; readonly status: number; readonly value: T }
  | { readonly ok: false; readonly error: ScriptingError };

const ApiError = z.object({
  code: z.string(),
  details: z.optional(z.array(z.object({ path: z.string(), code: z.string() }))),
});

function failure(status: number, code: ScriptingScreenErrorCode, details: readonly ScriptingErrorDetail[] = []): ScriptingResult<never> {
  return { ok: false, error: { code, status, details } };
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';

export async function scriptingRequest<T>(
  path: string,
  schema: z.ZodMiniType<T, unknown>,
  init: { readonly method?: Method; readonly body?: unknown; readonly signal?: AbortSignal } = {},
): Promise<ScriptingResult<T>> {
  let response: Response;
  try {
    response = await apiFetch(path, {
      method: init.method ?? 'GET',
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
  } catch {
    return failure(0, NETWORK);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = schema.safeParse(payload);
    return parsed.success ? { ok: true, status: response.status, value: parsed.data } : failure(response.status, NETWORK);
  }
  const parsed = ApiError.safeParse(payload);
  if (!parsed.success) return failure(response.status, NETWORK);
  const code = ScriptingErrorCode.safeParse(parsed.data.code);
  return failure(response.status, code.success ? code.data : NETWORK, parsed.data.details ?? []);
}

/** A path segment from a served or routed id: encoded, never trusted to be safe. */
export function segment(id: string): string {
  return encodeURIComponent(id);
}

/** `?cursor=…` exactly as served, or nothing. A cursor is opaque: never parsed, built or put in the address bar. */
export function cursorQuery(cursor: string | null): string {
  return cursor === null ? '' : `?${new URLSearchParams({ cursor }).toString()}`;
}
