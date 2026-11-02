import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Pool } from 'pg';
import type { Request } from 'express';
import { AdminErrorFilter } from '../admin/common/admin-errors';
import { PG_POOL } from '../database/database.module';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { currentTx } from '../tenancy/tenant-context';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { createPaymentLinkFor, getPaymentLinkFor, receivePaymentWebhook } from './payments.service';

@Controller('api/v1/programmes/:programmeId/quotes/:quoteId')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class PaymentLinksController {
  /** operationId createPaymentLink */
  @Post('payment-links')
  @HttpCode(HttpStatus.CREATED)
  async create(@Param() params: unknown, @Body() body: unknown) {
    return createPaymentLinkFor(currentTx(), params, body);
  }
}

@Controller('api/v1/payment-links')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class PaymentLinkController {
  /** operationId getPaymentLink */
  @Get(':linkId')
  async get(@Param() params: unknown) {
    return getPaymentLinkFor(currentTx(), params);
  }
}

/**
 * Public provider callback. No session: the slug resolves the tenant, the
 * signature proves the body, and the link's creator supplies the later
 * programme-scoped transaction. Same 401 for unknown slug, bad signature
 * and unknown link (T-0169).
 */
@Controller('webhooks')
@UseFilters(AdminErrorFilter)
export class PaymentWebhookController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** operationId receivePaymentWebhook */
  @Post(':provider/:tenantSlug')
  @HttpCode(HttpStatus.OK)
  async receive(@Param() params: unknown, @Req() request: Request & { rawBody?: Buffer }) {
    return receivePaymentWebhook(this.pool, params, request.rawBody, request.headers);
  }
}
