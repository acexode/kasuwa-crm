import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDevelopmentKeyProvider, DEVELOPMENT_KEY_ID } from './development-key-provider';
import { ENVELOPE_ALGORITHM, mfaSecretAad, openSecret, sealSecret } from './envelope';
import { KeyManagementError } from './key-provider';

/**
 * Envelope encryption (D-L13).
 *
 * The fixture values here are invented and obviously so. No real TOTP secret,
 * no real identifier.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const FACTOR = '22222222-2222-4222-8222-222222222222';
const OTHER_FACTOR = '33333333-3333-4333-8333-333333333333';
const SECRET = 'JBSWY3DPEHPK3PXP'; // RFC 4648 base32, invented, not in use anywhere.

describe('envelope encryption', () => {
  it('round-trips a secret and records the key id and algorithm', async () => {
    const provider = createDevelopmentKeyProvider();
    const aad = mfaSecretAad(TENANT, FACTOR);

    const sealed = await sealSecret(provider, SECRET, aad);

    expect(sealed.keyId).toBe(DEVELOPMENT_KEY_ID);
    expect(sealed.algorithm).toBe(ENVELOPE_ALGORITHM);
    expect(await openSecret(provider, sealed, aad)).toBe(SECRET);
  });

  it('does not store the plaintext anywhere in the sealed value', async () => {
    const provider = createDevelopmentKeyProvider();
    const sealed = await sealSecret(provider, SECRET, mfaSecretAad(TENANT, FACTOR));

    expect(sealed.ciphertext.toString('latin1')).not.toContain(SECRET);
    expect(sealed.wrappedKey.toString('latin1')).not.toContain(SECRET);
  });

  it('gives every secret its own data key — which is what makes rotation possible', async () => {
    const provider = createDevelopmentKeyProvider();
    const aad = mfaSecretAad(TENANT, FACTOR);

    const first = await sealSecret(provider, SECRET, aad);
    const second = await sealSecret(provider, SECRET, aad);

    expect(first.wrappedKey.equals(second.wrappedKey)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it('refuses a ciphertext moved onto another row', async () => {
    const provider = createDevelopmentKeyProvider();
    const sealed = await sealSecret(provider, SECRET, mfaSecretAad(TENANT, FACTOR));

    await expect(
      openSecret(provider, sealed, mfaSecretAad(TENANT, OTHER_FACTOR)),
    ).rejects.toBeInstanceOf(KeyManagementError);
  });

  it('refuses a tampered ciphertext rather than returning rubbish', async () => {
    const provider = createDevelopmentKeyProvider();
    const aad = mfaSecretAad(TENANT, FACTOR);
    const sealed = await sealSecret(provider, SECRET, aad);
    const tampered = Buffer.from(sealed.ciphertext);
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 0xff, tampered.length - 1);

    await expect(
      openSecret(provider, { ...sealed, ciphertext: tampered }, aad),
    ).rejects.toBeInstanceOf(KeyManagementError);
  });

  it('refuses a wrapped key from a different master key', async () => {
    const aad = mfaSecretAad(TENANT, FACTOR);
    const sealed = await sealSecret(createDevelopmentKeyProvider(), SECRET, aad);
    const otherProvider = createDevelopmentKeyProvider({ masterKey: randomBytes(32) });

    await expect(openSecret(otherProvider, sealed, aad)).rejects.toBeInstanceOf(
      KeyManagementError,
    );
  });

  it('refuses an unknown algorithm instead of guessing at the format', async () => {
    const provider = createDevelopmentKeyProvider();
    const aad = mfaSecretAad(TENANT, FACTOR);
    const sealed = await sealSecret(provider, SECRET, aad);

    await expect(
      openSecret(provider, { ...sealed, algorithm: 'A256GCM-ENV2' }, aad),
    ).rejects.toThrow(/Unknown envelope algorithm/u);
  });

  it('never puts key material or plaintext in an error message', async () => {
    const provider = createDevelopmentKeyProvider();
    const aad = mfaSecretAad(TENANT, FACTOR);
    const sealed = await sealSecret(provider, SECRET, aad);

    const error: Error = await openSecret(
      provider,
      sealed,
      mfaSecretAad(TENANT, OTHER_FACTOR),
    ).then(
      () => new Error('it did not throw'),
      (thrown: unknown) => thrown as Error,
    );

    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(sealed.ciphertext.toString('base64'));
    expect(error.message).not.toContain(sealed.wrappedKey.toString('base64'));
    // The key id is not a secret, and an operator needs it.
    expect(error.message).toContain(DEVELOPMENT_KEY_ID);
  });

  it('wraps a data key differently under a different key id, so a rotation is real', async () => {
    const masterKey = randomBytes(32);
    const current = createDevelopmentKeyProvider({ masterKey, keyId: 'local-dev-1' });
    const next = createDevelopmentKeyProvider({ masterKey, keyId: 'local-dev-2' });
    const aad = mfaSecretAad(TENANT, FACTOR);

    const sealed = await sealSecret(current, SECRET, aad);
    expect(sealed.keyId).toBe('local-dev-1');

    // A row still naming the old key id opens under either provider, because
    // the key id travels with the row rather than with the process. That is
    // what lets the two keys be live at once during a rotation.
    expect(await openSecret(next, sealed, aad)).toBe(SECRET);

    const rotated = await sealSecret(next, SECRET, aad);
    expect(rotated.keyId).toBe('local-dev-2');
    expect(rotated.wrappedKey.equals(sealed.wrappedKey)).toBe(false);
  });

  it('rejects a master key that is not 32 bytes', () => {
    expect(() => createDevelopmentKeyProvider({ masterKey: randomBytes(16) })).toThrow(
      KeyManagementError,
    );
  });
});
