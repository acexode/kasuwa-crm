import { timingSafeEqual } from 'node:crypto';
import {
  BACKUP_CODE_HASH_ALGORITHM,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  matchTotpStep,
  mfaSecretAad,
  normaliseBackupCode,
  sealSecret,
  type KeyProvider,
} from '@kasuwa/auth-crypto';
import { newId } from '@kasuwa/db';
import type { QueryResultRow } from 'pg';
import { resolveTotpSecret, type MfaSecretRow } from './mfa-secret';

/**
 * The second-factor tables, for enrolment and recovery (T-0012).
 *
 * Shared by the challenge-bound routes in `AuthService` (an `AuthTx`) and the
 * session-bound routes in `MfaService` (a `TenantTx`). Both satisfy `Tx`, and
 * every statement here carries an explicit `tenant_id` predicate as well as
 * relying on RLS — two independent layers (CLAUDE.md section 2, rule 3).
 *
 * WHAT NEVER LEAVES THIS FILE. A TOTP secret leaves exactly once, as the return
 * value of `startTotpEnrolment`, to be put in the single enrolment response.
 * Backup codes leave exactly once, as the return value of `issueBackupCodes`.
 * Nothing here logs, throws a message containing, or stores either in a
 * recoverable form.
 *
 * LOCK ORDER. Callers take `auth_rate_limit` first, then `user_mfa_factor`,
 * then `auth_challenge`, as `AuthService` does everywhere. The read-only
 * helpers here (`find*`, `matchTotp`, `matchBackupCode`) take no row locks, so
 * a caller can decide and count a failure before anything here locks a row.
 */

export interface Tx {
  query<T extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<T[]>;
}

/** Shown to the authenticator app as the account's issuer. Not a secret. */
export const TOTP_ISSUER = 'Kasuwa';

export type FactorRow = MfaSecretRow & { last_used_step: string | null; created_at: Date };

const FACTOR_COLUMNS = `id, secret, secret_ciphertext, secret_wrapped_key, secret_key_id,
                        secret_algorithm, last_used_step, created_at`;

export async function findConfirmedTotp(
  tx: Tx,
  tenantId: string,
  userId: string,
): Promise<FactorRow | undefined> {
  const rows = await tx.query<FactorRow>(
    `SELECT ${FACTOR_COLUMNS}
       FROM user_mfa_factor
      WHERE tenant_id = $1 AND user_id = $2 AND type = 'totp' AND confirmed_at IS NOT NULL`,
    [tenantId, userId],
  );
  return rows[0];
}

/**
 * The pending factor, if one was started within `maxAgeMinutes`. An older one
 * is ignored rather than confirmed: a secret shown on a screen an hour ago is
 * not one the user should still be committing to.
 */
export async function findPendingTotp(
  tx: Tx,
  tenantId: string,
  userId: string,
  maxAgeMinutes: number,
): Promise<FactorRow | undefined> {
  const rows = await tx.query<FactorRow>(
    `SELECT ${FACTOR_COLUMNS}
       FROM user_mfa_factor
      WHERE tenant_id = $1 AND user_id = $2 AND type = 'totp' AND confirmed_at IS NULL
        AND created_at > now() - $3::interval`,
    [tenantId, userId, `${maxAgeMinutes} minutes`],
  );
  return rows[0];
}

/**
 * Which enrolment this is.
 *
 *   * `first` — the pre-session, challenge-bound path. Only for a user with NO
 *     confirmed factor, re-checked under the user lock. It never deletes a
 *     confirmed factor: a challenge proves a password and nothing more.
 *   * `replace` — the session path, after step-up with the current factor.
 *     Confirming retires the old confirmed factor.
 */
export type EnrolmentMode = 'first' | 'replace';

/**
 * Serialises every factor write for one user (T-0012 review).
 *
 * Two enrolment starts racing for the same user would each delete "no pending
 * row" and then both INSERT, and the second would hit
 * `user_mfa_factor_pending_key` (23505) and surface as a 500. Two first-time
 * confirms could each see "no confirmed factor". Locking the user's own row
 * first makes the check and the write that depends on it one critical section.
 *
 * LOCK ORDER: `auth_rate_limit`, then this row, then `user_mfa_factor`, then
 * `auth_challenge`. Callers clear or bump the rate-limit counter before calling
 * anything that takes this lock.
 */
