import { Body, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { currentTx } from '../../tenancy/tenant-context';
import { AdminController } from '../common/admin-controller.decorator';
import { parseIdOr404, parseOr400 } from '../common/admin-input';
import { requireTenantPermission } from '../common/admin-permissions';
import { CreateAuditExportBody, ExportIdParam, ListAuditEventsQuery } from './audit.schemas';
import * as audit from './audit.service';

/**
 * The audit log — `tags: [audit]` in docs/api/admin.openapi.yaml (T-0025).
 *
 * Scope: the caller's tenant and programmes, from the session, via
 * `currentTx()`. No handler reads a tenant or programme id from the request;
 * the query and body schemas are strict, so an attempt to supply one is a 400.
 *
 * Every input is parsed BEFORE anything is written, so a refused export
 * request leaves no export row and no audit row.
 *
 * Permissions (T-0032, D-L53): requesting an export is tenant-level and needs
 * a tenant admin (403 `not_permitted`, decided before the body is parsed).
 * KNOWN GAP: reading is not restricted yet - any user of the tenant reads the
 * events D-L48 makes visible to them. Restricting audit reads to admins is a
 * separate decision (D-L48 names it), not part of this round.
 */
@AdminController('api/v1/admin/audit')
export class AuditController {
  /** `GET /api/v1/admin/audit/events` — operationId `listAuditEvents`. 200 `AuditEventList`; 400, 401. */
  @Get('events')
  list(@Query() query: unknown) {
    return audit.listAuditEvents(currentTx(), parseOr400(ListAuditEventsQuery, query));
  }

  /** `GET /api/v1/admin/audit/filter-options` — operationId `getAuditFilterOptions`. 200; 401. */
  @Get('filter-options')
  filterOptions() {
    return audit.getAuditFilterOptions(currentTx());
  }

  /**
   * `POST /api/v1/admin/audit/exports` — operationId `createAuditExport`.
   * 202 `AuditExport`; 400, 401, 403. Itself audited, in the same transaction.
   */
  @Post('exports')
  @HttpCode(HttpStatus.ACCEPTED)
  async createExport(@Body() body: unknown) {
    const tx = currentTx();
    await requireTenantPermission(tx, 'audit.export');
    const parsed = parseOr400(CreateAuditExportBody, body);
    return audit.createAuditExport(tx, parsed);
  }

  /**
   * `GET /api/v1/admin/audit/exports/{exportId}` — operationId
   * `getAuditExport`. 200 `AuditExport`; 401, 404. Another caller's export,
   * another tenant's, none at all and a malformed id are one `404` body.
   */
  @Get('exports/:exportId')
  getExport(@Param() params: unknown) {
    const { exportId } = parseIdOr404(ExportIdParam, params);
    return audit.getAuditExport(currentTx(), exportId);
  }
}
