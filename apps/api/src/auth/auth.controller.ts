import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { currentTx } from '../tenancy/tenant-context';
import { KasuwaAuthGuard, readBearerToken } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { AUTH_CONTEXT_KEY } from '../tenancy/stub-auth.guard';
import { type AuthError, notAuthenticated, notImplemented } from './auth.errors';
import { AuthService } from './auth.service';
import { CommitThenFailInterceptor } from './commit-then-fail.interceptor';
import { MfaService } from './mfa.service';
import { SignInThrottleGuard } from './sign-in-throttle.guard';
import {
  MfaChallengeBody,
  MfaEnrolBody,
  MfaEnrolConfirmBody,
  MfaVerifyBody,
  SignInBody,
  SsoLookupBody,
  StepUpBody,
  TotpConfirmBody,
  type BackupCodesIssued,
  type CurrentUserResponse,
  type MfaChallengeResponse,
  type MfaStatusResponse,
  type SessionResponse,
  type SessionWithBackupCodes,
  type TotpEnrolmentStarted,
} from './auth.schemas';

/**
 * The session id behind this request, or the uninformative 401.
 *
 * The MFA routes refuse the `x-kasuwa-*` stub identity (ADR-0007) even where
 * stub mode is on: changing a credential is the one thing a forged identity
 * header should never be able to reach, and the isolation suite has no need
 * for it. A real, server-issued session is required.
 */
function requireRealSession(request: Request): string {
  const sessionId = request[AUTH_CONTEXT_KEY]?.sessionId ?? null;
  if (sessionId === null) {
    throw notAuthenticated();
  }
  return sessionId;
}

/**
 * The authentication API. Contract: docs/api/auth.openapi.yaml, which is
 * published ahead of this file because T-0007 builds against it in parallel.
 *
 * Note which routes carry the guard and the interceptor and which do not.
 * Sign-in, the MFA endpoints, SSO lookup and sign-out run OUTSIDE a tenant
 * transaction, because establishing who the caller is has to happen before
 * there is anyone to open one for. They reach the database only through
 * `withAuthTransaction`, which pins a tenant and an empty programme scope —
 * see the comment there. `/me` is an ordinary authenticated route and carries
 * both decorators like any other.
 *
 * The 501 routes are in the published contract and deliberately not built:
 * sign-up provisions a tenant, and OTP delivery needs a channel provider. Both
 * are decisions T-0001 does not own. They answer rather than 404 so that a
 * screen built against the contract gets a clear, documented refusal.
 */
