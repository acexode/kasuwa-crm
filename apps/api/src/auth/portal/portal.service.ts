import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  dummyPasswordHash,
  HashingOverloadedError,
  hashRateLimitKey,
  hashSessionToken,
  newSessionToken,
  verifyPassword,
} from '@kasuwa/auth-crypto';
import {
  clearAuthFailures,
  formatProgrammeIds,
  hasTenant,
  lookupPortalAuthChallenge,
  readAuthLock,
  registerAuthFailure,
  withAuthTransaction,
  type AuthTx,
  type PortalTenantTx,
  type ResolvedAuthTx,
} from '@kasuwa/db';
import { nodeEnv } from '@kasuwa/config';
import { inviteTokenHashHex } from '@kasuwa/domain-core';
import type { Pool } from 'pg';
import { AUTH_PG_POOL } from '../auth-database.module';
import {
  accountLocked,
  invalidCredentials,
  mfaChallengeExpired,
  mfaChallengeInvalid,
  mfaCodeInvalid,
  signInUnavailable,
} from '../auth.errors';
import { AuthError } from '../auth.errors';
import { AUTH_POLICY, type AuthPolicy } from '../auth.policy';
import { formatChallengeId, parseChallengeId } from '../challenge-id';
import type {
  PortalAcceptInvitationInput,
  PortalMeResponse,
  PortalMfaChallengeResponse,
  PortalSignInInput,
  PortalTokenResponse,
  PortalVerifyMfaInput,
} from './portal.schemas';
import { currentPortalTx } from './portal-context';

/**
 * Provisional portal MFA (D-L213 / B1). Accepted only outside production —
 * production must fail closed until a real OTP channel exists.
 */
const PORTAL_PROVISIONAL_OTP = '000000';

export function portalProvisionalOtpAccepted(
  code: string,
  environment: ReturnType<typeof nodeEnv> = nodeEnv(),
): boolean {
  return environment !== 'production' && code === PORTAL_PROVISIONAL_OTP;
}

@Injectable()
export class PortalService implements OnModuleInit {
  constructor(
    @Inject(AUTH_PG_POOL) private readonly authPool: Pool,
    @Inject(AUTH_POLICY) private readonly policy: AuthPolicy,
  ) {}

  async onModuleInit(): Promise<void> {
    await dummyPasswordHash().catch(() => undefined);
  }

  async signIn(input: PortalSignInInput): Promise<PortalMfaChallengeResponse> {
    const rateKey = hashRateLimitKey('portal-signin', input.tenantSlug, input.email);

    const prepared = await withAuthTransaction(
      this.authPool,
      { tenantSlug: input.tenantSlug },
      async (tx) => ({
        locked: await this.activeLock(tx, rateKey, this.signInLimits()),
        identity: hasTenant(tx) ? await this.findIdentity(tx, input.email) : null,
      }),
    );

    if (prepared.locked !== null) {
      throw prepared.locked;
    }

    const passwordMatches = await this.verify(
      prepared.identity?.passwordHash ?? null,
      input.password,
    );

    return this.commitThenFail(
      withAuthTransaction(this.authPool, { tenantSlug: input.tenantSlug }, async (tx) => {
        const identity = prepared.identity;
        if (!passwordMatches || identity === null || identity.status !== 'active') {
          return this.failFirstFactor(tx, rateKey);
        }
        if (!hasTenant(tx)) {
          return invalidCredentials(null);
        }
        await clearAuthFailures(tx, rateKey);
        return this.openPortalChallenge(tx, identity.id, identity.programmeId);
      }),
    );
  }

