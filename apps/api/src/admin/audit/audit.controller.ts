import { Body, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { currentTx } from '../../tenancy/tenant-context';
import { AdminController } from '../common/admin-controller.decorator';
import { parseIdOr404, parseOr400 } from '../common/admin-input';
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
 * KNOWN GAP: no `403 not_permitted`. There is no permissions engine, so any
 * authenticated user of the tenant can read the events D-L48 makes visible to
 * them and can request an export of the same.
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
   * 202 `AuditExport`; 400, 401. Itself audited, in the same transaction.
   */
  @Post('exports')
  @HttpCode(HttpStatus.ACCEPTED)
  createExport(@Body() body: unknown) {
    const parsed = parseOr400(CreateAuditExportBody, body);
    return audit.createAuditExport(currentTx(), parsed);
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
