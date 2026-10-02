import { createAwsKmsKeyProvider, type KmsClientLike } from './aws-kms-key-provider';
import { createDevelopmentKeyProvider } from './development-key-provider';
import { KeyManagementError, type KeyProvider } from './key-provider';

/**
 * Build the key provider a deployment is configured for.
 *
 * Takes settings rather than reading the environment, for the reason
 * `AppModule.forRoot` does: the composition root is the one place that reads
 * configuration, and a test must be able to stand a provider up without
 * mutating process.env.
 */
export interface KeyProviderSettings {
  provider: 'local' | 'aws-kms';
  /** The environment's key id. Optional for `local`, required for `aws-kms`. */
  keyId?: string | undefined;
  /** Base64 32-byte master key for `local`. Optional; development has a default. */
  localMasterKeyBase64?: string | undefined;
  /**
   * The KMS client, injected at the composition root.
   *
   * No cloud credentials and no SDK dependency live in this package (D-A4 gates
   * spend and nothing is deployed), so asking for `aws-kms` without supplying a
   * client is a configuration error and says so.
   */
  kmsClient?: KmsClientLike | undefined;
}

export function createKeyProvider(settings: KeyProviderSettings): KeyProvider {
  if (settings.provider === 'aws-kms') {
    if (settings.keyId === undefined) {
      throw new KeyManagementError('KASUWA_KMS_PROVIDER=aws-kms requires KASUWA_KMS_KEY_ID');
    }
    if (settings.kmsClient === undefined) {
      throw new KeyManagementError(
        'KASUWA_KMS_PROVIDER=aws-kms is configured but no KMS client was supplied. ' +
          'Nothing is provisioned yet (D-A4); see packages/auth-crypto/src/aws-kms-key-provider.ts.',
        settings.keyId,
      );
    }
    return createAwsKmsKeyProvider({ client: settings.kmsClient, keyId: settings.keyId });
  }

  const masterKey =
    settings.localMasterKeyBase64 === undefined
      ? undefined
      : Buffer.from(settings.localMasterKeyBase64, 'base64');

  return createDevelopmentKeyProvider({
    ...(masterKey === undefined ? {} : { masterKey }),
    ...(settings.keyId === undefined ? {} : { keyId: settings.keyId }),
  });
}
