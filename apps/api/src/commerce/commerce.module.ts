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
import { PaymentLinkController, PaymentLinksController, PaymentWebhookController } from './payments.controller';
import { QuotesController, QuotesProgrammeController } from './quotes.controller';

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
    PaymentLinksController,
    PaymentLinkController,
    PaymentWebhookController,
  ],
})
export class CommerceModule {}