  async verifyMfa(input: PortalVerifyMfaInput): Promise<PortalTokenResponse> {
    const reference = await this.resolvePortalChallengeReference(input.challengeId);
    if (reference === null) {
      throw mfaChallengeInvalid();
    }

    return this.commitThenFail(
      withAuthTransaction(this.authPool, { tenantId: reference.tenantId }, async (tx) => {
        if (!hasTenant(tx)) {
          return mfaChallengeInvalid();
        }

        const challenge = await this.findOpenPortalChallenge(tx, reference.challengeId);
        if (challenge instanceof AuthError) {
          return challenge;
        }

        const mfaKey = hashRateLimitKey(
          'portal-mfa',
          tx.tenantId,
          challenge.portalIdentityId,
        );
        const locked = await this.activeLock(tx, mfaKey, this.mfaLimits());
        if (locked !== null) {
          return locked;
        }

        if (portalProvisionalOtpAccepted(input.code)) {
          await clearAuthFailures(tx, mfaKey);
          const claimed = await tx.query<{ id: string }>(
            `UPDATE portal_auth_challenge
                SET consumed_at = now()
              WHERE tenant_id = $1 AND id = $2 AND consumed_at IS NULL
          RETURNING id`,
            [tx.tenantId, reference.challengeId],
          );
          if (claimed.length === 0) {
            return mfaChallengeInvalid();
          }
          return this.issueToken(
            tx,
            challenge.portalIdentityId,
            challenge.programmeId,
          );
        }

        return this.failPortalMfa(tx, reference.challengeId, mfaKey);
      }),
    );
  }

  async me(): Promise<PortalMeResponse> {
    const tx: PortalTenantTx = currentPortalTx();
    const identityRows = await tx.query<{
      id: string;
      email_masked: string;
      display_name: string;
    }>(
      `SELECT id, email_masked, display_name
         FROM portal_identity
        WHERE tenant_id = $1 AND id = $2`,
      [tx.session.tenantId, tx.session.portalIdentityId],
    );
    const identity = identityRows[0];
    if (identity === undefined) {
      throw invalidCredentials(null);
    }

    const programmeRows = await tx.query<{ id: string; name: string }>(
      `SELECT p.id, p.name
         FROM portal_programme pp
         JOIN programme p
           ON p.id = pp.programme_id AND p.tenant_id = pp.tenant_id
        WHERE pp.tenant_id = $1
          AND pp.portal_identity_id = $2
          AND pp.programme_id = ANY ($3::uuid[])
        ORDER BY p.name`,
      [
        tx.session.tenantId,
        tx.session.portalIdentityId,
        formatProgrammeIds(tx.session.programmeIds),
      ],
    );

    return {
      identity: {
        id: identity.id,
        tenantId: tx.session.tenantId,
        emailMasked: identity.email_masked,
        displayName: identity.display_name,
      },
      programmes: programmeRows.map((row) => ({ id: row.id, name: row.name })),
    };
  }

