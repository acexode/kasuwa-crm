import {
  Body,
  Controller,
  Get,
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
import { notAuthenticated, notImplemented } from './auth.errors';
import { AuthService } from './auth.service';
import { SignInThrottleGuard } from './sign-in-throttle.guard';
import {
  MfaChallengeBody,
  MfaVerifyBody,
  SignInBody,
  SsoLookupBody,
  type CurrentUserResponse,
  type MfaChallengeResponse,
  type SessionResponse,
} from './auth.schemas';

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
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /**
   * POST /api/v1/auth/sign-in — first factor.
   *
   * 200 with a challenge, or 401 `invalid_credentials`, or 429
   * `account_locked`. The 200 body carries nothing usable on its own.
   */
  @Post('sign-in')
  @UseGuards(SignInThrottleGuard)
  @HttpCode(HttpStatus.OK)
  async signIn(@Body() body: unknown): Promise<MfaChallengeResponse> {
    return this.auth.signIn(SignInBody.parse(body));
  }

  /** POST /api/v1/auth/mfa/challenge — re-issue or switch the second factor. */
  @Post('mfa/challenge')
  @UseGuards(SignInThrottleGuard)
  @HttpCode(HttpStatus.OK)
  async challenge(@Body() body: unknown): Promise<MfaChallengeResponse> {
    return this.auth.reissueChallenge(MfaChallengeBody.parse(body));
  }

  /** POST /api/v1/auth/mfa — second factor. The only route that issues a token. */
  @Post('mfa')
  @UseGuards(SignInThrottleGuard)
  @HttpCode(HttpStatus.OK)
  async verify(@Body() body: unknown): Promise<SessionResponse> {
    return this.auth.verifyMfa(MfaVerifyBody.parse(body));
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
