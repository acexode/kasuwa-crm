/**
 * Cryptographic primitives for authentication.
 *
 * Deliberately a separate package rather than a folder inside apps/api: the
 * seed (@kasuwa/db) has to produce the same password hashes and TOTP secrets
 * the API verifies, and the test harness has to be able to generate a valid
 * code. A shared package is the only arrangement where all three agree by
 * construction instead of by copy-paste.
 *
 * It contains no policy — no lockout thresholds, no session lifetimes, no
 * database access. Those belong to the caller. The one exception is the
 * concurrency cap on argon2id, which lives here because it is a property of the
 * primitive's memory cost rather than of any caller's policy.
 */
export {
  constantTimeEquals,
  dummyPasswordHash,
  hashPassword,
  HashingOverloadedError,
  hashPressure,
  verifyPassword,
} from './password';
export {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  matchTotpStep,
  totpCode,
  verifyTotp,
} from './totp';
export {
  hashIdentifier,
  hashRateLimitKey,
  hashSessionToken,
  newSessionToken,
  SESSION_TOKEN_PREFIX,
} from './tokens';
