import { Get, Param, Query } from '@nestjs/common';
import { findProgrammeById } from '@kasuwa/domain-core';
import { currentTx } from '../../tenancy/tenant-context';
import { AdminController } from '../common/admin-controller.decorator';
import { invalidCursor } from '../common/admin-errors';
import { foundOr404, parseIdOr404, parseOr400 } from '../common/admin-input';
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
 * reachable programme answers the spec's `ScriptList` with no items — the
 * design's empty state, not an error. When M10 lands its table, only the
 * body of `list` changes.
 *
 * A cursor is always a 400: this endpoint has never issued one, so any value
 * presented is not a position in this list.
 */
@AdminController('api/v1/admin/programmes/:programmeId/scripts')
export class ProgrammeScriptsController {
  @Get()
  async list(
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<ProgrammeScriptListResponse> {
    const { programmeId } = parseIdOr404(ProgrammeIdParam, params);
    foundOr404(await findProgrammeById(currentTx(), programmeId));
    const parsed = parseOr400(ListProgrammeScriptsQuery, query);
    if (parsed.cursor !== undefined) {
      throw invalidCursor();
    }
    return { items: [], page: { nextCursor: null, hasMore: false } };
  }
}
