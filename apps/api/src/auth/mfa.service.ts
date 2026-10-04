import { Inject, Injectable } from '@nestjs/common';
import { hashRateLimitKey, type KeyProvider } from '@kasuwa/auth-crypto';
import {
  clearAuthFailures,
  readAuthLock,
  registerAuthFailure,
  type RateLimitPolicy,
  type TenantTx,
} from '@kasuwa/db';
import { accountLocked, type AuthError, mfaCodeInvalid } from './auth.errors';
import { AUTH_POLICY, type AuthPolicy } from './auth.policy';
import type {
  BackupCodesIssued,
  MfaStatusResponse,
  StepUpInput,
  TotpConfirmInput,
  TotpEnrolmentStarted,
} from './auth.schemas';
import { KEY_PROVIDER } from './key-provider.token';
import {
  claimTotpStep,
  confirmPendingTotp,
  consumeBackupCode,
  countUnusedBackupCodes,
  findConfirmedTotp,
  findPendingTotp,
  issueBackupCodes,
  matchBackupCode,
  matchTotp,
  otpauthUri,
  startTotpEnrolment,
} from './mfa-store';

/**
 * The signed-in user's own second factor (T-0012): read it, replace it,
 * regenerate the backup codes.
 *
 * Runs inside the request's tenant transaction (KasuwaAuthGuard +
 * TenantTransactionInterceptor, exactly like GET /auth/me). Nothing here reads
 * or decides a programme: a factor belongs to a user, and identity is all these
 * routes deal in.
 *
 * STEP-UP. Every write first re-verifies the CURRENT second factor — a TOTP
 * code, or a backup code that is consumed. A session alone is not enough: a
 * session can be stolen from a browser left open, and swapping the factor out
 * from under its owner is how a stolen session becomes a stolen account. A
 * password is not accepted at all.
 *
 * Wrong codes count against the SAME per-user MFA counter as the sign-in second
 * factor, so a session cannot be used to guess codes past the lock.
 *
 * FAILURES ARE RETURNED, NOT THROWN, for the reason `AuthService.commitThenFail`
 * gives: a thrown error rolls the tenant transaction back, and with it the
 * counter increment that recorded the failure. The controller pairs these
 * routes with `CommitThenFailInterceptor`, which raises a returned `AuthError`
 * only after the transaction has committed.
 */
@Injectable()
export class MfaService {
  constructor(
    @Inject(AUTH_POLICY) private readonly policy: AuthPolicy,
    @Inject(KEY_PROVIDER) private readonly keyProvider: KeyProvider,
  ) {}

  /** GET /auth/me/mfa. A timestamp and a count; never a secret, a code or a hash. */
  async status(tx: TenantTx): Promise<MfaStatusResponse> {
    const { tenantId, userId } = tx.session;
    const rows = await tx.query<{ confirmed_at: Date }>(
      `SELECT confirmed_at
         FROM user_mfa_factor
        WHERE tenant_id = $1 AND user_id = $2 AND type = 'totp' AND confirmed_at IS NOT NULL`,
      [tenantId, userId],
    );
    return {
      totp: { confirmedAt: rows[0]?.confirmed_at.toISOString() ?? null },
      backupCodesRemaining: await countUnusedBackupCodes(tx, tenantId, userId),
    };
  }

  /**
   * POST /auth/me/mfa/totp — start replacing the factor. The old factor keeps
   * working until the new one is confirmed, so abandoning this half-way leaves
   * the user exactly where they were.
   */
  async startReplacement(
    tx: TenantTx,
    input: StepUpInput,
  ): Promise<TotpEnrolmentStarted | AuthError> {
    const refused = await this.stepUp(tx, input);
    if (refused !== null) {
      return refused;
    }
    const { tenantId, userId } = tx.session;
    const rows = await tx.query<{ email: string }>(
      `SELECT email FROM "user" WHERE tenant_id = $1 AND id = $2`,
      [tenantId, userId],
    );
    const secret = await startTotpEnrolment(tx, this.keyProvider, tenantId, userId, 'replace');
    if (secret === null) {
      // Unreachable: `replace` mode never refuses. Fail closed regardless.
      throw mfaCodeInvalid(null);
    }
    return {
      otpauthUri: otpauthUri(rows[0]?.email ?? userId, secret),
      secret,
      expiresAt: new Date(Date.now() + this.policy.challengeMinutes * 60_000).toISOString(),
    };
  }

