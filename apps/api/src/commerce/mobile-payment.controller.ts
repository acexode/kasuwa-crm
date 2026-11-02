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
import {
  createMobilePaymentFor,
  getMobilePaymentFor,
  setMobilePaymentStatusFor,
} from './mobile-payment.service';

@Controller('api/v1/invoices')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class MobilePaymentInvoiceController {
  /** operationId createMobilePayment */
  @Post(':invoiceId/mobile-payments')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  async create(@Param() params: unknown, @Body() body: unknown) {
    return createMobilePaymentFor(currentTx(), params, body);
  }
}

@Controller('api/v1/mobile-payments')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class MobilePaymentController {
  /** operationId getMobilePayment */
  @Get(':paymentId')
  @Header('Cache-Control', 'no-store')
  async get(@Param() params: unknown) {
    return getMobilePaymentFor(currentTx(), params);
  }

  /** operationId setMobilePaymentStatus */
  @Post(':paymentId/status')
  @Header('Cache-Control', 'no-store')
  async setStatus(@Param() params: unknown, @Body() body: unknown) {
    return setMobilePaymentStatusFor(currentTx(), params, body);
  }
}
