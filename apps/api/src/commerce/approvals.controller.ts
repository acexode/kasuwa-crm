import {
  Body,
  Controller,
  Get,
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
  decideApprovalFor,
  listApprovalsFor,
  requestApprovalFor,
} from './approvals.service';

@Controller('api/v1/programmes/:programmeId')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class ApprovalsProgrammeController {
  /** operationId listApprovals */
  @Get('approvals')
  async listApprovals(@Param() params: unknown) {
    return listApprovalsFor(currentTx(), params);
  }
}

@Controller('api/v1/quotes')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class ApprovalsQuoteController {
  /** operationId requestApproval */
  @Post(':quoteId/approvals')
  @HttpCode(HttpStatus.CREATED)
  async requestApproval(@Param() params: unknown) {
    return requestApprovalFor(currentTx(), params);
  }
}

@Controller('api/v1/approvals')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class ApprovalsController {
  /** operationId decideApproval */
  @Post(':approvalId/decision')
  @HttpCode(HttpStatus.OK)
  async decideApproval(@Param() params: unknown, @Body() body: unknown) {
    return decideApprovalFor(currentTx(), params, body);
  }
}