export async function lockUserForFactorWrite(
  tx: Tx,
  tenantId: string,
  userId: string,
): Promise<void> {
  await tx.query(`SELECT id FROM "user" WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
    tenantId,
    userId,
  ]);
}

/**
 * Starts (or restarts) enrolment: a fresh secret in a new PENDING row.
 *
 * Runs under the user lock. In `first` mode it returns null, writing nothing,
 * if the user already has a confirmed factor.
 *
 * Any earlier pending row is deleted first, so a restarted enrolment cannot be
 * confirmed with the secret from the previous screen — and the earlier secret
 * is gone from the database, not merely superseded. The new secret is written
 * envelope-only (D-L13): the legacy plaintext `secret` column is not named,
 * so it stays NULL, and since T-0049 kasuwa_auth may not INSERT into it at
 * all (migration 0024's column grant).
 */
export async function startTotpEnrolment(
  tx: Tx,
  provider: KeyProvider,
  tenantId: string,
  userId: string,
  mode: EnrolmentMode,
): Promise<string | null> {
  await lockUserForFactorWrite(tx, tenantId, userId);
  if (mode === 'first' && (await hasConfirmedFactor(tx, tenantId, userId))) {
    return null;
  }

  await tx.query(
    `DELETE FROM user_mfa_factor
      WHERE tenant_id = $1 AND user_id = $2 AND type = 'totp' AND confirmed_at IS NULL`,
    [tenantId, userId],
  );

  const factorId = newId();
  const secret = generateTotpSecret();
  const sealed = await sealSecret(provider, secret, mfaSecretAad(tenantId, factorId));
  await tx.query(
    `INSERT INTO user_mfa_factor
       (id, tenant_id, user_id, type, label,
        secret_ciphertext, secret_wrapped_key, secret_key_id, secret_algorithm)
     VALUES ($1, $2, $3, 'totp', 'Authenticator app', $4, $5, $6, $7)`,
    [
      factorId,
      tenantId,
      userId,
      sealed.ciphertext,
      sealed.wrappedKey,
      sealed.keyId,
      sealed.algorithm,
    ],
  );
  return secret;
}

/**
 * `otpauth://totp/<issuer>:<account>?secret=...&issuer=...` (Key Uri Format).
 * The web app draws the QR from this; the secret is not sent in any other form.
 */
export function otpauthUri(account: string, secret: string): string {
  const label = `${encodeURIComponent(TOTP_ISSUER)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret,
    issuer: TOTP_ISSUER,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

export type TotpMatch = { kind: 'match'; step: number } | { kind: 'wrong' } | { kind: 'replayed' };

/**
 * Checks a code against a factor without writing anything.
 *
 * `resolveTotpSecret` throws if the row cannot be decrypted, and that is
 * allowed to propagate: a factor that cannot be read must fail the request
 * loudly, never read as "wrong code" or "no factor" (see mfa-secret.ts).
 */
export async function matchTotp(
  provider: KeyProvider,
  tenantId: string,
  factor: FactorRow | undefined,
  code: string,
): Promise<TotpMatch> {
  if (factor === undefined) {
    return { kind: 'wrong' };
  }
  const secret = await resolveTotpSecret(provider, tenantId, factor);
  const step = matchTotpStep(secret, code);
  if (step === null) {
    return { kind: 'wrong' };
  }
  if (factor.last_used_step !== null && step <= Number(factor.last_used_step)) {
    return { kind: 'replayed' };
  }
  return { kind: 'match', step };
}

/** Claims a step on a CONFIRMED factor. False means another request used it first. */
export async function claimTotpStep(
  tx: Tx,
  tenantId: string,
  factorId: string,
  step: number,
): Promise<boolean> {
  const rows = await tx.query<{ id: string }>(
    `UPDATE user_mfa_factor
        SET last_used_step = $3, updated_at = now()
      WHERE tenant_id = $1
        AND id = $2
        AND confirmed_at IS NOT NULL
        AND (last_used_step IS NULL OR last_used_step < $3)
  RETURNING id`,
    [tenantId, factorId, step],
  );
  return rows.length > 0;
}

export type ConfirmOutcome =
  | { kind: 'confirmed'; confirmedAt: Date }
  /** `first` mode only: a confirmed factor appeared. Nothing was written. */
  | { kind: 'already_enrolled' }
  /** The pending row was replaced or confirmed by a racing request. */
  | { kind: 'lost_race' };

/**
 * Makes a pending factor the user's factor, under the user lock.
 *
 * `first` mode re-checks that no confirmed factor exists and NEVER deletes one:
 * the pre-session path must not be able to remove a factor, whatever raced it.
 * `replace` mode retires the old confirmed factor in the same transaction.
 *
 * The conditional UPDATE is the claim: of two racing confirms, one matches
 * `confirmed_at IS NULL` and the other updates nothing and is refused. The
 * step that confirmed it is recorded, so the same code cannot then be replayed
 * at sign-in.
 */
export async function confirmPendingTotp(
  tx: Tx,
  tenantId: string,
  userId: string,
  factorId: string,
  step: number,
  mode: EnrolmentMode,
): Promise<ConfirmOutcome> {
  await lockUserForFactorWrite(tx, tenantId, userId);
  if (mode === 'first') {
    if (await hasConfirmedFactor(tx, tenantId, userId)) {
      return { kind: 'already_enrolled' };
    }
  } else {
    await tx.query(
      `DELETE FROM user_mfa_factor
        WHERE tenant_id = $1 AND user_id = $2 AND type = 'totp'
          AND confirmed_at IS NOT NULL AND id <> $3`,
      [tenantId, userId, factorId],
    );
  }
  const rows = await tx.query<{ confirmed_at: Date }>(
    `UPDATE user_mfa_factor
        SET confirmed_at = now(), last_used_step = $4, updated_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND id = $3 AND confirmed_at IS NULL
  RETURNING confirmed_at`,
    [tenantId, userId, factorId, step],
  );
  const confirmedAt = rows[0]?.confirmed_at;
  return confirmedAt === undefined ? { kind: 'lost_race' } : { kind: 'confirmed', confirmedAt };
}

export async function hasConfirmedFactor(
  tx: Tx,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const rows = await tx.query<{ ok: number }>(
    `SELECT 1 AS ok
       FROM user_mfa_factor
      WHERE tenant_id = $1 AND user_id = $2 AND confirmed_at IS NOT NULL
      LIMIT 1`,
    [tenantId, userId],
  );
  return rows.length > 0;
}

// --- backup codes -------------------------------------------------------------

/**
 * Replaces the user's whole set with a fresh one and returns the codes — the
 * only time they exist in plaintext. The previous set, used or not, is deleted.
 */
export async function issueBackupCodes(
  tx: Tx,
  provider: KeyProvider,
  tenantId: string,
  userId: string,
): Promise<string[]> {
  await tx.query(`DELETE FROM user_mfa_backup_code WHERE tenant_id = $1 AND user_id = $2`, [
    tenantId,
    userId,
  ]);

  const codes = generateBackupCodes();
  const dataKey = await provider.generateDataKey();
  try {
    for (const code of codes) {
      await tx.query(
        `INSERT INTO user_mfa_backup_code
           (id, tenant_id, user_id, code_hash, hash_key_wrapped, hash_key_id, hash_algorithm)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          newId(),
          tenantId,
          userId,
          hashBackupCode(dataKey.plaintext, tenantId, userId, code),
          dataKey.wrapped,
          dataKey.keyId,
          BACKUP_CODE_HASH_ALGORITHM,
        ],
      );
    }
  } finally {
    dataKey.plaintext.fill(0);
  }
  return codes;
}

