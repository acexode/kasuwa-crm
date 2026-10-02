import { KeyManagementError, type DataKey, type KeyProvider } from './key-provider';

/**
 * The AWS KMS shape, behind the same interface — and deliberately NOT wired up.
 *
 * D-A4 gates spend and nothing is deployed, so this package takes no dependency
 * on `@aws-sdk/client-kms` and holds no credentials. What it does is pin down
 * the mapping, so that the day a key exists the change is "pass a client in",
 * not "redesign the storage format":
 *
 *   generateDataKey()  -> KMS GenerateDataKey
 *                         { KeyId, KeySpec: 'AES_256' }
 *                      -> { Plaintext, CiphertextBlob, KeyId }
 *   unwrapDataKey()    -> KMS Decrypt
 *                         { CiphertextBlob, KeyId }   (KeyId pins the key, so a
 *                         swapped blob fails rather than silently resolving)
 *
 * The client is injected as a structural type rather than imported, which keeps
 * the dependency at the composition root where the credentials also live.
 *
 * ONE KMS KEY PER ENVIRONMENT (the D-L13 answer). `keyId` is the environment's
 * key ARN or alias; it is recorded on every row, which is what allows a second
 * key to be introduced during a rotation without a flag day.
 *
 * NEVER LOG A RESPONSE FROM THIS CLIENT. `Plaintext` is a data key.
 */

/** The two calls this provider makes, and nothing else. */
export interface KmsClientLike {
  generateDataKey(input: {
    KeyId: string;
    KeySpec: 'AES_256';
  }): Promise<{ Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array; KeyId?: string }>;
  decrypt(input: {
    CiphertextBlob: Uint8Array;
    KeyId: string;
  }): Promise<{ Plaintext?: Uint8Array }>;
}

export interface AwsKmsKeyProviderOptions {
  client: KmsClientLike;
  /** The environment's KMS key: an ARN or an alias. Not a secret. */
  keyId: string;
}

class AwsKmsKeyProvider implements KeyProvider {
  readonly keyId: string;
  readonly description = 'AWS KMS';
  readonly #client: KmsClientLike;

  constructor(options: AwsKmsKeyProviderOptions) {
    this.#client = options.client;
    this.keyId = options.keyId;
  }

  async generateDataKey(): Promise<DataKey> {
    const response = await this.#client.generateDataKey({
      KeyId: this.keyId,
      KeySpec: 'AES_256',
    });
    if (response.Plaintext === undefined || response.CiphertextBlob === undefined) {
      throw new KeyManagementError('KMS returned no data key', this.keyId);
    }
    return {
      plaintext: Buffer.from(response.Plaintext),
      wrapped: Buffer.from(response.CiphertextBlob),
      // The key the row records is the one KMS says it used, not the one asked
      // for: with an alias those differ, and the row must name the real key or
      // a rotation cannot tell which rows are still on the old one.
      keyId: response.KeyId ?? this.keyId,
    };
  }

  async unwrapDataKey(wrapped: Buffer, keyId: string): Promise<Buffer> {
    const response = await this.#client.decrypt({ CiphertextBlob: wrapped, KeyId: keyId });
    if (response.Plaintext === undefined) {
      throw new KeyManagementError('KMS returned no plaintext data key', keyId);
    }
    return Buffer.from(response.Plaintext);
  }
}

export function createAwsKmsKeyProvider(options: AwsKmsKeyProviderOptions): KeyProvider {
  return new AwsKmsKeyProvider(options);
}
