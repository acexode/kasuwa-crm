import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AdminErrorFilter } from '../../admin/common/admin-errors';
import { PortalAuthGuard } from './portal-auth.guard';
import { PortalEnabledGuard } from './portal-enabled.guard';
import { PortalReadsService } from './portal-reads.service';
import { PortalTransactionInterceptor } from './portal-transaction.interceptor';

/** Contract: docs/api/portal.openapi.yaml (T-0181, D-P26). */
@Controller('api/v1/portal')
@UseGuards(PortalEnabledGuard, PortalAuthGuard)
@UseInterceptors(PortalTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class PortalReadsController {
  constructor(@Inject(PortalReadsService) private readonly reads: PortalReadsService) {}

  @Get('programmes')
  @Header('Cache-Control', 'no-store')
  listProgrammes(): Promise<{ data: { id: string; name: string }[] }> {
    return this.reads.listProgrammes();
  }

  @Get('contacts')
  @Header('Cache-Control', 'no-store')
  listContacts(): Promise<{ data: { id: string; programmeId: string; displayName: string }[] }> {
    return this.reads.listContacts();
  }

  @Get('contacts/:id')
  @Header('Cache-Control', 'no-store')
  getContact(@Param('id') id: string): Promise<{ id: string; programmeId: string; displayName: string }> {
    return this.reads.getContact(id);
  }

  @Get('reports/:reportId')
  @Header('Cache-Control', 'no-store')
  getReport(@Param('reportId') reportId: string) {
    return this.reads.getReport(reportId);
  }
}
