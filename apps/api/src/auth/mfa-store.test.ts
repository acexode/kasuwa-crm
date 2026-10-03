import {
  base32Decode,
  createDevelopmentKeyProvider,
  generateTotpSecret,
  mfaSecretAad,
  sealSecret,
  totpCode,
} from '@kasuwa/auth-crypto';
import type { QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import { StepUpBody } from './auth.schemas';
import {
  issueBackupCodes,
  matchBackupCode,
  matchTotp,
  otpauthUri,
  startTotpEnrolment,
  type FactorRow,
  type Tx,
} from './mfa-store';

/**
 * The enrolment and recovery primitives (T-0012), without a database.
 *
 * Invented fixture values only: the ids below name nobody, and every secret is
 * generated per run.
 */

const TENANT = '66666666-6666-4666-8666-666666666666';
const USER = '77777777-7777-4777-8777-777777777777';
const FACTOR = '88888888-8888-4888-8888-888888888888';

/** Records every statement; answers SELECTs from `rows`. */
function recordingTx(rows: QueryResultRow[] = []): Tx & {
  statements: { text: string; values: readonly unknown[] }[];
} {
  const statements: { text: string; values: readonly unknown[] }[] = [];
  return {
    statements,
    query: async <T extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
      statements.push({ text, values });
      return (/^\s*SELECT/u.test(text) ? rows : []) as T[];
    },
  };
}

async function sealedFactor(secret: string, lastUsedStep: number | null): Promise<FactorRow> {
  const provider = createDevelopmentKeyProvider();
  const sealed = await sealSecret(provider, secret, mfaSecretAad(TENANT, FACTOR));
  return {
    id: FACTOR,
    secret: null,
    secret_ciphertext: sealed.ciphertext,
    secret_wrapped_key: sealed.wrappedKey,
    secret_key_id: sealed.keyId,
    secret_algorithm: sealed.algorithm,
    last_used_step: lastUsedStep === null ? null : String(lastUsedStep),
    created_at: new Date(),
  };
}

describe('otpauthUri', () => {
  it('is a Key Uri Format URI with an issuer and the same secret', () => {
    const secret = generateTotpSecret();
    const uri = new URL(otpauthUri('founder@mfa-store.test', secret));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.hostname).toBe('totp');
    expect(uri.searchParams.get('secret')).toBe(secret);
    expect(uri.searchParams.get('issuer')).toBe('Kasuwa');
    expect(base32Decode(secret).length).toBeGreaterThanOrEqual(20);
  });
});

describe('startTotpEnrolment', () => {
  it('deletes the earlier pending factor and writes the new one envelope-only', async () => {
    const tx = recordingTx();
    const secret = await startTotpEnrolment(tx, createDevelopmentKeyProvider(), TENANT, USER);

    const [remove, insert] = tx.statements;
    expect(remove?.text).toMatch(/DELETE FROM user_mfa_factor[\s\S]*confirmed_at IS NULL/u);
    expect(insert?.text).toMatch(/INSERT INTO user_mfa_factor/u);
    // The legacy plaintext column is written as a literal NULL, and the secret
    // appears in no parameter in any form.
    expect(insert?.text).toMatch(/NULL, \$4/u);
    const raw = base32Decode(secret);
    for (const value of insert?.values ?? []) {
      const text = Buffer.isBuffer(value) ? value.toString('hex') : String(value);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(raw.toString('hex'));
    }
  });
});

describe('matchTotp', () => {
  it('matches, refuses a wrong code, and refuses a step already used', async () => {
    const provider = createDevelopmentKeyProvider();
    const secret = generateTotpSecret();
    const now = Math.floor(Date.now() / 30_000);
    const code = totpCode(secret);

    const fresh = await matchTotp(provider, TENANT, await sealedFactor(secret, null), code);
    expect(fresh.kind).toBe('match');

    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    expect((await matchTotp(provider, TENANT, await sealedFactor(secret, null), wrong)).kind).toBe(
      'wrong',
    );

    const used = await matchTotp(provider, TENANT, await sealedFactor(secret, now + 1), code);
    expect(used.kind).toBe('replayed');

    expect((await matchTotp(provider, TENANT, undefined, code)).kind).toBe('wrong');
  });
});

describe('backup codes in the store', () => {
  it('issues codes whose stored form is keyed, and matches each one back', async () => {
    const provider = createDevelopmentKeyProvider();
    const tx = recordingTx();
    const codes = await issueBackupCodes(tx, provider, TENANT, USER);
    expect(codes).toHaveLength(10);

    const inserts = tx.statements.filter((statement) => statement.text.includes('INSERT'));
    expect(inserts).toHaveLength(codes.length);
    const rows = inserts.map((statement, index) => {
      const [, , , codeHash, wrapped, keyId, algorithm] = statement.values as [
        string,
        string,
        string,
        Buffer,
        Buffer,
        string,
        string,
      ];
      // Nothing recognisable of the code in what is stored.
      const bare = (codes[index] ?? '').replace('-', '');
      expect(codeHash.includes(Buffer.from(bare))).toBe(false);
      return {
        id: `row-${index}`,
        code_hash: codeHash,
        hash_key_wrapped: wrapped,
        hash_key_id: keyId,
        hash_algorithm: algorithm,
      };
    });

    const reader = recordingTx(rows);
    expect(await matchBackupCode(reader, provider, TENANT, USER, codes[3] ?? '')).toBe('row-3');
    expect(
      await matchBackupCode(reader, provider, TENANT, USER, (codes[3] ?? '').toUpperCase()),
    ).toBe('row-3');
    expect(await matchBackupCode(reader, provider, TENANT, USER, 'aaaaa-aaaaa')).toBeNull();
    // Another user's id gives another hash: a row copied across users matches nothing.
    expect(
      await matchBackupCode(
        reader,
        provider,
        TENANT,
        '99999999-9999-4999-8999-999999999999',
        codes[3] ?? '',
      ),
    ).toBeNull();
    // Not even shaped like a code: no query at all.
    const untouched = recordingTx(rows);
    expect(await matchBackupCode(untouched, provider, TENANT, USER, '123456')).toBeNull();
    expect(untouched.statements).toHaveLength(0);
  });
});

describe('StepUpBody', () => {
  it('requires a code, defaults to totp, and refuses a password', () => {
    expect(StepUpBody.parse({ code: '123456' }).method).toBe('totp');
    expect(StepUpBody.safeParse({}).success).toBe(false);
    expect(StepUpBody.safeParse({ password: 'not-a-factor' }).success).toBe(false);
    expect(StepUpBody.safeParse({ code: '123456', password: 'x' }).success).toBe(false);
    expect(StepUpBody.safeParse({ code: 'x', method: 'sms' }).success).toBe(false);
  });
});