@Controller('api/v1/auth')
export class AuthController {
  /*
   * `@Inject` is explicit rather than relying on the parameter type, because
   * the test runner transforms TypeScript with esbuild, which does not emit
   * `emitDecoratorMetadata`. Without a named token the dependency resolves to
   * undefined and every route 500s. Every other provider in this app is wired
   * the same way, for the same reason.
   */
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(MfaService) private readonly mfa: MfaService,
  ) {}

  /**
   * POST /api/v1/auth/sign-in — first factor.
   *
   * 200 with a challenge, or 401 `invalid_credentials`, or 429
   * `account_locked`. The 200 body carries nothing usable on its own.
   */
  /*
   * The throttle is ONLY on this route, and that is deliberate.
   *
   * It exists for one cost: argon2id, ~19 MiB and ~86 ms per call, run even for
   * addresses and workspaces that do not exist because equalising the timing
   * means doing the work either way. `/auth/mfa` and `/auth/mfa/challenge` do
   * no hashing — they are a primary-key read and a small write — so putting
   * them on the same per-minute budget spent the allowance meant for the
   * expensive route on cheap ones, and throttled a legitimate second factor
   * because somebody had been typing passwords.
   *
   * Guessing at the second factor is bounded by the per-user MFA lockout and
   * the open-challenge cap, both of which are in the database and count the
   * user rather than the connection.
   */
  @Post('sign-in')
  @UseGuards(SignInThrottleGuard)
  @HttpCode(HttpStatus.OK)
  async signIn(@Body() body: unknown): Promise<MfaChallengeResponse> {
    return this.auth.signIn(SignInBody.parse(body));
  }

  /** POST /api/v1/auth/mfa/challenge — re-issue or switch the second factor. */
  @Post('mfa/challenge')
  @HttpCode(HttpStatus.OK)
  async challenge(@Body() body: unknown): Promise<MfaChallengeResponse> {
    return this.auth.reissueChallenge(MfaChallengeBody.parse(body));
  }

  /** POST /api/v1/auth/mfa — second factor. The only route that issues a token. */
  @Post('mfa')
  @HttpCode(HttpStatus.OK)
  async verify(@Body() body: unknown): Promise<SessionResponse> {
    return this.auth.verifyMfa(MfaVerifyBody.parse(body));
  }

  /**
   * POST /api/v1/auth/mfa/enrol — start enrolment, bound to a sign-in
   * challenge, for a user with NO confirmed factor. 403 `mfa_already_enrolled`
   * for anybody else: a password cannot replace a factor.
   *
   * The response carries the TOTP secret, once. `no-store` keeps it out of
   * every cache between here and the screen.
   */
  @Post('mfa/enrol')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async enrol(@Body() body: unknown): Promise<TotpEnrolmentStarted> {
    return this.auth.startEnrolment(MfaEnrolBody.parse(body));
  }

  /**
   * POST /api/v1/auth/mfa/enrol/confirm — confirm the pending factor with a
   * code from it. Issues the session and the backup codes, the only time the
   * codes exist in plaintext.
   */
  @Post('mfa/enrol/confirm')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async confirmEnrolment(@Body() body: unknown): Promise<SessionWithBackupCodes> {
    return this.auth.confirmEnrolment(MfaEnrolConfirmBody.parse(body));
  }

  /*
   * The signed-in user's own factor. Guard and tenant transaction exactly like
   * GET /me, plus CommitThenFailInterceptor OUTSIDE the transaction so a wrong
   * step-up code is counted even though the request fails (see that class).
   * Every write needs the current second factor again; a session is not enough.
   */

  /** GET /api/v1/auth/me/mfa — whether a factor is confirmed and how many codes remain. */
  @Get('me/mfa')
  @UseGuards(KasuwaAuthGuard)
  @UseInterceptors(TenantTransactionInterceptor)
  @Header('Cache-Control', 'no-store')
  async myMfa(@Req() request: Request): Promise<MfaStatusResponse> {
    requireRealSession(request);
    return this.mfa.status(currentTx());
  }

  /** POST /api/v1/auth/me/mfa/totp — start replacing the factor (step-up). */
  @Post('me/mfa/totp')
  @HttpCode(HttpStatus.OK)
  @UseGuards(KasuwaAuthGuard)
  @UseInterceptors(CommitThenFailInterceptor, TenantTransactionInterceptor)
  @Header('Cache-Control', 'no-store')
  async startTotpReplacement(
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<TotpEnrolmentStarted | AuthError> {
    requireRealSession(request);
    return this.mfa.startReplacement(currentTx(), StepUpBody.parse(body));
  }

  /** POST /api/v1/auth/me/mfa/totp/confirm — the new secret replaces the old. */
  @Post('me/mfa/totp/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(KasuwaAuthGuard)
  @UseInterceptors(CommitThenFailInterceptor, TenantTransactionInterceptor)
  @Header('Cache-Control', 'no-store')
  async confirmTotpReplacement(
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<MfaStatusResponse | AuthError> {
    const sessionId = requireRealSession(request);
    return this.mfa.confirmReplacement(currentTx(), sessionId, TotpConfirmBody.parse(body));
  }

  /** POST /api/v1/auth/me/mfa/backup-codes — regenerate (step-up); the old set dies. */
  @Post('me/mfa/backup-codes')
  @HttpCode(HttpStatus.OK)
  @UseGuards(KasuwaAuthGuard)
  @UseInterceptors(CommitThenFailInterceptor, TenantTransactionInterceptor)
  @Header('Cache-Control', 'no-store')
  async regenerateBackupCodes(
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<BackupCodesIssued | AuthError> {
    requireRealSession(request);
    return this.mfa.regenerateBackupCodes(currentTx(), StepUpBody.parse(body));
  }

  /** POST /api/v1/auth/sign-out — revoke. Idempotent, and 204 either way. */
  @Post('sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  async signOut(@Req() request: Request): Promise<void> {
    await this.auth.signOut(readBearerToken(request));
  }

  /** POST /api/v1/auth/sso/lookup — which IdP serves an email domain. */
  @Post('sso/lookup')
  @HttpCode(HttpStatus.OK)
  async ssoLookup(@Body() body: unknown): Promise<never> {
    return this.auth.lookupSso(SsoLookupBody.parse(body));
  }

  /** POST /api/v1/auth/sign-up — published, not built. See the class comment. */
  @Post('sign-up')
  signUp(): never {
    throw notImplemented();
  }

  /** POST /api/v1/auth/verify-otp — published, not built. */
  @Post('verify-otp')
  verifyOtp(): never {
    throw notImplemented();
  }

  /** POST /api/v1/auth/verify-otp/resend — published, not built. */
  @Post('verify-otp/resend')
  resendOtp(): never {
    throw notImplemented();
  }

  /**
   * GET /api/v1/auth/me — the current user.
   *
   * Identity only: no programme ids, no roles, no permissions. The read runs
   * inside the tenant transaction and under RLS, so a user who has just been
   * disabled, or whose session has just been revoked, fails here rather than
   * being served from anything the guard cached.
   */
  @Get('me')
  @UseGuards(KasuwaAuthGuard)
  @UseInterceptors(TenantTransactionInterceptor)
  async me(): Promise<CurrentUserResponse> {
    const tx = currentTx();
    const rows = await tx.query<{
      id: string;
      tenant_id: string;
      email: string;
      display_name: string;
      locale: string;
      // RLS already confines this to the caller's tenant. The explicit
      // tenant_id predicate is the second, independent layer every other query
      // in this change carries, and both security reviews called out its
      // absence here: one typo in a policy should not be enough.
    }>(
      `SELECT id, tenant_id, email, display_name, locale
         FROM "user"
        WHERE id = $1 AND tenant_id = $2`,
      [tx.session.userId, tx.session.tenantId],
    );

    const user = rows[0];
    if (user === undefined) {
      // RLS has already confined this to the caller's own tenant, so "no row"
      // means the user is gone. Same uninformative 401 as everything else.
      throw notAuthenticated();
    }

    return {
      id: user.id,
      tenantId: user.tenant_id,
      email: user.email,
      displayName: user.display_name,
      locale: user.locale,
    };
  }
}
