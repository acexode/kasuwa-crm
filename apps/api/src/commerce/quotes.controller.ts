import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
  createQuoteFor,
  getQuoteFor,
  listQuotesFor,
  setQuoteStatusFor,
  updateQuoteFor,
} from './quotes.service';

@Controller('api/v1/programmes/:programmeId')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class QuotesProgrammeController {
  /** operationId listQuotes */
  @Get('quotes')
  async listQuotes(@Param() params: unknown) {
    return listQuotesFor(currentTx(), params);
  }

  /** operationId createQuote */
  @Post('quotes')
  @HttpCode(HttpStatus.CREATED)
  async createQuote(@Param() params: unknown, @Body() body: unknown) {
    return createQuoteFor(currentTx(), params, body);
  }
}

@Controller('api/v1/quotes')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class QuotesController {
  /** operationId getQuote */
  @Get(':quoteId')
  async getQuote(@Param() params: unknown) {
    return getQuoteFor(currentTx(), params);
  }

  /** operationId updateQuote */
  @Patch(':quoteId')
  async updateQuote(@Param() params: unknown, @Body() body: unknown) {
    return updateQuoteFor(currentTx(), params, body);
  }

  /** operationId setQuoteStatus */
  @Post(':quoteId/status')
  @HttpCode(HttpStatus.OK)
  async setStatus(@Param() params: unknown, @Body() body: unknown) {
    return setQuoteStatusFor(currentTx(), params, body);
  }
}
