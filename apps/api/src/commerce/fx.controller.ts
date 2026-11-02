import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AdminErrorFilter } from '../admin/common/admin-errors';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { currentTx } from '../tenancy/tenant-context';
import {
  createFxLockFor,
  createFxRateFor,
  getFxLockFor,
  getLatestFxRateFor,
  listFxRatesFor,
} from './fx.service';

@Controller('api/v1/programmes/:programmeId')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class FxProgrammeController {
  /** operationId listFxRates */
  @Get('fx-rates')
  async listRates(@Param() params: unknown) {
    return listFxRatesFor(currentTx(), params);
  }

  /** operationId getLatestFxRate */
  @Get('fx-rates/latest')
  async latest(@Param() params: unknown, @Query() query: unknown) {
    return getLatestFxRateFor(currentTx(), params, query);
  }

  /** operationId createFxRate */
  @Post('fx-rates')
  @HttpCode(HttpStatus.CREATED)
  async createRate(@Param() params: unknown, @Body() body: unknown) {
    return createFxRateFor(currentTx(), params, body);
  }
}

@Controller('api/v1/deals')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class FxDealController {
  /** operationId getFxLock */
  @Get(':dealId/fx-lock')
  async getLock(@Param() params: unknown) {
    return getFxLockFor(currentTx(), params);
  }

  /** operationId createFxLock */
  @Post(':dealId/fx-lock')
  @HttpCode(HttpStatus.CREATED)
  async createLock(@Param() params: unknown, @Body() body: unknown) {
    return createFxLockFor(currentTx(), params, body);
  }
}
