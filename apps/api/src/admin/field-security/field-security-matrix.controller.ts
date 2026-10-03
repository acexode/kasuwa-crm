import { Body, Get, Put, Query } from '@nestjs/common';
import {
  readFieldSecurityMatrix,
  writeFieldSecurityMatrix,
  type FieldSecurityMatrix,
} from '@kasuwa/metadata-engine';
import { currentTx } from '../../tenancy/tenant-context';
import { change, recordAuditEvent } from '../audit/audit-writer';
import { AdminController } from '../common/admin-controller.decorator';
import { notFound, notPermitted, staleWrite } from '../common/admin-errors';
import { parseOr400 } from '../common/admin-input';
import {
  FieldSecurityMatrixQuery,
  FieldSecurityWriteBody,
  toFieldSecurityMatrixResponse,
} from './field-security-matrix.schemas';

/**
 * The field-security matrix, admin console screens P02/D, D1 and D2 (T-0026).
 *
 * OpenAPI: docs/api/admin.openapi.yaml, `getFieldSecurityMatrix` and
 * `updateFieldSecurityMatrix`. Semantics: D-P9 and D-L45.
 *
 * Tenant-level, with no programme axis (D-P9): every user of the tenant reads
 * one matrix, and a `programmeId` in the query or the body is a 400, because
 * supplying scope is refused rather than ignored (CLAUDE.md 2.2). Scope is the
 * session's, via `currentTx()`.
 *
 * Another tenant's object, field or permission set is `404 not_found` with the
 * same body as one that does not exist. The padlocked column is `403
 * not_permitted` - enforced here, whatever the screen's disabled button does.
 * A write is all-or-nothing; the tenant transaction rolls back on any throw,
 * and nothing is written until every change has been checked anyway.
 *
 * Declared with `@AdminController` (D-L39): guard, tenant transaction and the
 * shared admin error envelope (400, 403, 404, 409, each with a `code`).
 *
 * KNOWN GAPS, named rather than buried (D-L36):
 *   - No `403` for "you may not administer field security": there is no
 *     permissions engine to ask, so any authenticated user of the tenant can
 *     read and write the matrix this round (same gap as roles, D-L40).
 *   - (Closed by T-0025.) `updateFieldSecurityMatrix` writes one audit
 *     event per changed cell (D-L52), never one "bulk edit" row.
 *   - The matrix is stored and served; nothing enforces it on record reads yet.
 */
@AdminController('api/v1/admin/field-security/matrix')
export class FieldSecurityMatrixController {
  /**
   * operationId: getFieldSecurityMatrix
   * GET /api/v1/admin/field-security/matrix?object=&q=&sensitiveOnly=
   * 200: FieldSecurityMatrix. 400 validation_failed (missing or over-long
   * `object`, any unspecified parameter such as `programmeId`). 401
   * not_authenticated. 404 not_found (no such object for this tenant).
   */
  @Get()
  async get(@Query() query: unknown): Promise<FieldSecurityMatrix> {
    const { object, q, sensitiveOnly } = parseOr400(FieldSecurityMatrixQuery, query);
    const matrix = await readFieldSecurityMatrix(currentTx(), object, { q, sensitiveOnly });
    if (matrix === null) throw notFound();
    return toFieldSecurityMatrixResponse(matrix);
  }

  /**
   * operationId: updateFieldSecurityMatrix
   * PUT /api/v1/admin/field-security/matrix
   * 200: FieldSecurityMatrix (the whole, unfiltered matrix, with its new
   * version). 400 validation_failed. 401 not_authenticated. 403 not_permitted
   * (a change to a locked permission set). 404 not_found (unknown object,
   * field or set). 409 stale_write.
   */
  @Put()
  async update(@Body() body: unknown): Promise<FieldSecurityMatrix> {
    const write = parseOr400(FieldSecurityWriteBody, body);
    const tx = currentTx();
    const result = await writeFieldSecurityMatrix(tx, write);
    switch (result.kind) {
      case 'not_found':
        throw notFound();
      case 'locked':
        throw notPermitted();
      case 'stale':
        throw staleWrite();
      case 'saved':
        // One event per cell whose level actually moved (D-L52). No programme:
        // the matrix is tenant-level (D-P9). The changes carry the field's API
        // name, the permission set's key and the two levels - configuration
        // only, never a record value.
        for (const cell of result.writes) {
          if (cell.before === cell.after) continue;
          await recordAuditEvent(tx, {
            action: 'updated',
            objectType: 'field_security',
            objectId: cell.fieldId,
            objectLabel: cell.fieldApiName,
            programmeId: null,
            changes: [
              change('fieldApiName', null, cell.fieldApiName),
              change('permissionSetId', null, cell.permissionSetKey),
              change('level', cell.before, cell.after),
            ],
          });
        }
        return toFieldSecurityMatrixResponse(result.matrix);
    }
  }
}
