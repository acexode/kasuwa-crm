import { Body, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put } from '@nestjs/common';
import {
  createDisposition,
  dispositionExists,
  deleteDispositionWithPrevious,
  DuplicateDispositionCodeError,
  findProgrammeById,
  IncompleteDispositionOrderError,
  listDispositions,
  reorderDispositionsWithPrevious,
  updateDispositionWithPrevious,
} from '@kasuwa/domain-core';
import { currentTx } from '../../tenancy/tenant-context';
import { AdminController } from '../common/admin-controller.decorator';
import { notFound } from '../common/admin-errors';
import { foundOr404, parseIdOr404, parseOr400 } from '../common/admin-input';
import { requireProgrammePermission } from '../common/admin-permissions';
import {
  auditDispositionCreated,
  auditDispositionDeleted,
  auditDispositionsReordered,
  auditDispositionUpdated,
} from './dispositions.audit';
import { duplicateCode, incompleteOrder } from './dispositions.errors';
import {
  toDispositionListResponse,
  toDispositionResponse,
  type DispositionListResponse,
  type DispositionResponse,
} from './dispositions.presenter';
import {
  DispositionOrderBody,
  DispositionParams,
  DispositionPatchBody,
  DispositionWriteBody,
  ProgrammeIdParam,
} from './dispositions.schemas';

/**
 * The dispositions admin API — T-0027, screen P02/B5.
 *
 * Contract: docs/api/admin.openapi.yaml, tag `programmes`, operations
 * `listDispositions`, `createDisposition`, `reorderDispositions`,
 * `updateDisposition` and `deleteDisposition`. Semantics the spec leaves open
 * are D-L47's: delete is soft, a deleted disposition is absent from the list
 * and from the list a reorder must name, its code stays reserved, a reorder
 * naming a foreign or unknown id is `400 validation_failed`, and a new
 * disposition is appended last. (No `@nestjs/swagger` in the workspace; the
 * YAML is the published contract and the acceptance suite holds this to it.)
 *
 * Scope: `{programmeId}` and `{dispositionId}` are record identifiers. Neither
 * is scope; scope is `tx.session.programmeIds`, from `user_programme`. An
 * unassigned sibling programme, another tenant's, nothing at all, a malformed
 * id, and a disposition id that belongs to a different programme from the one
 * in the path are all the one `404 not_found` body. The programme is resolved
 * BEFORE the body is judged, so an unreachable programme is 404 whatever was
 * sent.
 *
 * Permissions (T-0032, D-L53): every write needs the `admin` set in the
 * programme or a tenant admin; other sets are read-only. Order: 404 (the
 * programme, and for update and delete the disposition too), then 403
 * `not_permitted`, then 400.
 *
 * Audited (T-0033): every successful write records its event in the write's
 * transaction (`dispositions.audit.ts`); a refusal records nothing.
 *
 * Not built: `usageCount90d`, which is null until an interactions table
 * exists.
 */
@AdminController('api/v1/admin/programmes/:programmeId/dispositions')
export class DispositionsController {
  /** `GET …/dispositions` — operationId `listDispositions`. 200 · 401 · 404. */
  @Get()
  async list(@Param() params: unknown): Promise<DispositionListResponse> {
    const { programmeId } = parseIdOr404(ProgrammeIdParam, params);
    return toDispositionListResponse(foundOr404(await listDispositions(currentTx(), programmeId)));
  }

  /** `POST …/dispositions` — operationId `createDisposition`. 201 · 400 · 401 · 403 · 404 · 409. */
  @Post()
  async create(@Param() params: unknown, @Body() body: unknown): Promise<DispositionResponse> {
    const { programmeId } = parseIdOr404(ProgrammeIdParam, params);
    await requireProgramme(programmeId);
    await requireProgrammePermission(currentTx(), 'disposition.write', programmeId);
    const parsed = parseOr400(DispositionWriteBody, body);
    try {
      const tx = currentTx();
      const created = foundOr404(await createDisposition(tx, programmeId, parsed));
      await auditDispositionCreated(tx, programmeId, created);
      return toDispositionResponse(created);
    } catch (error) {
      if (error instanceof DuplicateDispositionCodeError) {
        throw duplicateCode();
      }
      throw error;
    }
  }

  /** `PUT …/dispositions/order` — operationId `reorderDispositions`. 200 · 400 · 401 · 403 · 404. */
  @Put('order')
  async reorder(@Param() params: unknown, @Body() body: unknown): Promise<DispositionListResponse> {
    const { programmeId } = parseIdOr404(ProgrammeIdParam, params);
    await requireProgramme(programmeId);
    await requireProgrammePermission(currentTx(), 'disposition.write', programmeId);
    const parsed = parseOr400(DispositionOrderBody, body);
    try {
      const tx = currentTx();
      const applied = foundOr404(
        await reorderDispositionsWithPrevious(tx, programmeId, parsed.dispositionIds),
      );
      await auditDispositionsReordered(tx, programmeId, applied.previous, applied.updated);
      return toDispositionListResponse(applied.updated);
    } catch (error) {
      if (error instanceof IncompleteDispositionOrderError) {
        throw incompleteOrder();
      }
      throw error;
    }
  }

  /** `PATCH …/dispositions/{dispositionId}` — operationId `updateDisposition`. 200 · 400 · 401 · 403 · 404. */
  @Patch(':dispositionId')
  async update(@Param() params: unknown, @Body() body: unknown): Promise<DispositionResponse> {
    const ids = parseIdOr404(DispositionParams, params);
    await requireDisposition(ids.programmeId, ids.dispositionId, { includeDeleted: false });
    await requireProgrammePermission(currentTx(), 'disposition.write', ids.programmeId);
    const parsed = parseOr400(DispositionPatchBody, body);
    const tx = currentTx();
    const applied = foundOr404(
      await updateDispositionWithPrevious(tx, ids.programmeId, ids.dispositionId, parsed),
    );
    await auditDispositionUpdated(tx, ids.programmeId, applied.previous, applied.updated);
    return toDispositionResponse(applied.updated);
  }

  /**
   * `DELETE …/dispositions/{dispositionId}` — operationId `deleteDisposition`.
   * 204 · 401 · 403 · 404. Soft (D-L47) and idempotent: an already-deleted
   * disposition of this programme is 204 again.
   */
  @Delete(':dispositionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param() params: unknown): Promise<void> {
    const ids = parseIdOr404(DispositionParams, params);
    await requireDisposition(ids.programmeId, ids.dispositionId, { includeDeleted: true });
    await requireProgrammePermission(currentTx(), 'disposition.write', ids.programmeId);
    const tx = currentTx();
    const applied = foundOr404(
      await deleteDispositionWithPrevious(tx, ids.programmeId, ids.dispositionId),
    );
    await auditDispositionDeleted(tx, ids.programmeId, applied.previous);
  }
}

/** The one 404 for an unreachable programme, before any body is looked at. */
async function requireProgramme(programmeId: string): Promise<void> {
  foundOr404(await findProgrammeById(currentTx(), programmeId));
}

/**
 * The one 404 for an unreachable programme OR a disposition that is not this
 * programme's - decided before the permission check, so a 403 never confirms
 * that a guessed disposition id exists.
 */
async function requireDisposition(
  programmeId: string,
  dispositionId: string,
  options: { includeDeleted: boolean },
): Promise<void> {
  if (!(await dispositionExists(currentTx(), programmeId, dispositionId, options))) {
    throw notFound();
  }
}
