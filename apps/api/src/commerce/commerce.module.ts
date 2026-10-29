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
  ],
})
export class CommerceModule {}
