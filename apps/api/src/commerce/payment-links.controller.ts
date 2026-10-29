import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AdminErrorFilter } from '../admin/common/admin-errors';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { currentTx } from '../tenancy/tenant-context';
import { createPaymentLinkFor, getPaymentLinkFor } from './payment-links.service';

@Controller('api/v1/quotes')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class PaymentLinksQuoteController {
  /** operationId createPaymentLink */
  @Post(':quoteId/payment-links')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  async create(@Param() params: unknown, @Body() body: unknown) {
    return createPaymentLinkFor(currentTx(), params, body);
  }
}

@Controller('api/v1/payment-links')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class PaymentLinksController {
  /** operationId getPaymentStatus */
  @Get(':paymentLinkId')
  @Header('Cache-Control', 'no-store')
  async get(@Param('paymentLinkId') paymentLinkId: string) {
    return getPaymentLinkFor(currentTx(), paymentLinkId);
  }
}
