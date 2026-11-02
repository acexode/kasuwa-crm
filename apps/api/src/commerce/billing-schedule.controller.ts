import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
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
  createBillingScheduleForInvoice,
  generateBillingScheduleFor,
  getBillingScheduleFor,
  listBillingSchedulesFor,
  setBillingScheduleStatusFor,
} from './billing-schedule.service';

@Controller('api/v1/programmes/:programmeId')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class BillingScheduleProgrammeController {
  /** operationId listBillingSchedules */
  @Get('billing-schedules')
  @Header('Cache-Control', 'no-store')
  async list(@Param() params: unknown) {
    return listBillingSchedulesFor(currentTx(), params);
  }
}

@Controller('api/v1/invoices')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class BillingScheduleInvoiceController {
  /** operationId createBillingSchedule */
  @Post(':invoiceId/billing-schedule')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  async create(@Param() params: unknown, @Body() body: unknown) {
    return createBillingScheduleForInvoice(currentTx(), params, body);
  }
}

@Controller('api/v1/billing-schedules')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class BillingScheduleController {
  /** operationId getBillingSchedule */
  @Get(':scheduleId')
  @Header('Cache-Control', 'no-store')
  async get(@Param() params: unknown) {
    return getBillingScheduleFor(currentTx(), params);
  }

  /** operationId setBillingScheduleStatus */
  @Post(':scheduleId/status')
  @Header('Cache-Control', 'no-store')
  async setStatus(@Param() params: unknown, @Body() body: unknown) {
    return setBillingScheduleStatusFor(currentTx(), params, body);
  }

  /** operationId generateBillingInvoice */
  @Post(':scheduleId/generate')
  @Header('Cache-Control', 'no-store')
  async generate(@Param() params: unknown) {
    return generateBillingScheduleFor(currentTx(), params);
  }
}
