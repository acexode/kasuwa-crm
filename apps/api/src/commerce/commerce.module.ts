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
  ],
})
export class CommerceModule {}
