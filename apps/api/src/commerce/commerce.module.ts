import { Module } from '@nestjs/common';
import {
  ApprovalsController,
  ApprovalsProgrammeController,
  ApprovalsQuoteController,
} from './approvals.controller';
import {
  CataloguePriceBookController,
  CatalogueProductController,
  CatalogueProgrammeController,
} from './catalogue.controller';
import { QuotesController, QuotesProgrammeController } from './quotes.controller';
import {
  PaymentLinksController,
  PaymentLinksQuoteController,
} from './payment-links.controller';
import { PaymentWebhooksController } from '../webhooks/payment-webhooks.controller';
import {
  InvoicesController,
  InvoicesProgrammeController,
  InvoicesQuoteController,
} from './invoices.controller';
import { EinvoiceController } from './einvoice.controller';
import { FxDealController, FxProgrammeController } from './fx.controller';

@Module({
  controllers: [
    CatalogueProgrammeController,
    CatalogueProductController,
    CataloguePriceBookController,
    QuotesProgrammeController,
    QuotesController,
    ApprovalsProgrammeController,
    ApprovalsQuoteController,
    ApprovalsController,
    PaymentLinksQuoteController,
    PaymentLinksController,
    PaymentWebhooksController,
    InvoicesProgrammeController,
    InvoicesQuoteController,
    InvoicesController,
    EinvoiceController,
    FxProgrammeController,
    FxDealController,
  ],
})
export class CommerceModule {}
