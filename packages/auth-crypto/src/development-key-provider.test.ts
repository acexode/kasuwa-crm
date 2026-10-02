import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevelopmentKeyProvider } from './development-key-provider';
import { createKeyProvider } from './key-provider-factory';
import { KeyManagementError, type KmsClientLike } from './index';

/**
 * The development key provider must be impossible to run in production.
 *
 * Same control, same reasoning and the same test shape as
 * `assertAuthModeIsSafe` in @kasuwa/config: a development-only mechanism that
 * can be left switched on by forgetting to configure something is not a
 * control. @kasuwa/config refuses to BOOT on it; this refuses to be
 * CONSTRUCTED, which is the layer that survives somebody building the provider
 * directly.
 *
 * The guard reads the real environment by design, so there is nothing to
 * inject; `vi.stubEnv` is used rather than touching process.env directly,
 * which the lint rule reserves for @kasuwa/config.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('development key provider', () => {
  it('refuses to be constructed under NODE_ENV=production', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => createDevelopmentKeyProvider()).toThrow(KeyManagementError);
    expect(() => createDevelopmentKeyProvider()).toThrow(/NODE_ENV=production/u);
  });

  it('refuses even when the caller supplies its own master key', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => createDevelopmentKeyProvider({ masterKey: Buffer.alloc(32, 7) })).toThrow(
      KeyManagementError,
    );
  });

  it('is constructible in development and in test', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(createDevelopmentKeyProvider().keyId).toBe('local-dev-1');
    vi.stubEnv('NODE_ENV', 'test');
    expect(createDevelopmentKeyProvider().keyId).toBe('local-dev-1');
  });

  it('describes itself as a development provider, for the boot log', () => {
    expect(createDevelopmentKeyProvider().description).toMatch(/development/u);
  });
});

describe('createKeyProvider', () => {
  it('builds the development provider for `local`', () => {
    expect(createKeyProvider({ provider: 'local' }).description).toMatch(/development/u);
  });

  it('accepts a base64 master key for `local`', async () => {
    const provider = createKeyProvider({
      provider: 'local',
      localMasterKeyBase64: Buffer.alloc(32, 9).toString('base64'),
      keyId: 'local-dev-9',
    });
    const dataKey = await provider.generateDataKey();
    expect(dataKey.keyId).toBe('local-dev-9');
    expect(dataKey.plaintext).toHaveLength(32);
  });

  it('refuses `aws-kms` without a key id', () => {
    expect(() => createKeyProvider({ provider: 'aws-kms' })).toThrow(/KASUWA_KMS_KEY_ID/u);
  });

  it('refuses `aws-kms` without a client — nothing is provisioned yet (D-A4)', () => {
    expect(() => createKeyProvider({ provider: 'aws-kms', keyId: 'alias/kasuwa-dev' })).toThrow(
      /no KMS client was supplied/u,
    );
  });

  it('builds the KMS provider when a client is injected, and records the key KMS names', async () => {
    const client: KmsClientLike = {
      generateDataKey: () =>
        Promise.resolve({
          Plaintext: new Uint8Array(32).fill(1),
          CiphertextBlob: new Uint8Array([9, 9, 9]),
          KeyId: 'arn:aws:kms:eu-west-1:000000000000:key/resolved',
        }),
      decrypt: () => Promise.resolve({ Plaintext: new Uint8Array(32).fill(1) }),
    };

    const provider = createKeyProvider({
      provider: 'aws-kms',
      keyId: 'alias/kasuwa-dev',
      kmsClient: client,
    });
    const dataKey = await provider.generateDataKey();

    // The ALIAS was asked for; the resolved ARN is what the row records, so a
    // rotation can tell which rows are still on the old key.
    expect(dataKey.keyId).toBe('arn:aws:kms:eu-west-1:000000000000:key/resolved');
  });

  it('throws rather than returning an empty key when KMS answers oddly', async () => {
    const client: KmsClientLike = {
      generateDataKey: () => Promise.resolve({}),
      decrypt: () => Promise.resolve({}),
    };
    const provider = createKeyProvider({
      provider: 'aws-kms',
      keyId: 'alias/kasuwa-dev',
      kmsClient: client,
    });

    await expect(provider.generateDataKey()).rejects.toBeInstanceOf(KeyManagementError);
    await expect(provider.unwrapDataKey(Buffer.from([1]), 'alias/kasuwa-dev')).rejects.toBeInstanceOf(
      KeyManagementError,
    );
  });
});