  /** Accept a programme invitation (T-0180, ADR-0021). Token lookup on kasuwa_auth under RLS. */
  async acceptInvitation(input: PortalAcceptInvitationInput): Promise<{ accepted: true }> {
    const tokenHashHex = inviteTokenHashHex(input.token);
    return withAuthTransaction(this.authPool, { tenantSlug: input.tenantSlug }, async (tx) => {
      if (!hasTenant(tx)) {
        throw invalidCredentials(null);
      }

      const invites = await tx.query<{
        id: string;
        programme_id: string;
        email: string;
        email_masked: string;
      }>(
        `SELECT id, programme_id, email, email_masked
           FROM portal_invite
          WHERE token_hash = $1
            AND status = 'pending'
            AND expires_at > now()`,
        [tokenHashHex],
      );
      const invite = invites[0];
      if (invite === undefined) {
        throw invalidCredentials(null);
      }

      const burned = await tx.query<{ id: string }>(
        `UPDATE portal_invite
            SET status = 'accepted', updated_at = now()
          WHERE id = $1
            AND tenant_id = $2
            AND status = 'pending'
          RETURNING id`,
        [invite.id, tx.tenantId],
      );
      if (burned[0] === undefined) {
        throw invalidCredentials(null);
      }

      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM portal_identity
          WHERE tenant_id = $1 AND lower(email) = lower($2)`,
        [tx.tenantId, invite.email],
      );
      let identityId = existing[0]?.id;
      if (identityId === undefined) {
        identityId = randomUUID();
        await tx.query(
          `INSERT INTO portal_identity
             (id, tenant_id, programme_id, email, email_masked, display_name, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'invited')`,
          [
            identityId,
            tx.tenantId,
            invite.programme_id,
            invite.email,
            invite.email_masked,
            invite.email_masked,
          ],
        );
      }

      await tx.query(
        `INSERT INTO portal_programme (id, tenant_id, portal_identity_id, programme_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ON CONSTRAINT portal_programme_membership_key DO NOTHING`,
        [randomUUID(), tx.tenantId, identityId, invite.programme_id],
      );

      return { accepted: true };
    });
  }

  private async resolvePortalChallengeReference(
    value: string,
  ): Promise<{ tenantId: string; challengeId: string } | null> {
    const composite = parseChallengeId(value);
    if (composite !== null) {
      return composite;
    }
    const lookedUp = await lookupPortalAuthChallenge(this.authPool, value);
    return lookedUp === null
      ? null
      : { tenantId: lookedUp.tenantId, challengeId: value };
  }

  private async verify(hash: string | null, password: string): Promise<boolean> {
    try {
      return await verifyPassword(hash ?? (await dummyPasswordHash()), password);
    } catch (error) {
      if (error instanceof HashingOverloadedError) {
        throw signInUnavailable();
      }
      throw error;
    }
  }

  private signInLimits() {
    return {
      maxAttempts: this.policy.lockoutMaxAttempts,
      windowMinutes: this.policy.lockoutWindowMinutes,
      lockMinutes: this.policy.lockoutMinutes,
    };
  }

  private mfaLimits() {
    return {
      maxAttempts: this.policy.mfaMaxAttempts,
      windowMinutes: this.policy.lockoutWindowMinutes,
      lockMinutes: this.policy.lockoutMinutes,
    };
  }

  private async activeLock(
    tx: AuthTx,
    rateKey: Buffer,
    limits: { maxAttempts: number; windowMinutes: number; lockMinutes: number },
  ): Promise<AuthError | null> {
    if (limits.maxAttempts === 0) {
      return null;
    }
    const state = await readAuthLock(tx, rateKey);
    return state?.lockedUntil == null
      ? null
      : accountLocked(state.lockedUntil, this.policy.cellTimeZone);
  }

  private async failFirstFactor(tx: AuthTx, rateKey: Buffer): Promise<AuthError> {
    if (this.policy.lockoutMaxAttempts === 0) {
      return invalidCredentials(null);
    }
    const state = await registerAuthFailure(tx, rateKey, this.signInLimits());
    if (state.lockedUntil !== null && state.lockedUntil.getTime() > Date.now()) {
      return accountLocked(state.lockedUntil, this.policy.cellTimeZone);
    }
    return invalidCredentials(
      Math.max(this.policy.lockoutMaxAttempts - state.failedCount, 0),
    );
  }

  private async failPortalMfa(
    tx: ResolvedAuthTx,
    challengeId: string,
    mfaKey: Buffer,
  ): Promise<AuthError> {
    const mfaState = await registerAuthFailure(tx, mfaKey, this.mfaLimits());

    const bumped = await tx.query<{ attempt_count: number }>(
      `UPDATE portal_auth_challenge
          SET attempt_count = attempt_count + 1
        WHERE tenant_id = $1 AND id = $2 AND consumed_at IS NULL
    RETURNING attempt_count`,
      [tx.tenantId, challengeId],
    );

    const attempts = bumped[0]?.attempt_count;
    if (attempts === undefined) {
      return mfaChallengeInvalid();
    }

    if (mfaState.lockedUntil !== null && mfaState.lockedUntil.getTime() > Date.now()) {
      await this.burnPortalChallenge(tx, challengeId);
      return accountLocked(mfaState.lockedUntil, this.policy.cellTimeZone);
    }

    if (attempts >= this.policy.challengeMaxAttempts) {
      await this.burnPortalChallenge(tx, challengeId);
      return mfaChallengeInvalid();
    }

    return mfaCodeInvalid(Math.max(this.policy.challengeMaxAttempts - attempts, 0));
  }

  private async burnPortalChallenge(tx: ResolvedAuthTx, challengeId: string): Promise<void> {
    await tx.query(
      `UPDATE portal_auth_challenge SET consumed_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, challengeId],
    );
  }

  private async findIdentity(
    tx: ResolvedAuthTx,
    email: string,
  ): Promise<{ id: string; status: string; passwordHash: string | null; programmeId: string } | null> {
    const rows = await tx.query<{
      id: string;
      status: string;
      password_hash: string | null;
      programme_id: string;
    }>(
      `SELECT id, status, password_hash, programme_id
         FROM portal_identity
        WHERE tenant_id = $1
          AND lower(email) = lower($2)`,
      [tx.tenantId, email],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          status: row.status,
          passwordHash: row.password_hash,
          programmeId: row.programme_id,
        };
  }

  private async openPortalChallenge(
    tx: ResolvedAuthTx,
    portalIdentityId: string,
    programmeId: string,
  ): Promise<PortalMfaChallengeResponse> {
    await tx.query(
      `UPDATE portal_auth_challenge
          SET consumed_at = now()
        WHERE tenant_id = $1
          AND portal_identity_id = $2
          AND consumed_at IS NULL
          AND id IN (
            SELECT id
              FROM portal_auth_challenge
             WHERE tenant_id = $1
               AND portal_identity_id = $2
               AND consumed_at IS NULL
               AND expires_at > now()
             ORDER BY created_at DESC
            OFFSET $3
          )`,
      [
        tx.tenantId,
        portalIdentityId,
        Math.max(this.policy.maxOpenChallenges - 1, 0),
      ],
    );

    const challengeId = randomUUID();
    const expiresAt = new Date(Date.now() + this.policy.challengeMinutes * 60_000);

    await tx.query(
      `INSERT INTO portal_auth_challenge
         (id, tenant_id, programme_id, portal_identity_id, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [challengeId, tx.tenantId, programmeId, portalIdentityId, expiresAt],
    );

    return {
      mfaRequired: true,
      challengeId: formatChallengeId({ tenantId: tx.tenantId, challengeId }),
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async findOpenPortalChallenge(
    tx: ResolvedAuthTx,
    challengeId: string,
  ): Promise<
    | { portalIdentityId: string; programmeId: string; attemptCount: number; expiresAt: Date }
    | AuthError
  > {
    const rows = await tx.query<{
      portal_identity_id: string;
      programme_id: string;
      attempt_count: number;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT portal_identity_id, programme_id, attempt_count, expires_at, consumed_at
         FROM portal_auth_challenge
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, challengeId],
    );

    const row = rows[0];
    if (row === undefined || row.consumed_at !== null) {
      return mfaChallengeInvalid();
    }
    if (row.expires_at.getTime() <= Date.now()) {
      return mfaChallengeExpired();
    }
    return {
      portalIdentityId: row.portal_identity_id,
      programmeId: row.programme_id,
      attemptCount: row.attempt_count,
      expiresAt: row.expires_at,
    };
  }

  private async issueToken(
    tx: ResolvedAuthTx,
    portalIdentityId: string,
    programmeId: string,
  ): Promise<PortalTokenResponse> {
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + this.policy.sessionHours * 3_600_000);
    const sessionId = randomUUID();

    await tx.query(
      `INSERT INTO portal_session
         (id, tenant_id, programme_id, portal_identity_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        sessionId,
        tx.tenantId,
        programmeId,
        portalIdentityId,
        hashSessionToken(token).toString('hex'),
        expiresAt,
      ],
    );

    return {
      token,
      tokenType: 'Bearer',
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async commitThenFail<T>(outcome: Promise<T | AuthError>): Promise<T> {
    const value = await outcome;
    if (value instanceof AuthError) {
      throw value;
    }
    return value;
  }
}
