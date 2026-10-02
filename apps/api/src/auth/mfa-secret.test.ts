import {
  createDevelopmentKeyProvider,
  mfaSecretAad,
  sealSecret,
  type KeyProvider,
} from '@kasuwa/auth-crypto';
import { describe, expect, it } from 'vitest';
import {
  MfaSecretUnavailableError,
  resolveTotpSecret,
  type MfaSecretRow,
} from './mfa-secret';

/**
 * Reading a TOTP secret during the expand phase (D-L13, migration 0005).
 *
 * Invented fixture values only.
 */

const TENANT = '44444444-4444-4444-8444-444444444444';
const FACTOR = '55555555-5555-4555-8555-555555555555';
const SECRET = 'KRSXG5BAMZXXEIDB'; // invented base32, not a real enrolment

function legacyRow(secret: string | null): MfaSecretRow {
  return {
    id: FACTOR,
    secret,
    secret_ciphertext: null,
    secret_wrapped_key: null,
    secret_key_id: null,
    secret_algorithm: null,
  };
}

async function sealedRow(provider: KeyProvider, secret: string): Promise<MfaSecretRow> {
  const sealed = await sealSecret(provider, secret, mfaSecretAad(TENANT, FACTOR));
  return {
    id: FACTOR,
    // The expand phase writes BOTH. The envelope must win.
    secret: 'OLDOLDOLDOLDOLDO',
    secret_ciphertext: sealed.ciphertext,
    secret_wrapped_key: sealed.wrappedKey,
    secret_key_id: sealed.keyId,
    secret_algorithm: sealed.algorithm,
  };
}

describe('resolveTotpSecret', () => {
  it('reads the envelope when there is one, in preference to the plaintext column', async () => {
    const provider = createDevelopmentKeyProvider();
    const row = await sealedRow(provider, SECRET);

    expect(await resolveTotpSecret(provider, TENANT, row)).toBe(SECRET);
  });

  it('falls back to the legacy plaintext column for a row written before 0005', async () => {
    const provider = createDevelopmentKeyProvider();

    expect(await resolveTotpSecret(provider, TENANT, legacyRow(SECRET))).toBe(SECRET);
  });

  it('THROWS when the envelope cannot be opened — it must never look like "no factor"', async () => {
    const provider = createDevelopmentKeyProvider();
    const row = await sealedRow(provider, SECRET);
    const ciphertext = Buffer.from(row.secret_ciphertext ?? Buffer.alloc(1));
    ciphertext.writeUInt8(ciphertext.readUInt8(ciphertext.length - 1) ^ 0xff, ciphertext.length - 1);
    const corrupted: MfaSecretRow = { ...row, secret_ciphertext: ciphertext };

    await expect(resolveTotpSecret(provider, TENANT, corrupted)).rejects.toBeInstanceOf(
      MfaSecretUnavailableError,
    );
  });

  it('THROWS when the key is wrong, rather than silently dropping the second factor', async () => {
    const row = await sealedRow(createDevelopmentKeyProvider(), SECRET);
    const otherKey = createDevelopmentKeyProvider({ masterKey: Buffer.alloc(32, 3) });

    await expect(resolveTotpSecret(otherKey, TENANT, row)).rejects.toBeInstanceOf(
      MfaSecretUnavailableError,
    );
  });

  it('THROWS when the ciphertext belongs to another tenant, even if it decrypts there', async () => {
    const provider = createDevelopmentKeyProvider();
    const row = await sealedRow(provider, SECRET);

    await expect(
      resolveTotpSecret(provider, '66666666-6666-4666-8666-666666666666', row),
    ).rejects.toBeInstanceOf(MfaSecretUnavailableError);
  });

  it('THROWS when a row has neither form', async () => {
    const provider = createDevelopmentKeyProvider();

    await expect(resolveTotpSecret(provider, TENANT, legacyRow(null))).rejects.toBeInstanceOf(
      MfaSecretUnavailableError,
    );
  });

  it('never puts the secret or key material in the error it raises', async () => {
    const provider = createDevelopmentKeyProvider();
    const row = await sealedRow(provider, SECRET);
    const otherKey = createDevelopmentKeyProvider({ masterKey: Buffer.alloc(32, 3) });

    const error: Error = await resolveTotpSecret(otherKey, TENANT, row).then(
      () => new Error('it did not throw'),
      (thrown: unknown) => thrown as Error,
    );

    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(row.secret ?? '');
    expect(error.message).not.toContain(row.secret_ciphertext?.toString('base64') ?? 'x');
    expect(error.message).not.toContain(row.secret_wrapped_key?.toString('base64') ?? 'x');
    // What an operator does need: which row, and which key.
    expect(error.message).toContain(FACTOR);
  });
});
