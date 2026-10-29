import {
  Body,
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
import {
  createInvoiceFromQuoteFor,
  getInvoiceFor,
  listInvoicesFor,
  setInvoiceStatusFor,
} from './invoices.service';

@Controller('api/v1/programmes/:programmeId')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class InvoicesProgrammeController {
  /** operationId listInvoices */
  @Get('invoices')
  async list(@Param() params: unknown) {
    return listInvoicesFor(currentTx(), params);
  }
}

@Controller('api/v1/quotes')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class InvoicesQuoteController {
  /** operationId createInvoiceFromQuote */
  @Post(':quoteId/invoices')
  @HttpCode(HttpStatus.CREATED)
  async createFromQuote(@Param() params: unknown) {
    return createInvoiceFromQuoteFor(currentTx(), params);
  }
}

@Controller('api/v1/invoices')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class InvoicesController {
  /** operationId getInvoice */
  @Get(':invoiceId')
  async get(@Param() params: unknown) {
    return getInvoiceFor(currentTx(), params);
  }

  /** operationId setInvoiceStatus */
  @Post(':invoiceId/status')
  @HttpCode(HttpStatus.OK)
  async setStatus(@Param() params: unknown, @Body() body: unknown) {
    return setInvoiceStatusFor(currentTx(), params, body);
  }
}
