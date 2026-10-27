import { Module } from '@nestjs/common';
import {
  CataloguePriceBookController,
  CatalogueProductController,
  CatalogueProgrammeController,
} from './catalogue.controller';

@Module({
  controllers: [CatalogueProgrammeController, CatalogueProductController, CataloguePriceBookController],
})
export class CommerceModule {}
