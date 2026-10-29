import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { SignInThrottleGuard } from '../sign-in-throttle.guard';
import { PortalAuthGuard } from './portal-auth.guard';
import { PortalEnabledGuard } from './portal-enabled.guard';
import type { PortalService } from './portal.service';
import { PortalTransactionInterceptor } from './portal-transaction.interceptor';
import { PortalSignInBody, PortalVerifyMfaBody } from './portal.schemas';
import type { PortalMeResponse, PortalSessionResponse } from './portal.schemas';

/** Contract: docs/api/portal.openapi.yaml (T-0179, ADR-0021). */
@Controller('api/v1/portal')
@UseGuards(PortalEnabledGuard)
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SignInThrottleGuard)
  async signIn(@Body() body: unknown): Promise<PortalSessionResponse> {
    return this.portal.signIn(PortalSignInBody.parse(body));
  }

  @Post('mfa')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SignInThrottleGuard)
  verifyMfa(@Body() body: unknown): PortalSessionResponse {
    return this.portal.verifyMfa(PortalVerifyMfaBody.parse(body));
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PortalAuthGuard)
  @UseInterceptors(PortalTransactionInterceptor)
  me(): Promise<PortalMeResponse> {
    return this.portal.me();
  }
}
