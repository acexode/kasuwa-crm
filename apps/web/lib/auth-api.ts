import * as z from 'zod/mini';
import { apiFetch } from './api-fetch';

/**
 * The browser's half of `docs/api/auth.openapi.yaml`.
 *
 * Zod at the boundary, per `CLAUDE.md` section 4: an HTTP response is untrusted
 * input even when our own server sent it, and a cast would let a contract
 * change reach a component as `undefined` three renders later.
 *
 * SAME-ORIGIN ON PURPOSE. Every call here is a relative path through
 * `apiFetch`, so the browser never learns an API hostname and no `process.env`
 * is needed in app code (lint-enforced). The BFF route handler at
 * `app/api/v1/[...path]` forwards it to the API server-side (ADR-0019).
 *
 * SWITCH ON `code`, NEVER ON `message`. `message` is English prose that will be
 * translated and reworded; `code` is a fixed enum in the spec, and the web app
 * localises it as `auth.error.<code>`.
 */

/** The fixed `code` enum from the contract's `Error` schema. */
export const AuthErrorCode = z.enum([
  'validation_failed',
  'invalid_credentials',
  'account_locked',
  'mfa_code_invalid',
  'mfa_challenge_expired',
  'mfa_challenge_invalid',
  'resend_too_soon',
  'sso_domain_not_found',
  'otp_invalid',
  'otp_expired',
  'otp_too_many_attempts',
  'not_authenticated',
  'not_implemented',
  // T-0036: the code on every unexpected 500. Additive; generic copy.
  'internal_error',
]);
export type AuthErrorCode = z.infer<typeof AuthErrorCode>;

export const ApiError = z.object({
  statusCode: z.number(),
  error: z.string(),
  code: AuthErrorCode,
  message: z.string(),
  details: z.optional(z.array(z.object({ path: z.string(), code: z.string() }))),
  attemptsRemaining: z.optional(z.nullable(z.number())),
  retryAt: z.optional(z.string()),
  timeZone: z.optional(z.string()),
});
export type ApiError = z.infer<typeof ApiError>;

const MfaMethodType = z.enum(['totp', 'sms', 'backup_code']);
export type MfaMethodType = z.infer<typeof MfaMethodType>;

export const MfaChallengeStarted = z.object({
  mfaRequired: z.literal(true),
  challengeId: z.string(),
  method: MfaMethodType,
  methods: z.array(
    z.object({
      type: MfaMethodType,
      available: z.boolean(),
      deliveryHint: z.nullable(z.string()),
    }),
  ),
  enrolmentRequired: z.boolean(),
  expiresAt: z.string(),
  resendAvailableAt: z.nullable(z.string()),
});
export type MfaChallengeStarted = z.infer<typeof MfaChallengeStarted>;

/**
 * A successful second factor, AS THE BROWSER RECEIVES IT (ADR-0019 point 3).
 *
 * The API's answer also carries the session token; the BFF puts it in an
 * HttpOnly cookie and removes it, with its type, before the body reaches this
 * code. So the browser never holds the token, even for one render, and there
 * is nothing here to store. This deliberately differs from
 * `docs/api/auth.openapi.yaml`, which describes the API's own answer to a
 * non-browser client.
 */
export const SessionEstablished = z.object({
  expiresAt: z.string(),
  user: z.object({
    id: z.string(),
    tenantId: z.string(),
    email: z.string(),
    displayName: z.string(),
    locale: z.string(),
  }),
});
export type SessionEstablished = z.infer<typeof SessionEstablished>;

export const SsoConnection = z.object({
  provider: z.string(),
  displayName: z.string(),
  redirectUrl: z.string(),
});
export type SsoConnection = z.infer<typeof SsoConnection>;

/**
 * Either half of a call. A thrown exception would make every caller write a
 * try/catch whose catch block has to re-derive whether the failure was an
 * expected `401` or a dropped connection — and the expected failures ARE the
 * screens here.
 */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ScreenError };

/**
 * A transport failure, shaped as an `ApiError` so a screen has one error type.
 *
 * `network` is not in the contract's enum, because the server can never send
 * it: it means the request never arrived. It is rendered from
 * `auth.error.network` like any other code.
 */
export const NETWORK_ERROR_CODE = 'network' as const;
export type ScreenErrorCode = AuthErrorCode | typeof NETWORK_ERROR_CODE;

export interface ScreenError {
  readonly code: ScreenErrorCode;
  readonly attemptsRemaining?: number | null;
  readonly retryAt?: string;
  readonly timeZone?: string;
  readonly details?: readonly { path: string; code: string }[];
}

export function toScreenError(error: ApiError): ScreenError {
  // Built by spreading rather than by assigning `undefined`, because
  // `exactOptionalPropertyTypes` draws the distinction the tsconfig asks for:
  // "absent" and "present but undefined" are different, and only the first one
  // means "the server did not send a retry time".
  return {
    code: error.code,
    attemptsRemaining: error.attemptsRemaining ?? null,
    ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
    ...(error.timeZone === undefined ? {} : { timeZone: error.timeZone }),
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

export const NETWORK_FAILURE: ScreenError = { code: NETWORK_ERROR_CODE };

export async function post<T>(
  path: string,
  body: unknown,
  schema: z.ZodMiniType<T>,
  signal?: AbortSignal,
): Promise<Result<T>> {
  let response: Response;
  try {
    // `return`: on these routes a 401 is the answer (a wrong password or code),
    // not a lost session, so the screen shows it rather than leaving.
    response = await apiFetch(path, {
      method: 'POST',
      body,
      onUnauthenticated: 'return',
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    // Never log the request: it holds credentials (CLAUDE.md section 6.1).
    return { ok: false, error: NETWORK_FAILURE };
  }

  const payload: unknown = await response.json().catch(() => null);

  if (response.ok) {
    const parsed = schema.safeParse(payload);
    if (parsed.success) {
      return { ok: true, value: parsed.data };
    }
    // The server answered with something the contract does not describe. That
    // is not a user error and must not be dressed up as one, so it reads as a
    // transport failure: try again, nothing you typed was wrong.
    return { ok: false, error: NETWORK_FAILURE };
  }

  const parsed = ApiError.safeParse(payload);
  if (parsed.success) {
    return { ok: false, error: toScreenError(parsed.data) };
  }
  return { ok: false, error: NETWORK_FAILURE };
}

export interface SignInInput {
  tenantSlug: string;
  email: string;
  password: string;
}

export function signIn(input: SignInInput, signal?: AbortSignal): Promise<Result<MfaChallengeStarted>> {
  return post('/api/v1/auth/sign-in', input, MfaChallengeStarted, signal);
}

export function verifyMfa(
  input: { challengeId: string; code: string },
  signal?: AbortSignal,
): Promise<Result<SessionEstablished>> {
  return post('/api/v1/auth/mfa', input, SessionEstablished, signal);
}

export function reissueMfaChallenge(
  input: { challengeId: string; method: MfaMethodType },
  signal?: AbortSignal,
): Promise<Result<MfaChallengeStarted>> {
  return post('/api/v1/auth/mfa/challenge', input, MfaChallengeStarted, signal);
}

export function lookupSso(domain: string, signal?: AbortSignal): Promise<Result<SsoConnection>> {
  return post('/api/v1/auth/sso/lookup', { domain }, SsoConnection, signal);
}

