import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * The error vocabulary of the authentication API (docs/api/auth.openapi.yaml).
 *
 * Every failure is a concrete body with a stable machine-readable `code`. The
 * web app switches on `code` and localises `auth.error.<code>`; `message` is an
 * English fallback for logs and for a client with no catalogue, and is not a
 * stable interface.
 *
 * The important property of this file is what is NOT in it. There is no
 * "no such user", no "wrong password", no "wrong workspace" and no "account
 * disabled". All four are `invalidCredentials()` — one status, one body, one
 * `code` — because an error that tells them apart is a user-enumeration
 * oracle, and the P01 sign-in screen deliberately does not say which field was
 * wrong (CLAUDE.md section 6, rule 4).
 */

export type AuthErrorCode =
  | 'validation_failed'
  | 'invalid_credentials'
  | 'account_locked'
  | 'too_many_requests'
  | 'service_unavailable'
  | 'mfa_challenge_invalid'
  | 'mfa_code_invalid'
  | 'mfa_challenge_expired'
  | 'mfa_method_unavailable'
  | 'resend_too_soon'
  | 'sso_domain_not_found'
  | 'otp_invalid'
  | 'otp_expired'
  | 'otp_too_many_attempts'
  | 'not_authenticated'
  | 'not_implemented';

interface AuthErrorDetail {
  attemptsRemaining?: number | null;
  retryAt?: string;
  timeZone?: string;
}

export class AuthError extends HttpException {
  constructor(
    status: HttpStatus,
    code: AuthErrorCode,
    message: string,
    detail: AuthErrorDetail = {},
  ) {
    super({ statusCode: status, error: reasonPhrase(status), code, message, ...detail }, status);
  }
}

/**
 * Unknown workspace, unknown email, wrong password, disabled user, user in
 * another tenant. All of them. Do not add a variant.
 */
export function invalidCredentials(attemptsRemaining: number | null): AuthError {
  return new AuthError(
    HttpStatus.UNAUTHORIZED,
    'invalid_credentials',
    'Sign-in failed. Check your email address and password, then try again.',
    { attemptsRemaining },
  );
}

/**
 * Applied to the submitted identifier whether or not an account exists, so
 * being locked out is not evidence that an address is real.
 */
export function accountLocked(retryAt: Date, timeZone: string): AuthError {
  return new AuthError(
    HttpStatus.TOO_MANY_REQUESTS,
    'account_locked',
    'Too many sign-in attempts. Try again later.',
    { retryAt: retryAt.toISOString(), timeZone },
  );
}

export function mfaCodeInvalid(attemptsRemaining: number): AuthError {
  return new AuthError(
    HttpStatus.UNAUTHORIZED,
    'mfa_code_invalid',
    'That code did not match. Check your authenticator app and try again.',
    { attemptsRemaining },
  );
}

export function mfaChallengeExpired(): AuthError {
  return new AuthError(
    HttpStatus.UNAUTHORIZED,
    'mfa_challenge_expired',
    'That code has expired. Codes last ten minutes.',
  );
}

/** Unknown, already used, or burned by too many wrong codes. */
export function mfaChallengeInvalid(): AuthError {
  return new AuthError(
    HttpStatus.UNAUTHORIZED,
    'mfa_challenge_invalid',
    'Sign in again to continue.',
  );
}

export function ssoDomainNotFound(): AuthError {
  return new AuthError(
    HttpStatus.NOT_FOUND,
    'sso_domain_not_found',
    'We could not find single sign-on for that domain.',
  );
}

/**
 * Deliberately uninformative. It does not say whether the token was missing,
 * malformed, expired, revoked, issued for another tenant, or issued to a user
 * who has since been disabled.
 */
export function notAuthenticated(): AuthError {
  return new AuthError(HttpStatus.UNAUTHORIZED, 'not_authenticated', 'Not authenticated');
}

/**
 * Load shedding, not an authentication decision.
 *
 * Raised when the argon2id queue is full. It is deliberately NOT a 401: the
 * credentials were never checked, so saying they were wrong would mislead a
 * real user and hand an attacker an oracle — a shed request returns in
 * microseconds where a verified one takes tens of milliseconds.
 */
export function signInUnavailable(): AuthError {
  return new AuthError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'service_unavailable',
    'Too many people are signing in at once. Try again in a moment.',
  );
}

/** Specified in the contract, not built in T-0001. */
export function notImplemented(): AuthError {
  return new AuthError(
    HttpStatus.NOT_IMPLEMENTED,
    'not_implemented',
    'This endpoint is not available yet.',
  );
}

function reasonPhrase(status: HttpStatus): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'Bad Request';
    case HttpStatus.UNAUTHORIZED:
      return 'Unauthorized';
    case HttpStatus.NOT_FOUND:
      return 'Not Found';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'Too Many Requests';
    case HttpStatus.NOT_IMPLEMENTED:
      return 'Not Implemented';
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'Service Unavailable';
    default:
      return 'Error';
  }
}
