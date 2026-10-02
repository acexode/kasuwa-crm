import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { nodeEnv } from '@kasuwa/config';
import { KeyManagementError, type DataKey, type KeyProvider } from './key-provider';

/**
 * The DEVELOPMENT key provider. It is not a KMS and does not pretend to be one.
 *
 * It wraps data keys under a master key that lives in this process, which means
 * it protects a stolen database backup and NOTHING ELSE. That is the exact
 * threat D-L13's security review named for TOTP secrets, so it is worth having
 * locally — but it is not the production control, and a deployment that ran on
 * it would be storing the lock next to the key.
 *
 * It therefore REFUSES TO EXIST UNDER NODE_ENV=production, in the same way and
 * for the same reason as `assertAuthModeIsSafe` in @kasuwa/config: a control
 * that can be left switched on by forgetting to configure something is not a
 * control. @kasuwa/config refuses to boot on the same condition; this is the
 * second, independent layer, because the first can be bypassed by constructing
 * the provider directly.
 *
 * KEY DERIVATION. The master key is HKDF'd per key id, so two key ids produce
 * unrelated wrapping keys and a local rotation can be exercised end to end
 * without a cloud account.
 */

const WRAP_ALGORITHM = 'aes-256-gcm';
const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The default development master key, derived from a fixed, obviously-invented
 * label.
 *
 * This is NOT a secret in the repository, and it must never be treated as one:
 * it is a published constant whose only job is to let `pnpm db:seed`, the API
 * and the test harness agree on how to unwrap the fixture TOTP secrets without
 * anyone configuring anything. Everything it protects is already committed to
 * this repository in packages/db/src/fixtures.ts.
 *
 * `KASUWA_KMS_LOCAL_MASTER_KEY` overrides it for a developer who wants a local
 * key that is not published; production cannot reach this code path at all.
 */
const DEVELOPMENT_MASTER_KEY_LABEL =
  'kasuwa-development-only-master-key-NOT-A-SECRET-see-development-key-provider.ts';

export const DEVELOPMENT_KEY_ID = 'local-dev-1';

export interface DevelopmentKeyProviderOptions {
  /**
   * 32 bytes of master key. Omitted in normal development, where the published
   * constant above is used.
   */
  masterKey?: Buffer;
  /** The key id recorded on every row this provider wraps. Defaults to `local-dev-1`. */
  keyId?: string;
}

function developmentMasterKey(): Buffer {
  return createHash('sha256').update(DEVELOPMENT_MASTER_KEY_LABEL).digest();
}

function wrappingKeyFor(masterKey: Buffer, keyId: string): Buffer {
  // HKDF-SHA256, salted with the key id: a different key id is a different
  // wrapping key, which is what lets a rotation be rehearsed locally.
  return Buffer.from(
    hkdfSync('sha256', masterKey, Buffer.from(keyId, 'utf8'), Buffer.from('kasuwa-dek-wrap'), 32),
  );
}

class DevelopmentKeyProvider implements KeyProvider {
  readonly keyId: string;
  readonly description = 'development key provider (in-process master key, not a KMS)';
  readonly #masterKey: Buffer;

  constructor(options: DevelopmentKeyProviderOptions) {
    if (nodeEnv() === 'production') {
      throw new KeyManagementError(
        'Refusing to construct the development key provider: it holds its master key in ' +
          'process and must never run with NODE_ENV=production. Configure ' +
          'KASUWA_KMS_PROVIDER=aws-kms with a real KMS key for this environment.',
      );
    }

    const masterKey = options.masterKey ?? developmentMasterKey();
    if (masterKey.length !== DATA_KEY_BYTES) {
      throw new KeyManagementError('A master key must be exactly 32 bytes');
    }
    this.#masterKey = masterKey;
    this.keyId = options.keyId ?? DEVELOPMENT_KEY_ID;
  }

  generateDataKey(): Promise<DataKey> {
    const plaintext = randomBytes(DATA_KEY_BYTES);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(WRAP_ALGORITHM, wrappingKeyFor(this.#masterKey, this.keyId), iv);
    // The key id is authenticated, so a wrapped key cannot be moved to a row
    // claiming a different one.
    cipher.setAAD(Buffer.from(this.keyId, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrapped = Buffer.concat([iv, cipher.getAuthTag(), body]);
    return Promise.resolve({ plaintext, wrapped, keyId: this.keyId });
  }

  unwrapDataKey(wrapped: Buffer, keyId: string): Promise<Buffer> {
    if (wrapped.length <= IV_BYTES + TAG_BYTES) {
      throw new KeyManagementError('Wrapped data key is malformed', keyId);
    }
    const iv = wrapped.subarray(0, IV_BYTES);
    const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = wrapped.subarray(IV_BYTES + TAG_BYTES);

    try {
      const decipher = createDecipheriv(
        WRAP_ALGORITHM,
        wrappingKeyFor(this.#masterKey, keyId),
        iv,
      );
      decipher.setAAD(Buffer.from(keyId, 'utf8'));
      decipher.setAuthTag(tag);
      return Promise.resolve(Buffer.concat([decipher.update(body), decipher.final()]));
    } catch {
      // The underlying error is swallowed on purpose: node's GCM failure text
      // says nothing useful and anything derived from the ciphertext must not
      // reach a log.
      throw new KeyManagementError('Could not unwrap the data key', keyId);
    }
  }
}

/**
 * Build the development provider. Throws under NODE_ENV=production.
 */
export function createDevelopmentKeyProvider(
  options: DevelopmentKeyProviderOptions = {},
): KeyProvider {
  return new DevelopmentKeyProvider(options);
}
