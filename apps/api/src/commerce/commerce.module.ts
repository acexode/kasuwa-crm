import { Module } from '@nestjs/common';
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
  ],
})
export class CommerceModule {}
