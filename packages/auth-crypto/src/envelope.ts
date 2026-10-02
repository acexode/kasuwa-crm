import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KeyManagementError, type KeyProvider } from './key-provider';

/**
 * Envelope encryption of a short secret (D-L13).
 *
 * A fresh AES-256-GCM data key per secret, the data key wrapped by the
 * KeyProvider, and four things stored: the ciphertext, the wrapped data key,
 * the key id and the algorithm. The algorithm is stored rather than assumed so
 * a future format can be introduced without guessing at what old rows are.
 *
 * ADDITIONAL AUTHENTICATED DATA. Every sealed value is bound to the row it
 * belongs to. Without it, a ciphertext is portable: anyone able to write the
 * table could copy their own factor's ciphertext onto another user's row and
 * then hold that user's second factor. The binding costs nothing and closes it.
 *
 * FAILURE IS LOUD. `openSecret` throws; it never returns undefined and never
 * returns a partial result. A caller that treats "could not decrypt" as "no
 * secret" would sign the user in without a second factor, which is the single
 * worst outcome available here.
 */

const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The on-disk format marker, stored per row.
 *
 * `A256GCM-ENV1` = AES-256-GCM over the plaintext with a per-secret data key,
 * data key wrapped by the provider, ciphertext laid out as iv || tag || body.
 */
export const ENVELOPE_ALGORITHM = 'A256GCM-ENV1';

/** Exactly the four columns a row stores. */
export interface SealedSecret {
  ciphertext: Buffer;
  wrappedKey: Buffer;
  keyId: string;
  algorithm: string;
}

/**
 * Bind a sealed TOTP secret to its row.
 *
 * Tenant and factor id, in that order. Neither is personal data and neither is
 * secret — AAD is authenticated, not encrypted, and this value is reconstructed
 * from the same row at read time.
 */
export function mfaSecretAad(tenantId: string, factorId: string): Buffer {
  return Buffer.from(`user_mfa_factor:${tenantId}:${factorId}`, 'utf8');
}

export async function sealSecret(
  provider: KeyProvider,
  plaintext: string,
  aad: Buffer,
): Promise<SealedSecret> {
  const dataKey = await provider.generateDataKey();
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER, dataKey.plaintext, iv);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]),
      wrappedKey: dataKey.wrapped,
      keyId: dataKey.keyId,
      algorithm: ENVELOPE_ALGORITHM,
    };
  } finally {
    // The data key has done its one job. Zeroing is not a guarantee against a
    // heap snapshot — V8 may have copied it — but it shortens the window for
    // free and documents that the key is not meant to survive this call.
    dataKey.plaintext.fill(0);
  }
}

export async function openSecret(
  provider: KeyProvider,
  sealed: SealedSecret,
  aad: Buffer,
): Promise<string> {
  if (sealed.algorithm !== ENVELOPE_ALGORITHM) {
    throw new KeyManagementError(
      `Unknown envelope algorithm: ${sealed.algorithm}`,
      sealed.keyId,
    );
  }
  if (sealed.ciphertext.length <= IV_BYTES + TAG_BYTES) {
    throw new KeyManagementError('Sealed secret is malformed', sealed.keyId);
  }

  const dataKey = await provider.unwrapDataKey(sealed.wrappedKey, sealed.keyId);
  try {
    const iv = sealed.ciphertext.subarray(0, IV_BYTES);
    const tag = sealed.ciphertext.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = sealed.ciphertext.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(CIPHER, dataKey, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof KeyManagementError) {
      throw error;
    }
    // Deliberately opaque. A GCM failure means the key is wrong, the row was
    // tampered with, or the AAD does not match; none of those may be
    // distinguished in a message, and nothing derived from the ciphertext may
    // appear in one.
    throw new KeyManagementError('Could not decrypt the sealed secret', sealed.keyId);
  } finally {
    dataKey.fill(0);
  }
}
