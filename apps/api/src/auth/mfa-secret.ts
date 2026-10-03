import { mfaSecretAad, openSecret, type KeyProvider } from '@kasuwa/auth-crypto';

/**
 * Reading a TOTP secret, new form first, old form second (D-L13, migration 0005).
 *
 * This is the whole of the read side of the expand/migrate/contract. Rows
 * written before 0005 carry only `secret`; rows written since carry both, and
 * rows written after the contract migration will carry only the envelope.
 *
 * TWO PROPERTIES, BOTH LOAD-BEARING.
 *
 *   1. The secret is returned as a local value to the code check only
 *      (`AuthService.verifyMfa`, and `matchTotp` in mfa-store.ts for
 *      enrolment and step-up, T-0012) and is never put in a response shape, a log
 *      line, an error or an exception body. Encrypting it at rest and then
 *      widening where the plaintext travels would be a net loss.
 *
 *   2. FAILURE IS AN EXCEPTION, NEVER `undefined`. A decryption failure means
 *      the key is wrong, the row was tampered with, or the ciphertext does not
 *      belong to this row. If this function returned `undefined` for any of
 *      those, `verifyMfa` would read it as "no factor enrolled" — and the user
 *      would be treated as a user without a second factor. That is MFA
 *      silently switching itself off, by far the worst outcome available here,
 *      so the two cases are different types: `undefined` means genuinely no
 *      factor, and anything else throws.
 */

/** Exactly the columns `verifyMfa` selects. Nothing here is ever logged. */
export interface MfaSecretRow {
  id: string;
  secret: string | null;
  secret_ciphertext: Buffer | null;
  secret_wrapped_key: Buffer | null;
  secret_key_id: string | null;
  secret_algorithm: string | null;
}

/**
 * Thrown when a factor exists but its secret cannot be recovered.
 *
 * Distinct from "no factor": the sign-in must fail closed and loudly rather
 * than continuing as if the user had never enrolled. Carries the factor id and
 * the key id — neither is personal data, both are what an operator needs — and
 * never the ciphertext, the wrapped key or anything derived from them.
 */
export class MfaSecretUnavailableError extends Error {
  constructor(factorId: string, keyId: string | null) {
    super(
      `The enrolled second factor could not be read (factor ${factorId}, ` +
        `key id ${keyId ?? 'none'}). Sign-in refused.`,
    );
    this.name = 'MfaSecretUnavailableError';
  }
}

export async function resolveTotpSecret(
  provider: KeyProvider,
  tenantId: string,
  row: MfaSecretRow,
): Promise<string> {
  if (
    row.secret_ciphertext !== null &&
    row.secret_wrapped_key !== null &&
    row.secret_key_id !== null &&
    row.secret_algorithm !== null
  ) {
    try {
      return await openSecret(
        provider,
        {
          ciphertext: row.secret_ciphertext,
          wrappedKey: row.secret_wrapped_key,
          keyId: row.secret_key_id,
          algorithm: row.secret_algorithm,
        },
        mfaSecretAad(tenantId, row.id),
      );
    } catch {
      // The underlying KeyManagementError is deliberately not chained: its
      // message is safe, but an exception body that travels is one more place a
      // detail can end up. The operator-facing fact is "this factor could not
      // be read", and that is what is raised.
      throw new MfaSecretUnavailableError(row.id, row.secret_key_id);
    }
  }

  // LEGACY. A row written before 0005, still plaintext. Removed by the contract
  // migration, at which point this branch becomes unreachable and goes with it.
  if (row.secret !== null) {
    return row.secret;
  }

  // Neither form. The database CHECK constraint added in 0005 makes this
  // unreachable; it is still an error rather than a silent "no factor",
  // because the alternative is signing somebody in without one.
  throw new MfaSecretUnavailableError(row.id, row.secret_key_id);
}
