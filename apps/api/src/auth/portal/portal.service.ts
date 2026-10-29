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
  hasTenant,
  readAuthLock,
  registerAuthFailure,
  formatProgrammeIds,
  withAuthTransaction,
  type AuthTx,
  type ResolvedAuthTx,
} from '@kasuwa/db';
import type { Pool } from 'pg';
import { AUTH_PG_POOL } from '../auth-database.module';
import { accountLocked, invalidCredentials, notImplemented, signInUnavailable } from '../auth.errors';
import type { AuthError } from '../auth.errors';
import { AUTH_POLICY, type AuthPolicy } from '../auth.policy';
import type { PortalTenantTx } from '@kasuwa/db';
import type {
  PortalMeResponse,
  PortalSessionResponse,
  PortalSignInInput,
  PortalVerifyMfaInput,
} from './portal.schemas';
import { currentPortalTx } from './portal-context';

@Injectable()
export class PortalService implements OnModuleInit {
  constructor(
    @Inject(AUTH_PG_POOL) private readonly authPool: Pool,
    @Inject(AUTH_POLICY) private readonly policy: AuthPolicy,
  ) {}

  async onModuleInit(): Promise<void> {
    await dummyPasswordHash().catch(() => undefined);
  }

  /** MFA is not enrolled for portal identities in P0; verify stays contract-only. */
  verifyMfa(_input: PortalVerifyMfaInput): never {
    throw notImplemented();
  }

  async signIn(input: PortalSignInInput): Promise<PortalSessionResponse> {
    const rateKey = hashRateLimitKey('portal-signin', input.tenantSlug, input.email);

    const prepared = await withAuthTransaction(
      this.authPool,
      { tenantSlug: input.tenantSlug },
      async (tx) => ({
        locked: await this.activeLock(tx, rateKey),
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

    return withAuthTransaction(this.authPool, { tenantSlug: input.tenantSlug }, async (tx) => {
      const identity = prepared.identity;
      if (!passwordMatches || identity === null || identity.status !== 'active') {
        throw await this.failFirstFactor(tx, rateKey);
      }
      if (!hasTenant(tx)) {
        throw invalidCredentials(null);
      }
      await clearAuthFailures(tx, rateKey);
      return this.issueSession(tx, identity.id, identity.programmeId);
    });
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

  private async activeLock(tx: AuthTx, rateKey: Buffer): Promise<AuthError | null> {
    if (this.policy.lockoutMaxAttempts === 0) {
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

  private async issueSession(
    tx: ResolvedAuthTx,
    portalIdentityId: string,
    programmeId: string,
  ): Promise<PortalSessionResponse> {
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
      accessToken: token,
      tokenType: 'Bearer',
      expiresAt: expiresAt.toISOString(),
    };
  }
}
