import { z } from 'zod';

/**
 * The browser's half of `docs/api/auth.openapi.yaml`.
 *
 * Zod at the boundary, per `CLAUDE.md` section 4: an HTTP response is untrusted
 * input even when our own server sent it, and a cast would let a contract
 * change reach a component as `undefined` three renders later.
 *
 * SAME-ORIGIN ON PURPOSE. Every call here is a relative path, so the browser
 * never learns an API hostname and no `process.env` is needed in app code
 * (lint-enforced). `next.config.mjs` rewrites `/api/v1/*` to whichever API
 * origin the deployment runs.
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
]);
export type AuthErrorCode = z.infer<typeof AuthErrorCode>;

export const ApiError = z.object({
  statusCode: z.number(),
  error: z.string(),
  code: AuthErrorCode,
  message: z.string(),
  details: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
  attemptsRemaining: z.number().nullable().optional(),
  retryAt: z.string().optional(),
  timeZone: z.string().optional(),
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
      deliveryHint: z.string().nullable(),
    }),
  ),
  enrolmentRequired: z.boolean(),
  expiresAt: z.string(),
  resendAvailableAt: z.string().nullable(),
});
export type MfaChallengeStarted = z.infer<typeof MfaChallengeStarted>;

export const SessionEstablished = z.object({
  accessToken: z.string(),
  tokenType: z.string(),
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

async function post<T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<Result<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
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

/* --------------------------------------------------------------------------
 * Self-serve sign-up — `signUp`, `verifyOtp`, `resendOtp`.
 *
 * All three are `x-kasuwa-implemented: false` in the contract (T-0016 builds
 * them) and their screens sit behind `self_serve_signup`.
 *
 * `signUp` answers 202 with ONE body whether or not the address already has an
 * account (D-P3). There is no "already registered" branch to write, and the
 * screens must not invent one: they render the server's masked hints, never
 * the address the person typed, so a new and an existing address produce the
 * same page.
 * ------------------------------------------------------------------------ */

export const EMPLOYEE_SIZES = ['1-10', '11-50', '51-200', '201-1000', '1000+'] as const;
export type EmployeeSize = (typeof EMPLOYEE_SIZES)[number];

export interface SignUpInput {
  fullName: string;
  email: string;
  phoneE164: string;
  organisationName: string;
  country: string;
  employeeSize: EmployeeSize;
  isBpo: boolean;
  password: string;
  acceptedTermsAt: string;
}

export const VerificationStarted = z.object({
  verificationId: z.string(),
  emailHint: z.string().nullable().optional(),
  phoneHint: z.string().nullable().optional(),
  expiresAt: z.string(),
  resendAvailableAt: z.string(),
});
export type VerificationStarted = z.infer<typeof VerificationStarted>;

export const VerificationResult = z.object({
  emailVerified: z.boolean(),
  phoneVerified: z.boolean(),
  nextStep: z.enum(['verify_email', 'verify_phone', 'onboarding']),
});
export type VerificationResult = z.infer<typeof VerificationResult>;

export type VerificationChannel = 'email' | 'phone';

export function signUp(input: SignUpInput, signal?: AbortSignal): Promise<Result<VerificationStarted>> {
  return post('/api/v1/auth/sign-up', input, VerificationStarted, signal);
}

export function verifyOtp(
  input: { verificationId: string; channel: VerificationChannel; code: string },
  signal?: AbortSignal,
): Promise<Result<VerificationResult>> {
  return post('/api/v1/auth/verify-otp', input, VerificationResult, signal);
}

export function resendOtp(
  input: { verificationId: string; channel: VerificationChannel },
  signal?: AbortSignal,
): Promise<Result<VerificationStarted>> {
  return post('/api/v1/auth/verify-otp/resend', input, VerificationStarted, signal);
}
