import {
  Body,
  Controller,
  Delete,
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
import {
  createDisposition,
  deleteDisposition,
  DuplicateDispositionCodeError,
  findProgrammeById,
  IncompleteDispositionOrderError,
  listDispositions,
  reorderDispositions,
  updateDisposition,
} from '@kasuwa/domain-core';
import type { z } from 'zod';
import { KasuwaAuthGuard } from '../../tenancy/kasuwa-auth.guard';
import { currentTx } from '../../tenancy/tenant-context';
import { TenantTransactionInterceptor } from '../../tenancy/tenant-transaction.interceptor';
import { AdminErrorFilter } from '../roles/admin-errors';
import { duplicateCode, incompleteOrder, notFound, parseBody } from './dispositions.errors';
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
 * Not built, and said so in the completion report: `403 not_permitted` (no
 * permissions engine — any member of a programme may edit its dispositions),
 * the audit rows `x-kasuwa-audited` requires (the audit writer is T-0025),
 * and `usageCount90d`, which is null until an interactions table exists.
 */
@Controller('api/v1/admin/programmes/:programmeId/dispositions')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class DispositionsController {
  /** `GET …/dispositions` — operationId `listDispositions`. 200 · 401 · 404. */
  @Get()
  async list(@Param() params: unknown): Promise<DispositionListResponse> {
    const programmeId = parseIds(ProgrammeIdParam, params).programmeId;
    const items = await listDispositions(currentTx(), programmeId);
    if (items === null) {
      throw notFound();
    }
    return toDispositionListResponse(items);
  }

  /** `POST …/dispositions` — operationId `createDisposition`. 201 · 400 · 401 · 404 · 409. */
  @Post()
  async create(@Param() params: unknown, @Body() body: unknown): Promise<DispositionResponse> {
    const programmeId = parseIds(ProgrammeIdParam, params).programmeId;
    await requireProgramme(programmeId);
    const parsed = parseBody(DispositionWriteBody, body);
    try {
      const created = await createDisposition(currentTx(), programmeId, parsed);
      if (created === null) {
        throw notFound();
      }
      return toDispositionResponse(created);
    } catch (error) {
      if (error instanceof DuplicateDispositionCodeError) {
        throw duplicateCode();
      }
      throw error;
    }
  }

  /**
   * `PUT …/dispositions/order` — operationId `reorderDispositions`.
   * 200 · 400 · 401 · 404. Declared before `:dispositionId` routes; it is a
   * PUT and they are PATCH/DELETE, so the paths cannot collide anyway.
   */
  @Put('order')
  async reorder(@Param() params: unknown, @Body() body: unknown): Promise<DispositionListResponse> {
    const programmeId = parseIds(ProgrammeIdParam, params).programmeId;
    await requireProgramme(programmeId);
    const parsed = parseBody(DispositionOrderBody, body);
    try {
      const items = await reorderDispositions(currentTx(), programmeId, parsed.dispositionIds);
      if (items === null) {
        throw notFound();
      }
      return toDispositionListResponse(items);
    } catch (error) {
      if (error instanceof IncompleteDispositionOrderError) {
        throw incompleteOrder();
      }
      throw error;
    }
  }

  /** `PATCH …/dispositions/{dispositionId}` — operationId `updateDisposition`. 200 · 400 · 401 · 404. */
  @Patch(':dispositionId')
  async update(@Param() params: unknown, @Body() body: unknown): Promise<DispositionResponse> {
    const ids = parseIds(DispositionParams, params);
    await requireProgramme(ids.programmeId);
    const parsed = parseBody(DispositionPatchBody, body);
    const updated = await updateDisposition(
      currentTx(),
      ids.programmeId,
      ids.dispositionId,
      parsed,
    );
    if (updated === null) {
      throw notFound();
    }
    return toDispositionResponse(updated);
  }

  /**
   * `DELETE …/dispositions/{dispositionId}` — operationId `deleteDisposition`.
   * 204 · 401 · 404. Soft (D-L47) and idempotent: an already-deleted
   * disposition of this programme is 204 again.
   */
  @Delete(':dispositionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param() params: unknown): Promise<void> {
    const ids = parseIds(DispositionParams, params);
    const deleted = await deleteDisposition(currentTx(), ids.programmeId, ids.dispositionId);
    if (deleted === null) {
      throw notFound();
    }
  }
}

/** The one 404 for an unreachable programme, before any body is looked at. */
async function requireProgramme(programmeId: string): Promise<void> {
  if ((await findProgrammeById(currentTx(), programmeId)) === null) {
    throw notFound();
  }
}

/** A malformed id names nothing: the same 404 as an unreachable one. */
function parseIds<S extends z.ZodTypeAny>(schema: S, params: unknown): z.output<S> {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw notFound();
  }
  return result.data as z.output<S>;
}
