import {
  createDevelopmentKeyProvider,
  generateTotpSecret,
  mfaSecretAad,
  sealSecret,
  totpCode,
  type KeyProvider,
} from '@kasuwa/auth-crypto';
import type { TenantTx } from '@kasuwa/db';
import type { QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTH_POLICY } from './auth.policy';
import { MfaService } from './mfa.service';
import type { FactorRow } from './mfa-store';

/**
 * Confirming a replacement factor (T-0012, D-L58), without a database.
 *
 * Codes kept with a lost device must not outlive it: the confirm kills every
 * unused backup code and returns a fresh set, all after the per-user lock and
 * in the same transaction as the factor swap.
 *
 * Invented fixture values only: the ids below name nobody, and every secret is
 * generated per run.
 */

const TENANT = '12121212-1212-4121-8121-121212121212';
const USER = '34343434-3434-4343-8343-343434343434';
const FACTOR = '56565656-5656-4565-8565-565656565656';
const SESSION = '78787878-7878-4787-8787-787878787878';

const USER_LOCK = /FROM "user" WHERE tenant_id = \$1 AND id = \$2 FOR UPDATE/u;
const RETIRES_CODES =
  /^\s*UPDATE user_mfa_backup_code\s+SET used_at = now\(\)[\s\S]*used_at IS NULL/u;
const DELETES_CODES = /^\s*DELETE FROM user_mfa_backup_code/u;
const INSERTS_CODE = /^\s*INSERT INTO user_mfa_backup_code/u;
const PROMOTES_FACTOR = /^\s*UPDATE user_mfa_factor\s+SET confirmed_at = now\(\)/u;

async function pendingFactor(provider: KeyProvider, secret: string): Promise<FactorRow> {
  const sealed = await sealSecret(provider, secret, mfaSecretAad(TENANT, FACTOR));
  return {
    id: FACTOR,
    secret: null,
    secret_ciphertext: sealed.ciphertext,
    secret_wrapped_key: sealed.wrappedKey,
    secret_key_id: sealed.keyId,
    secret_algorithm: sealed.algorithm,
    last_used_step: null,
    created_at: new Date(),
  };
}

/**
 * A tenant tx that answers the pending-factor read with `pending`, lets the
 * promote succeed, reports `unusedCodes` rows retired, and records everything.
 */
function scriptedTx(
  pending: FactorRow | undefined,
  unusedCodes = 3,
): TenantTx & { statements: { text: string; values: readonly unknown[] }[] } {
  const statements: { text: string; values: readonly unknown[] }[] = [];
  return {
    session: { tenantId: TENANT, userId: USER, programmeIds: [] },
    statements,
    query: async <T extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
      statements.push({ text, values });
      if (
        /FROM user_mfa_factor[\s\S]*confirmed_at IS NULL/u.test(text) &&
        /^\s*SELECT/u.test(text)
      ) {
        return (pending === undefined ? [] : [pending]) as unknown as T[];
      }
      if (PROMOTES_FACTOR.test(text)) {
        return [{ confirmed_at: new Date() }] as unknown as T[];
      }
      if (RETIRES_CODES.test(text)) {
        return Array.from({ length: unusedCodes }, (_, i) => ({
          id: `old-${i}`,
        })) as unknown as T[];
      }
      return [] as T[];
    },
  };
}

function service(provider: KeyProvider): MfaService {
  // Lockout off, so the fake tx need not answer the rate-limit key read-back.
  return new MfaService({ ...DEFAULT_AUTH_POLICY, mfaMaxAttempts: 0 }, provider);
}

function indexOf(statements: { text: string }[], pattern: RegExp): number {
  return statements.findIndex((s) => pattern.test(s.text));
}

describe('MfaService.confirmReplacement (D-L58)', () => {
  it('kills every unused backup code and returns a fresh set', async () => {
    const provider = createDevelopmentKeyProvider();
    const secret = generateTotpSecret();
    const tx = scriptedTx(await pendingFactor(provider, secret));

    const result = await service(provider).confirmReplacement(tx, SESSION, {
      code: totpCode(secret),
    });

    expect('backupCodes' in result, 'the confirm response carries a fresh set').toBe(true);
    const { backupCodes } = result as { backupCodes: string[] };
    expect(backupCodes).toHaveLength(10);
    expect(new Set(backupCodes).size).toBe(10);

    const retire = tx.statements.find((s) => RETIRES_CODES.test(s.text));
    expect(retire, 'unused codes are marked used').toBeDefined();
    expect(retire?.text).toMatch(/tenant_id = \$1 AND user_id = \$2/u);
    expect(retire?.values).toEqual([TENANT, USER]);

    expect(tx.statements.filter((s) => INSERTS_CODE.test(s.text))).toHaveLength(10);
  });

  it('does it under the per-user lock, after the factor swap, before the fresh set', async () => {
    const provider = createDevelopmentKeyProvider();
    const secret = generateTotpSecret();
    const tx = scriptedTx(await pendingFactor(provider, secret));

    await service(provider).confirmReplacement(tx, SESSION, { code: totpCode(secret) });

    const lock = indexOf(tx.statements, USER_LOCK);
    const promote = indexOf(tx.statements, PROMOTES_FACTOR);
    const retire = indexOf(tx.statements, RETIRES_CODES);
    const replaceSet = indexOf(tx.statements, DELETES_CODES);
    const firstInsert = indexOf(tx.statements, INSERTS_CODE);

    expect(lock).toBeGreaterThanOrEqual(0);
    expect(promote).toBeGreaterThan(lock);
    expect(retire).toBeGreaterThan(promote);
    expect(replaceSet).toBeGreaterThan(retire);
    expect(firstInsert).toBeGreaterThan(replaceSet);
  });

  it('touches no backup code and issues none when the code is wrong', async () => {
    const provider = createDevelopmentKeyProvider();
    const secret = generateTotpSecret();
    const tx = scriptedTx(await pendingFactor(provider, secret));
    const code = totpCode(secret);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');

    const result = await service(provider).confirmReplacement(tx, SESSION, { code: wrong });

    expect('backupCodes' in result).toBe(false);
    expect(tx.statements.some((s) => /user_mfa_backup_code/u.test(s.text))).toBe(false);
  });

  it('touches no backup code when there is no pending factor', async () => {
    const provider = createDevelopmentKeyProvider();
    const tx = scriptedTx(undefined);

    const result = await service(provider).confirmReplacement(tx, SESSION, { code: '123456' });

    expect('backupCodes' in result).toBe(false);
    expect(tx.statements.some((s) => /user_mfa_backup_code/u.test(s.text))).toBe(false);
  });
});
