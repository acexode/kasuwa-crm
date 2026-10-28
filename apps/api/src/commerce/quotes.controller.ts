import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  StreamableFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { ChannelProvider } from '@kasuwa/channel-adapter';
import { AdminErrorFilter } from '../admin/common/admin-errors';
import { CHANNEL } from '../messaging/channel';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { currentTx } from '../tenancy/tenant-context';
import { renderQuotePdfFor, sendQuoteFor } from './quote-send.service';
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
  constructor(@Inject(CHANNEL) private readonly channel: ChannelProvider) {}

  /** operationId renderQuotePdf */
  @Get(':quoteId/pdf')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/pdf')
  async renderPdf(@Param() params: unknown): Promise<StreamableFile> {
    const buffer = await renderQuotePdfFor(currentTx(), params);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: 'attachment; filename="quote.pdf"',
    });
  }

  /** operationId sendQuote */
  @Post(':quoteId/send')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  async send(@Param() params: unknown, @Body() body: unknown) {
    return sendQuoteFor(currentTx(), this.channel, params, body);
  }

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
