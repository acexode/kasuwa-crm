import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthError } from '../auth.errors';
import { SignInThrottleGuard } from '../sign-in-throttle.guard';
import { PortalAuthGuard } from './portal-auth.guard';
import { PortalEnabledGuard } from './portal-enabled.guard';
import { PortalService } from './portal.service';
import { PortalTransactionInterceptor } from './portal-transaction.interceptor';
import { PortalAcceptInvitationBody, PortalSignInBody, PortalVerifyMfaBody } from './portal.schemas';
import type { PortalMeResponse, PortalMfaChallengeResponse, PortalTokenResponse } from './portal.schemas';

const PORTAL_SESSION_COOKIE = '__Host-kasuwa_portal_session';

/** Contract: docs/api/portal.openapi.yaml (T-0179, ADR-0021). */
@Controller('api/v1/portal')
@UseGuards(PortalEnabledGuard)
export class PortalController {
  constructor(@Inject(PortalService) private readonly portal: PortalService) {}

  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseGuards(SignInThrottleGuard)
  signIn(@Body() body: unknown): Promise<PortalMfaChallengeResponse> {
    return this.portal.signIn(PortalSignInBody.parse(body));
  }

  @Post('mfa')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseGuards(SignInThrottleGuard)
  async verifyMfa(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<PortalTokenResponse> {
    const session = await this.portal.verifyMfa(PortalVerifyMfaBody.parse(body));
    const maxAgeSeconds = Math.max(
      0,
      Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000),
    );
    res.append(
      'Set-Cookie',
      `${PORTAL_SESSION_COOKIE}=${session.token}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
    return session;
  }

  @Post('invitations/accept')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async acceptInvitation(
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<{ accepted: true }> {
    if (typeof req.query['token'] === 'string' && req.query['token'].length > 0) {
      throw new AuthError(
        HttpStatus.BAD_REQUEST,
        'validation_failed',
        'The invitation token must not be sent as a query parameter.',
      );
    }
    return this.portal.acceptInvitation(PortalAcceptInvitationBody.parse(body));
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PortalAuthGuard)
  @UseInterceptors(PortalTransactionInterceptor)
  me(): Promise<PortalMeResponse> {
    return this.portal.me();
  }
}
