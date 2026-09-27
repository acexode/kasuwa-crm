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
 * database access. Those belong to the caller.
 */
export {
  constantTimeEquals,
  dummyPasswordHash,
  hashPassword,
  verifyPassword,
} from './password';
export { base32Decode, base32Encode, generateTotpSecret, totpCode, verifyTotp } from './totp';
export {
  hashIdentifier,
  hashSessionToken,
  newSessionToken,
  SESSION_TOKEN_PREFIX,
} from './tokens';