  /**
   * POST /auth/me/mfa/totp/confirm — a code from the NEW secret makes it the
   * factor. The old factor is deleted in the same transaction, and every other
   * session the user holds is revoked: a factor is usually replaced because a
   * device was lost, and a session on that device should not outlive it.
   */
  async confirmReplacement(
    tx: TenantTx,
    sessionId: string,
    input: TotpConfirmInput,
  ): Promise<MfaStatusResponse | AuthError> {
    const { tenantId, userId } = tx.session;
    const mfaKey = hashRateLimitKey('mfa', tenantId, userId);
    const locked = await this.activeLock(tx, mfaKey);
    if (locked !== null) {
      return locked;
    }

    const pending = await findPendingTotp(tx, tenantId, userId, this.policy.challengeMinutes);
    const match = await matchTotp(this.keyProvider, tenantId, pending, input.code);
    if (pending === undefined || match.kind !== 'match') {
      return this.fail(tx, mfaKey);
    }

    await clearAuthFailures(tx, mfaKey);
    const outcome = await confirmPendingTotp(
      tx,
      tenantId,
      userId,
      pending.id,
      match.step,
      'replace',
    );
    if (outcome.kind !== 'confirmed') {
      // A racing confirm won. Thrown, so nothing here half-applies.
      throw mfaCodeInvalid(null);
    }
    await tx.query(
      `UPDATE auth_session
          SET revoked_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND id <> $3 AND revoked_at IS NULL`,
      [tenantId, userId, sessionId],
    );
    return this.status(tx);
  }

  /** POST /auth/me/mfa/backup-codes — a new set; the previous one stops working. */
  async regenerateBackupCodes(
    tx: TenantTx,
    input: StepUpInput,
  ): Promise<BackupCodesIssued | AuthError> {
    const refused = await this.stepUp(tx, input);
    if (refused !== null) {
      return refused;
    }
    const { tenantId, userId } = tx.session;
    return { backupCodes: await issueBackupCodes(tx, this.keyProvider, tenantId, userId) };
  }

  // --- internals -------------------------------------------------------------

  /**
   * Re-verifies the current second factor. Null means verified; anything else
   * is the error to return (after commit).
   *
   * Lock order matches AuthService: the reads here take no row locks, then
   * `auth_rate_limit`, then the factor or backup-code row.
   */
  private async stepUp(tx: TenantTx, input: StepUpInput): Promise<AuthError | null> {
    const { tenantId, userId } = tx.session;
    const mfaKey = hashRateLimitKey('mfa', tenantId, userId);
    const locked = await this.activeLock(tx, mfaKey);
    if (locked !== null) {
      return locked;
    }

    if (input.method === 'backup_code') {
      const codeId = await matchBackupCode(tx, this.keyProvider, tenantId, userId, input.code);
      if (codeId === null) {
        return this.fail(tx, mfaKey);
      }
      await clearAuthFailures(tx, mfaKey);
      return (await consumeBackupCode(tx, tenantId, userId, codeId))
        ? null
        : this.fail(tx, mfaKey);
    }

    const factor = await findConfirmedTotp(tx, tenantId, userId);
    const match = await matchTotp(this.keyProvider, tenantId, factor, input.code);
    if (match.kind === 'replayed') {
      // A code already accepted — most often the user's own double submit.
      // Refused, and NOT counted, for the reason AuthService.verifyMfa gives.
      return mfaCodeInvalid(null);
    }
    if (factor === undefined || match.kind === 'wrong') {
      return this.fail(tx, mfaKey);
    }
    await clearAuthFailures(tx, mfaKey);
    return (await claimTotpStep(tx, tenantId, factor.id, match.step))
      ? null
      : this.fail(tx, mfaKey);
  }

  private limits(): RateLimitPolicy {
    return {
      maxAttempts: this.policy.mfaMaxAttempts,
      windowMinutes: this.policy.lockoutWindowMinutes,
      lockMinutes: this.policy.lockoutMinutes,
    };
  }

  private async activeLock(tx: TenantTx, mfaKey: Buffer): Promise<AuthError | null> {
    if (this.policy.mfaMaxAttempts === 0) {
      return null;
    }
    const state = await readAuthLock(tx, mfaKey);
    return state?.lockedUntil == null
      ? null
      : accountLocked(state.lockedUntil, this.policy.cellTimeZone);
  }

  private async fail(tx: TenantTx, mfaKey: Buffer): Promise<AuthError> {
    const state = await registerAuthFailure(tx, mfaKey, this.limits());
    if (state.lockedUntil !== null && state.lockedUntil.getTime() > Date.now()) {
      return accountLocked(state.lockedUntil, this.policy.cellTimeZone);
    }
    return mfaCodeInvalid(Math.max(this.policy.mfaMaxAttempts - state.failedCount, 0));
  }
}
