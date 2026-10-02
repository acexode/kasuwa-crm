/**
 * Envelope encryption: the key-management seam (D-L13).
 *
 * The decision is "envelope encryption, a KMS key per environment". The shape
 * below is deliberately the shape of AWS KMS's two relevant calls —
 * GenerateDataKey and Decrypt — so that the production provider is an adapter
 * and not a redesign:
 *
 *   generateDataKey() -> { plaintext, wrapped, keyId }   (KMS GenerateDataKey)
 *   unwrapDataKey(wrapped, keyId) -> plaintext           (KMS Decrypt)
 *
 * WHY ENVELOPE AND NOT ONE KEY ENCRYPTING EVERYTHING. A data key per secret
 * means rotation is a re-wrap of small blobs under a new KMS key rather than a
 * decrypt-and-rewrite of every row, and the KMS key itself never leaves the
 * KMS, so key material in this process only ever opens one row.
 *
 * WHY THE KEY ID IS STORED PER ROW. A row records which KMS key wrapped its
 * data key, so a deployment can hold several at once — which is what makes a
 * rotation incremental instead of a flag day.
 *
 * NOTHING HERE MAY BE LOGGED. Not a data key, not a wrapped key, not a
 * provider response. The point of this work is that a database backup stops
 * being enough to forge a second factor; one log line hands that back.
 */

/** A freshly generated data key, in both forms. */
export interface DataKey {
  /** The raw 32-byte key. Lives in memory for one operation and is never stored. */
  plaintext: Buffer;
  /** The same key encrypted under the KMS key. This is what is stored. */
  wrapped: Buffer;
  /** Which KMS key wrapped it. Stored alongside, so rotation can be incremental. */
  keyId: string;
}

/**
 * A source of data keys. One implementation per environment; application code
 * never sees key material other than the data key it is handed.
 */
export interface KeyProvider {
  /** Opaque, non-secret name of the key this provider currently wraps with. */
  readonly keyId: string;
  /** Human-readable name of the implementation, for boot logs. Never a secret. */
  readonly description: string;
  generateDataKey(): Promise<DataKey>;
  /**
   * Recover a data key. MUST throw rather than return anything falsy on
   * failure: a caller that cannot tell "no key" from "wrong key" will fail
   * open, and for MFA that means silently signing somebody in with no second
   * factor.
   */
  unwrapDataKey(wrapped: Buffer, keyId: string): Promise<Buffer>;
}

/**
 * Thrown by every failure in this subsystem.
 *
 * Carries NO key material, NO ciphertext and NO identifier of a person — only
 * the key id, which is not a secret, and a short reason. The adversarial
 * acceptance suite asserts that errors do not leak; this class is what keeps
 * that true when somebody later adds a friendlier message.
 */
export class KeyManagementError extends Error {
  readonly keyId: string | undefined;

  constructor(reason: string, keyId?: string) {
    super(keyId === undefined ? reason : `${reason} (key id: ${keyId})`);
    this.name = 'KeyManagementError';
    this.keyId = keyId;
  }
}
