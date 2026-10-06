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
  confirmPendingTotp,
  issueBackupCodes,
  matchBackupCode,
  matchTotp,
  otpauthUri,
  retireUnusedBackupCodes,
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

/**
 * A tx that answers "does a confirmed factor exist" as told, and records
 * everything. The user lock and the UPDATE ... RETURNING are answered too.
 */
function scriptedTx(options: { confirmedExists: boolean; promotes: boolean }): Tx & {
  statements: { text: string; values: readonly unknown[] }[];
} {
  const statements: { text: string; values: readonly unknown[] }[] = [];
  return {
    statements,
    query: async <T extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
      statements.push({ text, values });
      if (/FROM user_mfa_factor[\s\S]*confirmed_at IS NOT NULL[\s\S]*LIMIT 1/u.test(text)) {
        return (options.confirmedExists ? [{ ok: 1 }] : []) as unknown as T[];
      }
      if (/^\s*UPDATE user_mfa_factor[\s\S]*RETURNING confirmed_at/u.test(text)) {
        return (options.promotes ? [{ confirmed_at: new Date() }] : []) as unknown as T[];
      }
      if (/FOR UPDATE/u.test(text)) {
        return [{ id: values[1] }] as unknown as T[];
      }
      return [] as T[];
    },
  };
}

const USER_LOCK = /^SELECT id FROM "user" WHERE tenant_id = \$1 AND id = \$2 FOR UPDATE$/u;
const DELETES_CONFIRMED = /DELETE FROM user_mfa_factor[\s\S]*confirmed_at IS NOT NULL/u;

describe('startTotpEnrolment', () => {
  it('locks the user row first, then deletes the earlier pending factor and writes the new one envelope-only', async () => {
    const tx = recordingTx();
    const secret =
      (await startTotpEnrolment(tx, createDevelopmentKeyProvider(), TENANT, USER, 'replace')) ??
      '';

    const [lock, remove, insert] = tx.statements;
    expect(lock?.text).toMatch(USER_LOCK);
    expect(lock?.values).toEqual([TENANT, USER]);
    expect(remove?.text).toMatch(/DELETE FROM user_mfa_factor[\s\S]*confirmed_at IS NULL/u);
    expect(insert?.text).toMatch(/INSERT INTO user_mfa_factor/u);
    // The legacy plaintext column is not named at all (kasuwa_auth holds no
    // INSERT on it since T-0049, so naming it, even as NULL, is a 42501), and
    // the secret appears in no parameter in any form.
    const columns = /INSERT INTO user_mfa_factor\s*\(([^)]*)\)/u.exec(insert?.text ?? '')?.[1] ?? '';
    const named = columns.split(',').map((column) => column.trim());
    expect(named).toContain('secret_ciphertext');
    expect(named).not.toContain('secret');
    const raw = base32Decode(secret);
    for (const value of insert?.values ?? []) {
      const text = Buffer.isBuffer(value) ? value.toString('hex') : String(value);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(raw.toString('hex'));
    }
  });

  it('in first mode, checks for a confirmed factor UNDER the lock and writes nothing if one exists', async () => {
    const tx = scriptedTx({ confirmedExists: true, promotes: true });
    const secret = await startTotpEnrolment(
      tx,
      createDevelopmentKeyProvider(),
      TENANT,
      USER,
      'first',
    );
    expect(secret).toBeNull();
    expect(tx.statements[0]?.text).toMatch(USER_LOCK);
    expect(tx.statements[1]?.text).toMatch(/confirmed_at IS NOT NULL/u);
    expect(tx.statements.some((s) => /DELETE|INSERT/u.test(s.text))).toBe(false);
  });

  it('in first mode with no confirmed factor, proceeds after the lock and the check', async () => {
    const tx = scriptedTx({ confirmedExists: false, promotes: true });
    const secret = await startTotpEnrolment(
      tx,
      createDevelopmentKeyProvider(),
      TENANT,
      USER,
      'first',
    );
    expect(secret).toEqual(expect.any(String));
    expect(tx.statements.map((s) => s.text.trim().split(/\s+/u)[0])).toEqual([
      'SELECT',
      'SELECT',
      'DELETE',
      'INSERT',
    ]);
  });
});

describe('confirmPendingTotp', () => {
  it('first mode never deletes a confirmed factor, and promotes only the pending row', async () => {
    const tx = scriptedTx({ confirmedExists: false, promotes: true });
    const outcome = await confirmPendingTotp(tx, TENANT, USER, FACTOR, 42, 'first');
    expect(outcome.kind).toBe('confirmed');
    expect(tx.statements[0]?.text).toMatch(USER_LOCK);
    expect(tx.statements.some((s) => DELETES_CONFIRMED.test(s.text))).toBe(false);
    expect(tx.statements.some((s) => /^\s*DELETE/u.test(s.text))).toBe(false);
  });

  it('first mode re-checks under the lock and refuses, writing nothing, if a factor appeared', async () => {
    const tx = scriptedTx({ confirmedExists: true, promotes: true });
    const outcome = await confirmPendingTotp(tx, TENANT, USER, FACTOR, 42, 'first');
    expect(outcome.kind).toBe('already_enrolled');
    expect(tx.statements[0]?.text).toMatch(USER_LOCK);
    expect(tx.statements.some((s) => /^\s*(DELETE|UPDATE)/u.test(s.text))).toBe(false);
  });

  it('replace mode locks, retires the old confirmed factor, then promotes', async () => {
    const tx = scriptedTx({ confirmedExists: true, promotes: true });
    const outcome = await confirmPendingTotp(tx, TENANT, USER, FACTOR, 42, 'replace');
    expect(outcome.kind).toBe('confirmed');
    expect(tx.statements[0]?.text).toMatch(USER_LOCK);
    expect(tx.statements[1]?.text).toMatch(DELETES_CONFIRMED);
    expect(tx.statements[2]?.text).toMatch(/^\s*UPDATE user_mfa_factor/u);
  });

  it('reports a lost race when the pending row is gone', async () => {
    const tx = scriptedTx({ confirmedExists: false, promotes: false });
    expect((await confirmPendingTotp(tx, TENANT, USER, FACTOR, 42, 'first')).kind).toBe(
      'lost_race',
    );
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

describe('retireUnusedBackupCodes (D-L58)', () => {
  it("marks only this user's unused codes used, scoped by tenant and user, and counts them", async () => {
    const statements: { text: string; values: readonly unknown[] }[] = [];
    const tx: Tx = {
      query: async <T extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
        statements.push({ text, values });
        return [{ id: 'a' }, { id: 'b' }] as unknown as T[];
      },
    };
    expect(await retireUnusedBackupCodes(tx, TENANT, USER)).toBe(2);
    expect(statements).toHaveLength(1);
    const [only] = statements;
    expect(only?.text).toMatch(/^\s*UPDATE user_mfa_backup_code\s+SET used_at = now\(\)/u);
    expect(only?.text).toMatch(/tenant_id = \$1 AND user_id = \$2 AND used_at IS NULL/u);
    expect(only?.text).not.toMatch(/DELETE/u);
    expect(only?.values).toEqual([TENANT, USER]);
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
