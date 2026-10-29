import {
  Controller,
  Get,
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
import { getEinvoiceFor, retryEinvoiceFor, submitEinvoiceFor } from './einvoice.service';

@Controller('api/v1/invoices/:invoiceId/einvoice')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class EinvoiceController {
  /** operationId getEinvoice */
  @Get()
  async get(@Param() params: unknown) {
    return getEinvoiceFor(currentTx(), params);
  }

  /** operationId submitEinvoice */
  @Post('submit')
  @HttpCode(HttpStatus.OK)
  async submit(@Param() params: unknown) {
    return submitEinvoiceFor(currentTx(), params);
  }

  /** operationId retryEinvoice */
  @Post('retry')
  @HttpCode(HttpStatus.OK)
  async retry(@Param() params: unknown) {
    return retryEinvoiceFor(currentTx(), params);
  }
}