/**
 * Kills every unused backup code of the user (D-L58), and returns how many.
 *
 * Called when a replacement factor is confirmed, under the user lock and in
 * the same transaction, before `issueBackupCodes` hands out a fresh set: codes
 * kept with a lost device must not outlive it. The rows are marked used rather
 * than deleted so that, if the issue path ever stopped replacing the whole
 * set, the old codes would still be dead.
 */
export async function retireUnusedBackupCodes(
  tx: Tx,
  tenantId: string,
  userId: string,
): Promise<number> {
  const rows = await tx.query<{ id: string }>(
    `UPDATE user_mfa_backup_code
        SET used_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND used_at IS NULL
  RETURNING id`,
    [tenantId, userId],
  );
  return rows.length;
}

export async function countUnusedBackupCodes(
  tx: Tx,
  tenantId: string,
  userId: string,
): Promise<number> {
  const rows = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM user_mfa_backup_code
      WHERE tenant_id = $1 AND user_id = $2 AND used_at IS NULL`,
    [tenantId, userId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Finds the unused code a submission matches, without writing anything.
 * Returns the row id, or null.
 *
 * Every unused row is compared, in constant time, whether or not an earlier
 * one already matched. An unwrap failure throws, for the same reason a TOTP
 * decryption failure does.
 */
export async function matchBackupCode(
  tx: Tx,
  provider: KeyProvider,
  tenantId: string,
  userId: string,
  submitted: string,
): Promise<string | null> {
  if (normaliseBackupCode(submitted) === null) {
    return null;
  }
  const rows = await tx.query<{
    id: string;
    code_hash: Buffer;
    hash_key_wrapped: Buffer;
    hash_key_id: string;
    hash_algorithm: string;
  }>(
    `SELECT id, code_hash, hash_key_wrapped, hash_key_id, hash_algorithm
       FROM user_mfa_backup_code
      WHERE tenant_id = $1 AND user_id = $2 AND used_at IS NULL`,
    [tenantId, userId],
  );

  // One set shares one data key; group anyway rather than assume it.
  const keys = new Map<string, Buffer>();
  let matched: string | null = null;
  try {
    for (const row of rows) {
      if (row.hash_algorithm !== BACKUP_CODE_HASH_ALGORITHM) {
        continue;
      }
      const cacheKey = `${row.hash_key_id}:${row.hash_key_wrapped.toString('hex')}`;
      let key = keys.get(cacheKey);
      if (key === undefined) {
        key = await provider.unwrapDataKey(row.hash_key_wrapped, row.hash_key_id);
        keys.set(cacheKey, key);
      }
      const candidate = hashBackupCode(key, tenantId, userId, submitted);
      if (candidate.length === row.code_hash.length && timingSafeEqual(candidate, row.code_hash)) {
        matched = row.id;
      }
    }
  } finally {
    for (const key of keys.values()) {
      key.fill(0);
    }
  }
  return matched;
}

/** Marks a code used. False means a racing request used it first. */
export async function consumeBackupCode(
  tx: Tx,
  tenantId: string,
  userId: string,
  codeId: string,
): Promise<boolean> {
  const rows = await tx.query<{ id: string }>(
    `UPDATE user_mfa_backup_code
        SET used_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND id = $3 AND used_at IS NULL
  RETURNING id`,
    [tenantId, userId, codeId],
  );
  return rows.length > 0;
}
