import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  dummyPasswordHash,
  hashIdentifier,
  hashSessionToken,
  newSessionToken,
  verifyPassword,
  verifyTotp,
} from '@kasuwa/auth-crypto';
import { resolveSessionIdentity, withAuthTransaction } from '@kasuwa/db';
import type { AuthTx } from '@kasuwa/db';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import {
  accountLocked,
  AuthError,
  invalidCredentials,
  mfaChallengeExpired,
  mfaChallengeInvalid,
  mfaCodeInvalid,
  notImplemented,
  ssoDomainNotFound,
} from './auth.errors';
import { AUTH_POLICY, timeZoneForRegionCell, type AuthPolicy } from './auth.policy';
import {
  formatChallengeId,
  parseChallengeId,
  type ChallengeReference,
} from './challenge-id';
import type {
  MfaChallengeInput,
  MfaChallengeResponse,
  MfaVerifyInput,
  SessionResponse,
  SignInInput,
  SsoLookupInput,
} from './auth.schemas';

/**
 * Authentication: establishing WHO the caller is.
 *
 * Read the tenancy comment in `withAuthTransaction` (@kasuwa/db) before
 * changing anything here. Nothing in this service decides what anyone can
 * reach. It reads and writes five identity tables and issues an opaque token;
 * scope is still resolved from `user_programme` inside
 * `withTenantTransaction`, on every subsequent request, exactly as it was under
 * the stub.
 *
 * Three properties are load-bearing and each has a test that fails without it:
 *
 *   1. Unknown email, wrong password, unknown workspace and disabled user are
 *      one response and one timing profile. Every path that can fail does the
 *      same argon2id work, verifying against a dummy hash when there is no real
 *      one. An early return for "no such user" is the usual way this leaks, and
 *      it is measurable over a network.
 *   2. The first factor issues a challenge and nothing else. No token, no
 *      cookie, no field whose name a client could mistake for one.
 *   3. Lockout counts the submitted identifier, not the account, so it works
 *      for an address that does not exist and therefore is not itself evidence
 *      that an address does.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUTH_POLICY) private readonly policy: AuthPolicy,
  ) {}

  /** First factor. Returns a challenge; never a session. */
  async signIn(input: SignInInput): Promise<MfaChallengeResponse> {
    return this.commitThenFail(
      withAuthTransaction(this.pool, { tenantSlug: input.tenantSlug }, async (tx) => {
        if (tx === null) {
          // No such workspace. Do the work anyway, then fail exactly as a wrong
          // password does. Returning here without hashing is the enumeration
          // oracle the acceptance suite measures.
          await verifyPassword(await dummyPasswordHash(), input.password);
          // Reported as a first failure. There is no tenant to hold a counter
          // against, and a null countdown here would tell a caller that the
          // workspace does not exist. Known limitation, recorded in the T-0001
          // report: the count does not decrement for a workspace that is not
          // real, so a determined prober can still distinguish one eventually.
          return invalidCredentials(this.remainingAfter(1));
        }

        const identifier = hashIdentifier(tx.tenantId, input.email);
        const locked = await this.lockoutIfActive(tx, identifier);
        if (locked !== null) {
          return locked;
        }

        const account = await this.findAccount(tx, input.email);
        const hash = account?.passwordHash ?? (await dummyPasswordHash());
        const passwordMatches = await verifyPassword(hash, input.password);

        // `account.status` is checked here rather than in the query so that a
        // disabled user costs exactly as much as an active one.
        if (!passwordMatches || account === null || account.status !== 'active') {
          const failures = await this.recordFailure(tx, identifier);
          if (this.isLockedOut(failures)) {
            return accountLocked(await this.lock(tx, identifier), await this.timeZone(tx));
          }
          return invalidCredentials(this.remainingAfter(failures));
        }

        // A correct password clears the counter. Four typos across a week must
        // not lock somebody out on the fifth.
        await tx.query(`DELETE FROM auth_attempt WHERE tenant_id = $1 AND identifier_hash = $2`, [
          tx.tenantId,
          identifier,
        ]);

        return this.openChallenge(tx, account.id);
      }),
    );
  }

  /**
   * Re-issues or switches the second factor.
   *
   * Only `totp` is implemented. There is nothing to send for TOTP — the
   * authenticator app already holds the secret — so this returns the existing
   * challenge unchanged. SMS and backup codes need a channel provider that does
   * not exist yet and are an explicit non-goal of T-0001.
   */
  async reissueChallenge(input: MfaChallengeInput): Promise<MfaChallengeResponse> {
    if (input.method !== 'totp') {
      throw notImplemented();
    }

    const reference = parseChallengeId(input.challengeId);
    if (reference === null) {
      throw mfaChallengeInvalid();
    }

    return this.commitThenFail(
      withAuthTransaction(this.pool, { tenantId: reference.tenantId }, async (tx) => {
        if (tx === null) {
          return mfaChallengeInvalid();
        }
        const challenge = await this.findOpenChallenge(tx, reference.challengeId);
        if (challenge instanceof AuthError) {
          return challenge;
        }
        return this.describeChallenge(tx, challenge.userId, reference, challenge.expiresAt);
      }),
    );
  }

  /** Second factor. The only place a session token is issued. */
  async verifyMfa(input: MfaVerifyInput): Promise<SessionResponse> {
    const reference = parseChallengeId(input.challengeId);
    if (reference === null) {
      throw mfaChallengeInvalid();
    }

    return this.commitThenFail(
      withAuthTransaction(this.pool, { tenantId: reference.tenantId }, async (tx) => {
        if (tx === null) {
          return mfaChallengeInvalid();
        }

        const challenge = await this.findOpenChallenge(tx, reference.challengeId);
        if (challenge instanceof AuthError) {
          return challenge;
        }

        const factors = await tx.query<{ secret: string }>(
          `SELECT secret
             FROM user_mfa_factor
            WHERE tenant_id = $1 AND user_id = $2 AND type = 'totp' AND confirmed_at IS NOT NULL`,
          [tx.tenantId, challenge.userId],
        );

        const secret = factors[0]?.secret;
        if (secret === undefined || !verifyTotp(secret, input.code)) {
          const attempts = challenge.attemptCount + 1;
          await tx.query(
            `UPDATE auth_challenge SET attempt_count = $3 WHERE tenant_id = $1 AND id = $2`,
            [tx.tenantId, reference.challengeId, attempts],
          );
          if (attempts >= this.policy.challengeMaxAttempts) {
            // Burn it rather than leave a challenge that can be ground down.
            await tx.query(
              `UPDATE auth_challenge SET consumed_at = now() WHERE tenant_id = $1 AND id = $2`,
              [tx.tenantId, reference.challengeId],
            );
            return mfaChallengeInvalid();
          }
          return mfaCodeInvalid(this.policy.challengeMaxAttempts - attempts);
        }

        // One challenge, one session. Consuming before issuing means a replayed
        // challenge id cannot mint a second token.
        await tx.query(
          `UPDATE auth_challenge SET consumed_at = now() WHERE tenant_id = $1 AND id = $2`,
          [tx.tenantId, reference.challengeId],
        );

        return this.issueSession(tx, challenge.userId);
      }),
    );
  }

  /**
   * Revokes a session. Idempotent and silent about whether the token was real:
   * a sign-out that reported "no such session" would tell somebody holding a
   * stolen token whether it is still live.
   */
  async signOut(token: string | null): Promise<void> {
    if (token === null) {
      return;
    }
    const identity = await resolveSessionIdentity(this.pool, hashSessionToken(token));
    if (identity === null) {
      return;
    }
    await withAuthTransaction(this.pool, { tenantId: identity.tenantId }, async (tx) => {
      if (tx === null) {
        return;
      }
      await tx.query(
        `UPDATE auth_session
            SET revoked_at = now()
          WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`,
        [identity.tenantId, identity.sessionId],
      );
    });
  }

  /**
   * SSO connection for an email domain.
   *
   * No connection can be configured yet — SAML/OIDC is a later M2 task — so
   * this always reports "not found", which is exactly the state `P01/1c`
   * renders. The 404 is not an existence leak: the domain is public
   * information the caller supplied, and the answer says nothing about whether
   * any account exists.
   */
  async lookupSso(_input: SsoLookupInput): Promise<never> {
    throw ssoDomainNotFound();
  }

  // --- internals ---------------------------------------------------------

  /**
   * Commits the transaction, then throws whatever went wrong.
   *
   * This is not a style choice, it is the bug that makes lockout work. Every
   * failure path here has a side effect that must survive: a failed attempt
   * increments a counter, a wrong second factor burns an attempt against the
   * challenge. Throwing from inside `withAuthTransaction` rolls the whole
   * transaction back, which silently discards exactly the row that was meant
   * to be a record of the failure — so the counter never advances, nothing
   * ever locks, and the tests that check it pass for the wrong reason until
   * somebody counts.
   *
   * So the callbacks RETURN an `AuthError` rather than throwing one. The
   * transaction commits, and the error is raised out here where it can no
   * longer undo anything. Anything that genuinely should not persist — a
   * malformed challenge id, an unimplemented method — is still thrown before
   * the transaction opens at all.
   */
  private async commitThenFail<T>(outcome: Promise<T | AuthError>): Promise<T> {
    const value = await outcome;
    if (value instanceof AuthError) {
      throw value;
    }
    return value;
  }

  private async findAccount(
    tx: AuthTx,
    email: string,
  ): Promise<{ id: string; status: string; passwordHash: string | null } | null> {
    // RLS confines this to the resolved tenant, and the explicit tenant_id
    // predicate says so a second time. Two independent layers; a mistake in
    // one does not leak (CLAUDE.md section 2, rule 3).
    const rows = await tx.query<{ id: string; status: string; password_hash: string | null }>(
      `SELECT u.id, u.status, c.password_hash
         FROM "user" u
         LEFT JOIN user_credential c ON c.user_id = u.id AND c.tenant_id = u.tenant_id
        WHERE u.tenant_id = $1
          AND lower(u.email) = lower($2)`,
      [tx.tenantId, email],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { id: row.id, status: row.status, passwordHash: row.password_hash };
  }

  private async lockoutIfActive(tx: AuthTx, identifier: Buffer): Promise<AuthError | null> {
    if (this.policy.lockoutMaxAttempts === 0) {
      return null;
    }
    const rows = await tx.query<{ locked_until: Date | null }>(
      `SELECT locked_until
         FROM auth_attempt
        WHERE tenant_id = $1 AND identifier_hash = $2 AND locked_until > now()`,
      [tx.tenantId, identifier],
    );
    const lockedUntil = rows[0]?.locked_until;
    return lockedUntil == null ? null : accountLocked(lockedUntil, await this.timeZone(tx));
  }

  /** Records a failure and returns the number of failures inside the window. */
  private async recordFailure(tx: AuthTx, identifier: Buffer): Promise<number> {
    if (this.policy.lockoutMaxAttempts === 0) {
      return 0;
    }
    const window = `${this.policy.lockoutWindowMinutes} minutes`;
    const rows = await tx.query<{ failed_count: number }>(
      `INSERT INTO auth_attempt (tenant_id, identifier_hash, failed_count)
            VALUES ($1, $2, 1)
       ON CONFLICT (tenant_id, identifier_hash) DO UPDATE
            SET failed_count = CASE
                  WHEN auth_attempt.first_failed_at < now() - $3::interval THEN 1
                  ELSE auth_attempt.failed_count + 1
                END,
                first_failed_at = CASE
                  WHEN auth_attempt.first_failed_at < now() - $3::interval THEN now()
                  ELSE auth_attempt.first_failed_at
                END,
                last_failed_at = now()
         RETURNING failed_count`,
      [tx.tenantId, identifier, window],
    );
    return rows[0]?.failed_count ?? 1;
  }

  private async lock(tx: AuthTx, identifier: Buffer): Promise<Date> {
    const rows = await tx.query<{ locked_until: Date }>(
      `UPDATE auth_attempt
          SET locked_until = now() + $3::interval
        WHERE tenant_id = $1 AND identifier_hash = $2
        RETURNING locked_until`,
      [tx.tenantId, identifier, `${this.policy.lockoutMinutes} minutes`],
    );
    return rows[0]?.locked_until ?? new Date(Date.now() + this.policy.lockoutMinutes * 60_000);
  }

  private isLockedOut(failures: number): boolean {
    return this.policy.lockoutMaxAttempts > 0 && failures >= this.policy.lockoutMaxAttempts;
  }

  /**
   * How many attempts remain, for the countdown on `P01/1a`.
   *
   * Null when lockout is disabled. Identical for a real and a fake address,
   * because the counter is keyed on the submitted identifier either way.
   */
  private remainingAfter(failures: number): number | null {
    if (this.policy.lockoutMaxAttempts === 0) {
      return null;
    }
    return Math.max(this.policy.lockoutMaxAttempts - failures, 0);
  }

  private async timeZone(tx: AuthTx): Promise<string> {
    const rows = await tx.query<{ region_cell: string }>(
      `SELECT region_cell FROM tenant WHERE id = $1`,
      [tx.tenantId],
    );
    return timeZoneForRegionCell(rows[0]?.region_cell);
  }

  private async openChallenge(tx: AuthTx, userId: string): Promise<MfaChallengeResponse> {
    // Random (v4) rather than the time-ordered v7 used for business rows: a
    // challenge id is a short-lived secret handed to the client, and an id an
    // attacker can guess the neighbourhood of is a worse starting point than
    // one they cannot.
    const challengeId = randomUUID();
    const expiresAt = new Date(Date.now() + this.policy.challengeMinutes * 60_000);

    await tx.query(
      `INSERT INTO auth_challenge (id, tenant_id, user_id, method, expires_at)
       VALUES ($1, $2, $3, 'totp', $4)`,
      [challengeId, tx.tenantId, userId, expiresAt],
    );

    return this.describeChallenge(
      tx,
      userId,
      { tenantId: tx.tenantId, challengeId },
      expiresAt,
    );
  }

  private async describeChallenge(
    tx: AuthTx,
    userId: string,
    reference: ChallengeReference,
    expiresAt: Date,
  ): Promise<MfaChallengeResponse> {
    const enrolled = await tx.query<{ type: string }>(
      `SELECT type
         FROM user_mfa_factor
        WHERE tenant_id = $1 AND user_id = $2 AND confirmed_at IS NOT NULL`,
      [tx.tenantId, userId],
    );
    const hasTotp = enrolled.some((factor) => factor.type === 'totp');

    return {
      mfaRequired: true,
      challengeId: formatChallengeId(reference),
      method: 'totp',
      methods: [
        { type: 'totp', available: hasTotp, deliveryHint: null },
        // Specified in the contract so the screen can render the fallbacks it
        // is designed with; unavailable until a channel provider exists.
        { type: 'sms', available: false, deliveryHint: null },
        { type: 'backup_code', available: false, deliveryHint: null },
      ],
      enrolmentRequired: !hasTotp,
      expiresAt: expiresAt.toISOString(),
      resendAvailableAt: null,
    };
  }

  private async findOpenChallenge(
    tx: AuthTx,
    challengeId: string,
  ): Promise<{ userId: string; attemptCount: number; expiresAt: Date } | AuthError> {
    const rows = await tx.query<{
      user_id: string;
      attempt_count: number;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT user_id, attempt_count, expires_at, consumed_at
         FROM auth_challenge
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, challengeId],
    );

    const row = rows[0];
    if (row === undefined || row.consumed_at !== null) {
      return mfaChallengeInvalid();
    }
    if (row.expires_at.getTime() <= Date.now()) {
      // A distinct code, because holding the challenge id already proves the
      // password was right — telling this caller that their code timed out
      // reveals nothing they did not already know, and `P01/2b` needs it to
      // offer "Send a new code".
      return mfaChallengeExpired();
    }
    return { userId: row.user_id, attemptCount: row.attempt_count, expiresAt: row.expires_at };
  }

  private async issueSession(tx: AuthTx, userId: string): Promise<SessionResponse | AuthError> {
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + this.policy.sessionHours * 3_600_000);

    await tx.query(
      `INSERT INTO auth_session (id, tenant_id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tx.tenantId, userId, hashSessionToken(token), expiresAt],
    );

    const rows = await tx.query<{ email: string; display_name: string; locale: string }>(
      `SELECT email, display_name, locale FROM "user" WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, userId],
    );
    const user = rows[0];
    if (user === undefined) {
      // Cannot happen: the challenge's foreign key guarantees the user. If it
      // ever does, refuse rather than issue a session for nobody.
      return mfaChallengeInvalid();
    }

    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresAt: expiresAt.toISOString(),
      user: {
        id: userId,
        tenantId: tx.tenantId,
        email: user.email,
        displayName: user.display_name,
        locale: user.locale,
      },
    };
  }
}
