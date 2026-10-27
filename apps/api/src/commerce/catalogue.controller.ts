import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AdminErrorFilter } from '../admin/common/admin-errors';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { currentTx } from '../tenancy/tenant-context';
import {
  createProductFor,
  listPriceBooksFor,
  listProductsFor,
  listTaxProfilesFor,
  updateProductFor,
  upsertPriceBookEntryFor,
} from './catalogue.service';

@Controller('api/v1/programmes/:programmeId')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class CatalogueProgrammeController {
  /** operationId listProducts */
  @Get('products')
  async listProducts(@Param() params: unknown) {
    return listProductsFor(currentTx(), params);
  }

  /** operationId createProduct */
  @Post('products')
  @HttpCode(HttpStatus.CREATED)
  async createProduct(@Param() params: unknown, @Body() body: unknown) {
    return createProductFor(currentTx(), params, body);
  }

  /** operationId listPriceBooks */
  @Get('price-books')
  async listPriceBooks(@Param() params: unknown) {
    return listPriceBooksFor(currentTx(), params);
  }

  /** operationId listTaxProfiles */
  @Get('tax-profiles')
  async listTaxProfiles(@Param() params: unknown) {
    return listTaxProfilesFor(currentTx(), params);
  }
}

@Controller('api/v1/products')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class CatalogueProductController {
  /** operationId updateProduct */
  @Patch(':productId')
  async updateProduct(@Param() params: unknown, @Body() body: unknown) {
    return updateProductFor(currentTx(), params, body);
  }
}

@Controller('api/v1/price-books')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class CataloguePriceBookController {
  /** operationId upsertPriceBookEntry */
  @Put(':priceBookId/entries')
  async upsertEntry(@Param() params: unknown, @Body() body: unknown) {
    return upsertPriceBookEntryFor(currentTx(), params, body);
  }
}
