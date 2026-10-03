import {
  Controller,
  Get,
  Param,
  Query,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { findProgrammeById } from '@kasuwa/domain-core';
import { KasuwaAuthGuard } from '../../tenancy/kasuwa-auth.guard';
import { currentTx } from '../../tenancy/tenant-context';
import { TenantTransactionInterceptor } from '../../tenancy/tenant-transaction.interceptor';
import { AdminErrorFilter } from '../roles/admin-errors';
import { invalidCursor, notFound, parseBody } from './dispositions.errors';
import { ListProgrammeScriptsQuery, ProgrammeIdParam } from './dispositions.schemas';

/** `ScriptList.items[]` (docs/api/admin.openapi.yaml). */
export interface ProgrammeScriptResponse {
  id: string;
  name: string;
  channels?: string[];
  languages?: string[];
  version: number;
  status: 'draft' | 'in_review' | 'published' | 'rejected_by_provider';
  providerName?: string | null;
  rejectionReason?: string | null;
  updatedAt: string;
}

export interface ProgrammeScriptListResponse {
  items: ProgrammeScriptResponse[];
  page: { nextCursor: string | null; hasMore: boolean };
}

/**
 * `GET /api/v1/admin/programmes/{programmeId}/scripts` — operationId
 * `listProgrammeScripts`, screen P02/B6. 200 · 400 · 401 · 404.
 *
 * EMPTY-BACKED, deliberately. Scripts are M10's (the script builder is a
 * screen and a model of its own) and no script table exists; inventing one
 * here would be a schema decision this task does not own. So the route is
 * real in everything but its data: the session decides scope, an unreachable
 * programme is the one 404, the query is validated to the spec, and a
 * reachable programme answers the spec's `ScriptList` with no items — which
 * the design treats as its empty state, not an error. When M10 lands its
 * table, only the body of `list` changes.
 *
 * A cursor is always a 400: this endpoint has never issued one, so any value
 * presented is not a position in this list.
 */
@Controller('api/v1/admin/programmes/:programmeId/scripts')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class ProgrammeScriptsController {
  @Get()
  async list(
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<ProgrammeScriptListResponse> {
    const parsedParams = ProgrammeIdParam.safeParse(params);
    if (!parsedParams.success) {
      throw notFound();
    }
    if ((await findProgrammeById(currentTx(), parsedParams.data.programmeId)) === null) {
      throw notFound();
    }
    const parsed = parseBody(ListProgrammeScriptsQuery, query);
    if (parsed.cursor !== undefined) {
      throw invalidCursor();
    }
    return { items: [], page: { nextCursor: null, hasMore: false } };
  }
}
